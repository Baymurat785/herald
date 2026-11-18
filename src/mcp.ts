// Herald Protocol v0.1 — MCP binding (MCP 2026-07-28 `subscriptions/listen`).
//
// Herald is an MCP extension. The server advertises it under `capabilities.extensions`.
// The client opts in by adding the extension id to the `notifications` filter of a
// `subscriptions/listen` request. The server acknowledges, then streams
// `notifications/herald/announcement` on that subscription until it is cancelled.
// Backfill comes from the `herald://feed` resource.
//
// The MCP server is a transport, never a trust anchor. The client verifies every
// announcement against a manifest it fetched itself from the publisher's domain.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestId } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type Announcement, type Delivery, type Feed, Inbox, type Manifest } from "./herald";

// TODO: replace the vendor prefix with a reversed domain we own before publishing.
export const HERALD_EXTENSION = "dev.herald/announcements";
export const HERALD_FEED_URI = "herald://feed";
export const HERALD_NOTIFICATION = "notifications/herald/announcement";
export const HERALD_CAPABILITY = { [HERALD_EXTENSION]: { revision: "0.1" } };

const LISTEN = "subscriptions/listen";
const ACK = "notifications/subscriptions/acknowledged";
const SUB_ID = "io.modelcontextprotocol/subscriptionId";

/** Herald's entry in the `subscriptions/listen` notification filter. */
export interface HeraldFilter {
  scopes?: string[];
}

const ListenRequest = z.object({
  method: z.literal(LISTEN),
  params: z
    .object({ notifications: z.record(z.string(), z.unknown()).optional() })
    .passthrough()
    .optional(),
});

const Meta = z.object({ [SUB_ID]: z.union([z.string(), z.number()]) }).passthrough();

const AckNotification = z.object({
  method: z.literal(ACK),
  params: z.object({ _meta: Meta, notifications: z.record(z.string(), z.unknown()).optional() }).passthrough(),
});

const AnnouncementNotification = z.object({
  method: z.literal(HERALD_NOTIFICATION),
  params: z.object({ _meta: Meta, announcement: z.record(z.string(), z.unknown()) }).passthrough(),
});

const ListenResult = z.object({ resultType: z.string().optional() }).passthrough();

function audienceMatches(a: Announcement, scopes: string[] | undefined): boolean {
  const target = a.audience?.scopes;
  if (!target?.length || !scopes) return true;
  return target.some((s) => scopes.includes(s));
}

// ---------- server ----------

interface Listener {
  scopes?: string[];
  send: (a: Announcement) => Promise<void>;
  close: () => void;
}

/**
 * Attach Herald to an McpServer. Create the McpServer with
 * `{ capabilities: { extensions: HERALD_CAPABILITY } }` so clients can detect support.
 */
export function attachHeraldServer(server: McpServer, publisher: string) {
  const announcements: Announcement[] = [];
  const listeners = new Set<Listener>();

  server.registerResource(
    "herald-feed",
    HERALD_FEED_URI,
    { title: "Herald announcements", mimeType: "application/json" },
    async (uri) => {
      const feed: Feed = { herald: "0.1", publisher, announcements, next: null };
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(feed) }] };
    },
  );

  server.server.setRequestHandler(ListenRequest, async (req, extra) => {
    const _meta = { [SUB_ID]: extra.requestId };
    const done = { resultType: "complete", _meta };
    const filter = req.params?.notifications?.[HERALD_EXTENSION] as HeraldFilter | true | undefined;
    const herald = filter === true ? {} : filter;

    // Acknowledge first. Only echo the types this server honours.
    const notifications: Record<string, unknown> = {};
    if (herald) notifications[HERALD_EXTENSION] = herald;
    await extra.sendNotification({ method: ACK, params: { _meta, notifications } });

    if (!herald) return done; // nothing this server can stream for that filter

    // Hold the request open until the client cancels or the server shuts down.
    return new Promise((resolve) => {
      const listener: Listener = {
        scopes: herald.scopes,
        send: (a) =>
          extra.sendNotification({
            method: HERALD_NOTIFICATION,
            params: { _meta, announcement: a as unknown as Record<string, unknown> },
          }),
        close: () => {
          listeners.delete(listener);
          resolve(done);
        },
      };
      listeners.add(listener);
      extra.signal.addEventListener("abort", listener.close, { once: true });
    });
  });

  return {
    /** Add a signed announcement to the feed and stream it to matching subscriptions. */
    async announce(a: Announcement): Promise<void> {
      if (!a.sig) throw new Error("announce() needs a signed announcement");
      announcements.unshift(a);
      await Promise.all([...listeners].filter((l) => audienceMatches(a, l.scopes)).map((l) => l.send(a)));
    },
    /** Graceful shutdown: complete every open subscription. */
    close(): void {
      for (const l of [...listeners]) l.close();
    },
    get subscriptions(): number {
      return listeners.size;
    },
  };
}

// ---------- client ----------

export interface HeraldClientOptions {
  /** Manifests fetched from publishers' domains over HTTPS (see fetchManifest). */
  manifests: Map<string, Manifest>;
  scopes?: string[];
  onDelivery: (d: Delivery) => void | Promise<void>;
  onDropped?: (raw: unknown) => void;
}

export interface HeraldSubscription {
  inbox: Inbox;
  subscriptionId: RequestId;
  /** Resolves "closed" when the server ends the stream gracefully, "cancelled" after close(). */
  done: Promise<"closed" | "cancelled">;
  close: () => void;
}

export function supportsHerald(client: Client): boolean {
  return Boolean(client.getServerCapabilities()?.extensions?.[HERALD_EXTENSION]);
}

/**
 * Open a Herald subscription, wait for the acknowledgement, then backfill from
 * `herald://feed`. Opening the stream before the backfill means nothing published in
 * between is lost. The inbox dedupes any overlap. Call after `client.connect()`.
 */
export async function attachHeraldClient(client: Client, opts: HeraldClientOptions): Promise<HeraldSubscription> {
  if (!supportsHerald(client)) throw new Error(`server does not advertise ${HERALD_EXTENSION}`);

  const inbox = new Inbox(opts.manifests, opts.scopes);
  const handle = async (raw: unknown) => {
    const d = await inbox.receive(raw as Announcement);
    if (d) await opts.onDelivery(d);
    else opts.onDropped?.(raw);
  };

  let subscriptionId: RequestId | undefined;
  let onAck!: (id: RequestId) => void;
  const acked = new Promise<RequestId>((r) => (onAck = r));

  client.setNotificationHandler(AckNotification, (n) => {
    if (subscriptionId === undefined && n.params.notifications?.[HERALD_EXTENSION]) {
      subscriptionId = n.params._meta[SUB_ID];
      onAck(subscriptionId);
    }
  });
  client.setNotificationHandler(AnnouncementNotification, (n) => {
    if (subscriptionId !== undefined && n.params._meta[SUB_ID] === subscriptionId) return handle(n.params.announcement);
  });

  const filter: HeraldFilter = opts.scopes ? { scopes: opts.scopes } : {};
  const ctl = new AbortController();
  const done = client
    .request({ method: LISTEN, params: { notifications: { [HERALD_EXTENSION]: filter } } }, ListenResult, {
      signal: ctl.signal,
      timeout: 2 ** 31 - 1, // long-lived by design
    })
    .then(() => "closed" as const)
    .catch((e) => {
      if (ctl.signal.aborted) return "cancelled" as const;
      throw e;
    });

  const id = await Promise.race([
    acked,
    done.then(() => {
      throw new Error("subscription ended before acknowledgement");
    }),
  ]);

  const res = await client.readResource({ uri: HERALD_FEED_URI });
  const first = res.contents[0];
  const text = first && "text" in first ? first.text : undefined;
  if (text) {
    const feed = JSON.parse(text) as Feed;
    for (const a of [...feed.announcements].reverse()) await handle(a); // oldest first
  }

  return { inbox, subscriptionId: id, done, close: () => ctl.abort() };
}

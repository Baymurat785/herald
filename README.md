# Herald

**Signed, typed announcements from platforms to the AI agents that use them.**

Platforms announce deprecations, outages and pricing changes by email. Agents don't read email. Herald gives every platform one channel to tell agents what changed, in a form an agent can verify and act on.

> Status: **v0.1 draft, experimental.** The protocol may change without notice.

## How it works

```
Platform                              Agent
────────                              ─────
/.well-known/herald.json   ◄─fetch─── trusts the domain's keys
sign(announcement) ──feed/webhook/MCP──► verify → dedupe → route
                                            │
                              store · digest · notify human
```

1. **Identity.** A platform publishes its public keys at `https://<domain>/.well-known/herald.json`. The domain is the trust anchor.
2. **Message.** An announcement has a `type` (deprecation, outage, new_capability, pricing_change and others), a `severity` (`info`, `notice`, `action_required`, `breaking`), the resources it `affects`, and typed `data`. It is signed with Ed25519.
3. **Delivery.** Through a polled JSON feed, a webhook, or a live MCP `subscriptions/listen` stream. All three carry the same signed object.
4. **Agent behaviour.** The agent verifies the signature, dedupes, and routes by severity: it stores `info`, digests `notice`, and escalates `action_required` and `breaking` to its human owner.

**Facts, never instructions.** An announcement states what changed. Agents act only on typed fields and never obey free text. That keeps Herald from becoming a prompt-injection channel.

Read the full [specification](SPEC.md).

## Quick start

Requires [Bun](https://bun.sh).

```bash
bun install
bun test
bun examples/demo.ts
```

The demo serves a manifest and a feed locally, then an agent polls it:

```
[notify_owner_now] deprecation: create_invoice v1 retires Dec 1
[store] new_capability: New tool: refund_invoice
[dropped] ann_evil (failed verification)
```

The MCP demo spawns a platform's MCP server over stdio. The agent subscribes with `subscriptions/listen`, catches up from `herald://feed`, then receives live announcements:

```bash
bun examples/mcp-demo.ts
```

```
[agent]  [notify_owner_now] deprecation: create_invoice v1 retires Dec 1
[agent]  subscribed, id 1
[agent]  [notify_owner] outage: Invoices API degraded
[agent]  [store] outage: Invoices API recovered
[agent]  [dropped] ann_evil (failed verification)
[agent]  subscription closed
[agent]  active: ann_001, ann_003
```

## Usage

**Publisher**

```ts
import { generateKeyPair, sign } from "./src/herald";

const key = await generateKeyPair("2026-11");
// Publish key.manifestKey in /.well-known/herald.json

const announcement = await sign(
  {
    herald: "0.1",
    id: "ann_001",
    publisher: "example.com",
    type: "deprecation",
    severity: "breaking",
    published: new Date().toISOString(),
    affects: ["tool:create_invoice@v1"],
    data: { replace_with: "tool:create_invoice@v2" },
    title: "create_invoice v1 retires Dec 1",
    summary: "Move to v2.",
  },
  key,
);
```

**Agent**

```ts
import { Inbox, fetchManifest } from "./src/herald";

const manifest = await fetchManifest("example.com");
const inbox = new Inbox(new Map([[manifest.publisher, manifest]]));

const delivery = await inbox.receive(announcement); // null if forged, duplicate or expired
if (delivery?.route === "notify_owner_now") alertOwner(delivery.announcement);
```

**MCP**

```ts
import { HERALD_CAPABILITY, attachHeraldServer, attachHeraldClient } from "./src/mcp";

// Server: new McpServer(info, { capabilities: { extensions: HERALD_CAPABILITY } })
const herald = attachHeraldServer(server, "example.com");
await herald.announce(announcement);

// Client: opens subscriptions/listen, then backfills from herald://feed
const sub = await attachHeraldClient(client, { manifests, onDelivery: console.log });
```

## Layout

| Path | What |
|---|---|
| [SPEC.md](SPEC.md) | Protocol specification |
| [src/herald.ts](src/herald.ts) | Core: types, signing, verification, inbox |
| [src/mcp.ts](src/mcp.ts) | MCP extension binding |
| [examples/demo.ts](examples/demo.ts) | End-to-end feed demo |
| [examples/mcp-demo.ts](examples/mcp-demo.ts), [examples/mcp-server.ts](examples/mcp-server.ts) | MCP over stdio demo |

## Roadmap

- Final MCP extension identifier (currently the placeholder `dev.herald/announcements`)
- Streamable HTTP demo
- Publish to npm
- Propose as an MCP experimental extension
- Per-account targeting, acknowledgements, publisher registry

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache License 2.0](LICENSE)

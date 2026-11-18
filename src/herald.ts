// Herald Protocol v0.1 — reference implementation (publisher + agent side).

export type Severity = "info" | "notice" | "action_required" | "breaking";

export type AnnouncementType =
  | "deprecation"
  | "breaking_change"
  | "new_capability"
  | "outage"
  | "maintenance"
  | "pricing_change"
  | "credential_expiry"
  | "policy_change"
  | "general"
  | `x-${string}`;

export interface Signature {
  kid: string;
  value: string;
}

export interface Announcement {
  herald: "0.1";
  id: string;
  publisher: string;
  type: AnnouncementType;
  severity: Severity;
  published: string;
  effective?: string;
  expires?: string;
  audience?: { scopes?: string[] | null; accounts?: string[] | null } | null;
  affects?: string[];
  data: Record<string, unknown>;
  title: string;
  summary: string;
  supersedes?: string | null;
  sig?: Signature;
}

export interface ManifestKey {
  kid: string;
  alg: "Ed25519";
  public_key: string;
}

export interface Manifest {
  herald: "0.1";
  publisher: string;
  feed: string;
  keys: ManifestKey[];
  push?: { webhook_subscribe?: string; mcp?: boolean };
}

export interface Feed {
  herald: "0.1";
  publisher: string;
  announcements: Announcement[];
  next: string | null;
}

// ---------- encoding ----------

const b64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");
const fromB64url = (s: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Buffer.from(s, "base64url"));

/** Canonical JSON: sorted keys, no whitespace, undefined dropped. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

function signingBytes(a: Announcement): Uint8Array<ArrayBuffer> {
  const { sig: _sig, ...rest } = a;
  return new TextEncoder().encode(canonicalize(rest));
}

// ---------- keys ----------

export async function generateKeyPair(kid: string) {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const manifestKey: ManifestKey = { kid, alg: "Ed25519", public_key: b64url(raw) };
  return { kid, privateKey: pair.privateKey, manifestKey };
}

async function importPublicKey(k: ManifestKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromB64url(k.public_key), { name: "Ed25519" }, false, [
    "verify",
  ]);
}

// ---------- publisher ----------

export async function sign(
  a: Omit<Announcement, "sig">,
  key: { kid: string; privateKey: CryptoKey },
): Promise<Announcement> {
  validate(a);
  const unsigned = a as Announcement;
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, signingBytes(unsigned)),
  );
  return { ...unsigned, sig: { kid: key.kid, value: b64url(sigBytes) } };
}

export function validate(a: Omit<Announcement, "sig">): void {
  const errs: string[] = [];
  if (a.herald !== "0.1") errs.push("herald must be 0.1");
  if (!a.id) errs.push("id required");
  if (!a.publisher) errs.push("publisher required");
  if (!["info", "notice", "action_required", "breaking"].includes(a.severity))
    errs.push("bad severity");
  if (Number.isNaN(Date.parse(a.published))) errs.push("published must be RFC 3339");
  if (!a.title || a.title.length > 120) errs.push("title required, max 120");
  if (a.summary == null || a.summary.length > 500) errs.push("summary required, max 500");
  if (typeof a.data !== "object" || a.data === null) errs.push("data must be an object");
  if (errs.length) throw new Error(`invalid announcement: ${errs.join("; ")}`);
}

// ---------- agent ----------

export async function verify(a: Announcement, manifest: Manifest): Promise<boolean> {
  if (!a.sig || a.publisher !== manifest.publisher) return false;
  const key = manifest.keys.find((k) => k.kid === a.sig!.kid);
  if (!key) return false;
  try {
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      await importPublicKey(key),
      fromB64url(a.sig.value),
      signingBytes(a),
    );
  } catch {
    return false;
  }
}

export type Route = "store" | "digest" | "notify_owner" | "notify_owner_now";

export function route(severity: Severity): Route {
  switch (severity) {
    case "info":
      return "store";
    case "notice":
      return "digest";
    case "action_required":
      return "notify_owner";
    case "breaking":
      return "notify_owner_now";
  }
}

export interface Delivery {
  announcement: Announcement;
  route: Route;
}

/**
 * Agent-side inbox: verify, dedupe, apply supersedes and expiry, route.
 * Display text is never interpreted — callers get typed fields only to act on.
 */
export class Inbox {
  private seen = new Map<string, Announcement>();
  private superseded = new Set<string>();

  constructor(
    private manifests: Map<string, Manifest>,
    private myScopes: string[] = [],
    private now: () => Date = () => new Date(),
  ) {}

  async receive(a: Announcement): Promise<Delivery | null> {
    const manifest = this.manifests.get(a.publisher);
    if (!manifest || !(await verify(a, manifest))) return null;

    const key = `${a.publisher}/${a.id}`;
    if (this.seen.has(key) || this.superseded.has(key)) return null;
    if (a.expires && Date.parse(a.expires) < this.now().getTime()) return null;

    const scopes = a.audience?.scopes;
    if (scopes && scopes.length && !scopes.some((s) => this.myScopes.includes(s))) return null;

    if (a.supersedes) {
      const old = `${a.publisher}/${a.supersedes}`;
      this.seen.delete(old);
      this.superseded.add(old); // an older copy arriving late (e.g. from backfill) stays dropped
    }
    this.seen.set(key, a);
    return { announcement: a, route: route(a.severity) };
  }

  active(): Announcement[] {
    return [...this.seen.values()];
  }
}

export async function fetchManifest(domain: string): Promise<Manifest> {
  const res = await fetch(`https://${domain}/.well-known/herald.json`);
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
  const m = (await res.json()) as Manifest;
  if (m.publisher !== domain) throw new Error("manifest publisher mismatch");
  return m;
}

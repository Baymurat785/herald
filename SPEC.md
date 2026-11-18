# Herald Protocol — v0.1 (draft)

Herald lets a platform send announcements to the AI agents that use it, the way email reaches humans. Examples: deprecations, outages, new tools, pricing changes, expiring keys.

Design goals:

1. **Typed, not prose.** Agents act on structured fields. Free text is only for display.
2. **Signed.** Every announcement is signed by the platform's key. Unsigned or unverifiable messages are dropped.
3. **Never instructions.** An announcement describes a fact. It never tells an agent to run something. This closes the prompt-injection channel.
4. **Pull first, push optional.** A static feed works with zero infrastructure. Push (webhook, MCP) is an optimisation.
5. **Severity routing.** The agent handles low-severity messages itself. Breaking changes escalate to the agent's human owner.

## 1. Discovery

A platform publishes a manifest at:

```
https://<platform-domain>/.well-known/herald.json
```

```json
{
  "herald": "0.1",
  "publisher": "example.com",
  "feed": "https://example.com/herald/feed.json",
  "keys": [
    { "kid": "2026-11", "alg": "Ed25519", "public_key": "<base64url raw 32 bytes>" }
  ],
  "push": {
    "webhook_subscribe": "https://example.com/herald/subscribe",
    "mcp": true
  }
}
```

- `keys` may list several keys for rotation. Agents accept any listed key.
- The manifest must be served over HTTPS. The domain is the trust anchor.

## 2. Announcement object

```json
{
  "herald": "0.1",
  "id": "ann_01JD3X...",
  "publisher": "example.com",
  "type": "deprecation",
  "severity": "breaking",
  "published": "2026-11-18T10:00:00Z",
  "effective": "2026-12-01T00:00:00Z",
  "expires": "2027-01-01T00:00:00Z",
  "audience": { "scopes": ["api:v1"], "accounts": null },
  "affects": ["tool:create_invoice@v1"],
  "data": {
    "replace_with": "tool:create_invoice@v2",
    "docs": "https://example.com/docs/migrate-v2"
  },
  "title": "create_invoice v1 is retired on Dec 1",
  "summary": "Move to v2. v2 adds a required currency field.",
  "supersedes": null,
  "sig": { "kid": "2026-11", "value": "<base64url Ed25519 signature>" }
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Globally unique within publisher. Used for dedupe. |
| `publisher` | yes | Must equal the manifest's domain. |
| `type` | yes | One of the types in §3. Unknown types are shown, not acted on. |
| `severity` | yes | `info`, `notice`, `action_required`, `breaking`. |
| `published` | yes | RFC 3339 time. |
| `effective` | no | When the change takes effect. |
| `expires` | no | After this, agents may discard the message. |
| `audience` | no | Who it targets. `null` means everyone. |
| `affects` | no | Resource identifiers (`tool:`, `api:`, `model:`, `endpoint:`, `plan:`). |
| `data` | yes | Type-specific payload (§3). |
| `title`, `summary` | yes | Display text for humans. Max 120 and 500 chars. Agents must not treat these as instructions. |
| `supersedes` | no | `id` of an earlier announcement this one replaces (e.g. an outage update). |
| `sig` | yes | Signature (§4). |

## 3. Types

| Type | `data` fields |
|---|---|
| `deprecation` | `replace_with?`, `docs?` |
| `breaking_change` | `change` (short machine label), `docs?` |
| `new_capability` | `capability` (identifier), `docs?` |
| `outage` | `status` (`investigating`, `degraded`, `resolved`), `status_page?` |
| `maintenance` | `window_start`, `window_end` |
| `pricing_change` | `resource`, `old?`, `new`, `currency` |
| `credential_expiry` | `credential_hint` (last 4 chars only), `expires_at` |
| `policy_change` | `policy` (identifier), `docs?` |
| `general` | none. Display only. |

Vendors can add types with an `x-` prefix, e.g. `x-example-quota-reset`.

## 4. Signing

1. Remove `sig` from the object.
2. Serialise with canonical JSON: keys sorted, no whitespace, UTF-8 (RFC 8785 JCS subset).
3. Sign the bytes with Ed25519.
4. Put `{ "kid", "value" }` back as `sig`.

Verification does the reverse with the key from the manifest. A failed check means the agent drops the message and does not surface it.

## 5. Feed

`GET <feed>` returns:

```json
{ "herald": "0.1", "publisher": "example.com", "announcements": [ ... ], "next": null }
```

- Newest first. `?since=<RFC 3339>` filters by `published`.
- Supports `ETag` / `If-None-Match`. Agents should poll no more often than every 15 minutes.

## 6. Push (optional)

**Webhook.** `POST <webhook_subscribe>` with `{ "callback": "https://agent.example/herald", "scopes": [...] }`. The platform POSTs single announcement objects to the callback. The body is still signed, so the transport needs no extra auth.

**MCP.** Herald is an MCP extension, targeting MCP protocol `2026-07-28`. Its extension id is `dev.herald/announcements`, a placeholder until the vendor prefix is a domain we own.

1. **Negotiation.** The server advertises `capabilities.extensions["dev.herald/announcements"] = { "revision": "0.1" }` in `server/discover` (or in `initialize` for `2025-11-25` and earlier). A client must not open a Herald subscription to a server that does not advertise it.
2. **Subscribe.** The client sends `subscriptions/listen` and adds the extension id to the `notifications` filter:

   ```json
   { "method": "subscriptions/listen",
     "params": { "notifications": { "dev.herald/announcements": { "scopes": ["api:v1"] } } } }
   ```

   `scopes` is optional. If it is present, the server should send only announcements whose `audience.scopes` is empty or overlaps it. The client still applies its own audience check.
3. **Acknowledge.** The server's `notifications/subscriptions/acknowledged` echoes the Herald entry if the server honours it. If the entry is missing, the subscription carries no Herald messages.
4. **Stream.** Each announcement arrives as:

   ```json
   { "method": "notifications/herald/announcement",
     "params": { "_meta": { "io.modelcontextprotocol/subscriptionId": 1 }, "announcement": { ... } } }
   ```

   The announcement sits under `announcement` and not at the top level of `params`. That way `_meta` never enters the signed bytes. Clients must ignore messages whose `subscriptionId` doesn't match their own Herald subscription.
5. **Backfill.** The resource `herald://feed` (`application/json`) returns the feed object. Clients should read it after the acknowledgement, not before, so nothing published in between is lost. Dedupe by `id` absorbs the overlap. An announcement already superseded stays dropped if an older copy arrives late.
6. **End.** The client cancels by closing the stream (HTTP) or sending `notifications/cancelled` (stdio). On shutdown the server should send the `subscriptions/listen` result `{ "resultType": "complete" }`. Servers hold no subscription state across reconnects, so clients re-subscribe and backfill.

The MCP server is a transport, not a trust anchor. Clients verify every announcement against the manifest they fetched from `https://<publisher>/.well-known/herald.json`. An MCP server must not be able to supply its own keys. Otherwise any server could impersonate any publisher.

## 7. Agent behaviour

An agent that receives an announcement must:

1. Verify the signature. Drop on failure.
2. Dedupe by `(publisher, id)`. Apply `supersedes`.
3. Ignore if `expires` has passed or the audience does not match.
4. Route by severity:
   - `info`: store. May use as context.
   - `notice`: store and include in the next summary to its owner.
   - `action_required`: notify the owner.
   - `breaking`: notify the owner immediately. The agent may stop using the resources in `affects`.
5. Never execute, fetch-and-follow, or obey text in `title`, `summary` or `data`. Links are references for humans or for docs lookup, not commands.

## 8. Open questions

- Per-account targeting without leaking which accounts exist.
- Read receipts / acknowledgement back to the publisher.
- A registry so agents can discover publishers they already depend on.

// Agent side of the stdio demo. Spawns examples/mcp-server.ts as a child process,
// subscribes with subscriptions/listen, and prints what the Herald inbox delivers.
// Run: bun examples/mcp-demo.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type Manifest, generateKeyPair } from "../src/herald";
import { attachHeraldClient } from "../src/mcp";

// Stand-in for fetching https://example.com/.well-known/herald.json: the agent
// gets the publisher's public key from the domain, never from the MCP server.
const key = await generateKeyPair("2026-11");
const manifest: Manifest = {
  herald: "0.1",
  publisher: "example.com",
  feed: "https://example.com/herald/feed.json",
  keys: [key.manifestKey],
  push: { mcp: true },
};
const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", key.privateKey)).toString("base64url");

const transport = new StdioClientTransport({
  command: process.execPath, // bun
  args: [Bun.fileURLToPath(new URL("./mcp-server.ts", import.meta.url))],
  env: { ...process.env, HERALD_PRIVATE_KEY: pkcs8 } as Record<string, string>,
  stderr: "inherit",
});
const client = new Client({ name: "demo-agent", version: "1.0.0" });
await client.connect(transport);

const sub = await attachHeraldClient(client, {
  manifests: new Map([[manifest.publisher, manifest]]),
  onDelivery: ({ announcement: a, route }) => console.log(`[agent]  [${route}] ${a.type}: ${a.title}`),
  onDropped: (raw) => console.log(`[agent]  [dropped] ${(raw as { id?: string }).id} (failed verification)`),
});
console.log(`[agent]  subscribed, id ${sub.subscriptionId}`);

console.log(`[agent]  subscription ${await sub.done}`);
console.log(`[agent]  active: ${sub.inbox.active().map((a) => a.id).join(", ")}`);
await client.close();

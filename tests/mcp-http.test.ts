// MCP over HTTP through the real server: SDK client, bearer tokens and both rate limits.
import { test, expect, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer, type StartServerOptions } from "../src/web/server.ts";
import { newDocify, tempDir } from "./helpers.ts";

const cleanup: string[] = [];
afterAll(() => cleanup.forEach((p) => rmSync(p, { recursive: true, force: true })));

const WEB = "w".repeat(32);
const CLAUDE = "c".repeat(32);
const OPENCLAW = "o".repeat(32);
const clients = [
  { name: "claude", token: CLAUDE },
  { name: "openclaw-1", token: OPENCLAW },
];
const roomy = { limit: 1000, windowMs: 60_000 };

async function withServer(opts: StartServerOptions, run: (base: string) => Promise<void>) {
  const home = tempDir();
  cleanup.push(home);
  const docify = newDocify(home);
  const server = await startServer(0, { docify, quiet: true, token: WEB, mcpClientRate: roomy, mcpIpRate: roomy, ...opts });
  try {
    await run(`http://127.0.0.1:${server.port}`);
  } finally {
    server.stop(true);
    docify.close();
  }
}

const rpc = (base: string, token: string | null, id = 1) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} }),
  });

test("an MCP client with a valid token lists and calls the read-only tools", async () => {
  await withServer({ mcpClients: clients }, async (base) => {
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${OPENCLAW}` } } }));
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(tools).toEqual(["docs_open", "docs_read", "docs_search", "docs_sources"]);
      const listed = await client.callTool({ name: "docs_sources", arguments: {} });
      expect(listed.isError).toBeFalsy();
      const read = await client.callTool({ name: "docs_read", arguments: { id: "p_00000000000000000000" } });
      expect(JSON.stringify(read.content)).toContain("unavailable");
      const opened = await client.callTool({ name: "docs_open", arguments: { source: "nope@1", path: "a.md" } });
      expect(opened.isError).toBeFalsy();
      expect(JSON.stringify(opened.content)).toContain("status: source_unknown");
    } finally {
      await client.close();
    }
  });
});

test("/mcp refuses missing and wrong tokens, the web token and non-POST methods", async () => {
  await withServer({ mcpClients: clients }, async (base) => {
    expect((await rpc(base, null)).status).toBe(401);
    expect((await rpc(base, "x".repeat(32))).status).toBe(401);
    // The web UI token is not an MCP token.
    expect((await rpc(base, WEB)).status).toBe(401);
    expect((await rpc(base, CLAUDE)).status).toBe(200);
    const get = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${CLAUDE}`, accept: "text/event-stream" } });
    expect(get.status).toBe(405);
  });
});

test("/mcp does not exist when no MCP clients are configured", async () => {
  const saved = process.env.DOCIFY_MCP_TOKENS;
  delete process.env.DOCIFY_MCP_TOKENS;
  try {
    await withServer({}, async (base) => {
      expect((await rpc(base, CLAUDE)).status).toBe(404);
    });
  } finally {
    if (saved !== undefined) process.env.DOCIFY_MCP_TOKENS = saved;
  }
});

test("each client has its own limit, and 429 carries Retry-After", async () => {
  let t = 0;
  await withServer({ mcpClients: clients, mcpClientRate: { limit: 2, windowMs: 60_000 }, now: () => t }, async (base) => {
    expect((await rpc(base, CLAUDE)).status).toBe(200);
    expect((await rpc(base, CLAUDE)).status).toBe(200);
    const limited = await rpc(base, CLAUDE);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");
    // Another client is not affected by claude's bucket.
    expect((await rpc(base, OPENCLAW)).status).toBe(200);
    t = 30_000;
    expect((await rpc(base, CLAUDE)).status).toBe(200);
  });
});

test("the IP limit applies before auth, so guessing tokens is slowed", async () => {
  await withServer({ mcpClients: clients, mcpIpRate: { limit: 2, windowMs: 60_000 }, now: () => 0 }, async (base) => {
    expect((await rpc(base, "x".repeat(32))).status).toBe(401);
    expect((await rpc(base, "y".repeat(32))).status).toBe(401);
    expect((await rpc(base, CLAUDE)).status).toBe(429);
  });
});

test("/mcp rejects an unknown Host and a body over 1 MB", async () => {
  await withServer({ mcpClients: clients, allowedHosts: ["docs.example.test"] }, async (base) => {
    const evil = await fetch(`${base}/mcp`, { method: "POST", headers: { host: "evil.test", authorization: `Bearer ${CLAUDE}` }, body: "{}" });
    expect(evil.status).toBe(403);
    const big = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${CLAUDE}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(1024 * 1024) } }),
    });
    expect(big.status).toBe(413);
  });
});

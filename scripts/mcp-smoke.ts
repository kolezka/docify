// Drives the stdio MCP server like a host would: list tools, search, read, unavailable version, scope.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "bun", args: [new URL("../src/cli.ts", import.meta.url).pathname, "mcp"], env: { ...process.env } as Record<string, string>, stderr: "inherit" });
const client = new Client({ name: "docify-smoke", version: "0" });
await client.connect(transport);
const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
const text = (r: any) => r.content[0].text as string;
const s = await client.callTool({ name: "docs_search", arguments: { query: Bun.argv[2] ?? "WAL sidecar files", library: "bun", max_tokens: 500 } });
console.log(text(s).split("\n").slice(0, 6).join("\n"));
const id = /id (p_[0-9a-f]{20})/.exec(text(s))?.[1];
if (id) console.log("read:", text(await client.callTool({ name: "docs_read", arguments: { id, max_tokens: 400 } })).split("\n").slice(0, 4).join(" | "));
console.log("v9:", text(await client.callTool({ name: "docs_search", arguments: { query: "WAL", library: "bun", version: "9.9" } })).split("\n").slice(1, 4).join(" | "));
console.log("scope:", text(await client.callTool({ name: "docs_scope", arguments: { library: "bun", version: "9.9" } })).split("\n").slice(1, 5).join(" | "));
await client.close();

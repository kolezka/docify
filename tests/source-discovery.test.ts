import { afterAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { discoverSources, renderSources, sources } from "../src/core/search.ts";
import { createMcpServer } from "../src/mcp/tools.ts";
import { newDocify, tempDir } from "./helpers.ts";

const d = newDocify(tempDir());
afterAll(() => d.close());
const apple = d.addSource({ library: "apple-his", kind: "url", locator: "https://developer.apple.com/design/human-interface-guidelines" });
const other = d.addSource({ library: "reference", kind: "url", locator: "https://example.test/reference" });

test("natural-language collection discovery works without generating or preparing", () => {
  const before = d.db.query("SELECT * FROM sources ORDER BY id").all();
  expect(discoverSources(d, "docs for Apple").map(s => s.id)).toEqual([apple.id]);
  expect(discoverSources(d, "nonexistent")).toEqual([]);
  expect(discoverSources(d, "pp")).toEqual([]);
  expect(discoverSources(d, "ui docs")).toEqual([]);
  expect(discoverSources(d, "docs for")).toEqual([]);
  expect(() => discoverSources(d, " ")).toThrow("source query");
  expect(d.db.query("SELECT * FROM sources ORDER BY id").all()).toEqual(before);
  expect(sources(d).map(s => s.id)).toContain(other.id);
});

test("MCP discovery returns a usable source id and distinguishes no match from empty store", async () => {
  const server = createMcpServer(d);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "discovery-test", version: "1" });
  await client.connect(b);
  try {
    const result = await client.callTool({ name: "docs_sources", arguments: { query: "docs for Apple" } });
    expect(JSON.stringify(result)).toContain(apple.id);
    expect(JSON.stringify(result)).not.toContain(other.id);
    const missing = await client.callTool({ name: "docs_sources", arguments: { query: "missingtopic" } });
    expect(JSON.stringify(missing)).toContain("No matching documentation collections");
    const all = await client.callTool({ name: "docs_sources", arguments: {} });
    expect(JSON.stringify(all)).toContain(other.id);
  } finally {
    await client.close();
    await server.close();
  }
});

test("empty catalogue keeps existing render behavior", () => {
  expect(renderSources([])).toBe("No documentation sources registered.");
});

// Source titles and groups: a title only labels a source, a group names a set of sources that
// search, scope and the MCP tools accept in place of listing every id.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DocifyError, sourceLabels, type Docify } from "../src/core/docify.ts";
import { renderSources, scope, search, searchMany, sources } from "../src/core/search.ts";
import { createMcpServer } from "../src/mcp/tools.ts";
import { startServer } from "../src/web/server.ts";
import { fakeGraph, newDocify, tempDir, writeDocs } from "./helpers.ts";

let d: Docify;
const home = tempDir();
const src = tempDir("docify-src-");
const project = tempDir("docify-proj-");

beforeAll(async () => {
  d = newDocify(home);
  const docs: Record<string, string> = {
    "walrus@1": "# Walrus\n\n## Tusks\n\nWalrus tusks are long teeth used for hauling.\n",
    "narwhal@1": "# Narwhal\n\n## Horn\n\nNarwhal tusks are a single spiral tooth.\n",
    "otter@1": "# Otter\n\n## Tools\n\nOtters break shells with stones, no tusks at all.\n",
  };
  for (const [id, text] of Object.entries(docs)) {
    const library = id.split("@")[0]!;
    d.addSource({ library, version: "1", kind: "local", locator: writeDocs(join(src, library), { "a.md": text }) });
    await d.prepare(id, { graphRunner: fakeGraph });
  }
  d.updateSourceLabels("walrus@1", { groups: ["arctic"] });
  d.updateSourceLabels("narwhal@1", { groups: ["arctic", "whales"] });
});
afterAll(() => {
  d.close();
  for (const dir of [home, src, project]) rmSync(dir, { recursive: true, force: true });
});

const sourcesOf = (hits: { citation: { source: string } }[]) => [...new Set(hits.map((h) => h.citation.source))].sort();

test("a group expands to its member sources in scope and search", async () => {
  const s = scope(d, { groups: ["arctic"], project });
  expect(s.status).toBe("ok");
  expect(s.selected.map((x) => x.source).sort()).toEqual(["narwhal@1", "walrus@1"]);

  const r = await search(d, { query: "tusks", groups: ["arctic"], mode: "lexical", project });
  expect(r.status).toBe("ok");
  expect(sourcesOf(r.hits)).toEqual(["narwhal@1", "walrus@1"]);
  // Control: without the group the otter source matches the same query.
  const all = await search(d, { query: "tusks", mode: "lexical", project });
  expect(sourcesOf(all.hits)).toContain("otter@1");

  const many = await searchMany(d, { queries: ["tusks", "tooth"], groups: ["arctic"], mode: "lexical", project });
  expect(sourcesOf(many.hits)).not.toContain("otter@1");
});

test("groups and sources together search their union", () => {
  const s = scope(d, { groups: ["whales"], sources: ["otter@1"], project });
  expect(s.status).toBe("ok");
  expect(s.selected.map((x) => x.source).sort()).toEqual(["narwhal@1", "otter@1"]);
});

test("group names are matched case-insensitively", () => {
  expect(scope(d, { groups: ["Arctic"], project }).selected).toHaveLength(2);
});

test("an unknown group is source_unknown and names the registered groups", () => {
  const s = scope(d, { groups: ["antarctic"], project });
  expect(s.status).toBe("source_unknown");
  expect(s.selected).toEqual([]);
  expect(s.text).toContain("unknown source group antarctic; registered groups: arctic, whales");
  // One unknown name fails the whole request rather than searching the rest.
  expect(scope(d, { groups: ["arctic", "antarctic"], project }).status).toBe("source_unknown");
});

test("listGroups and docs_sources text show each group with its sources", () => {
  expect(d.listGroups()).toEqual([
    { name: "arctic", sources: ["narwhal@1", "walrus@1"] },
    { name: "whales", sources: ["narwhal@1"] },
  ]);
  const text = renderSources(sources(d));
  expect(text).toContain("  arctic: narwhal@1, walrus@1");
  expect(text).toContain("  whales: narwhal@1");
  expect(text).toContain("narwhal@1 [ready]");
  expect(text).toContain("  groups: arctic, whales");
});

test("a title is a label: the id, citations and scope stay the same", async () => {
  const fresh = writeDocs(join(src, "seal"), { "a.md": "# Seal\n\n## Whiskers\n\nSeal whiskers sense fish.\n" });
  d.addSource({ library: "seal", version: "1", kind: "local", locator: fresh, title: "  Harbour   seal notes ", groups: ["Pinnipeds"] });
  try {
    expect(sourceLabels(d.requireSource("seal@1"))).toEqual({ title: "Harbour seal notes", groups: ["pinnipeds"] });
    await d.prepare("seal@1", { graphRunner: fakeGraph });
    d.updateSourceLabels("seal@1", { title: "Grey seal" });
    const info = sources(d).find((s) => s.id === "seal@1")!;
    expect(info.title).toBe("Grey seal");
    expect(info.groups).toEqual(["pinnipeds"]);
    expect(renderSources([info])).toContain('seal@1 "Grey seal" [ready]');
    const r = await search(d, { query: "whiskers", sources: ["seal@1"], mode: "lexical", project });
    expect(r.hits[0]!.citation.source).toBe("seal@1");
    // Clearing removes the key; an untouched field is left as it was.
    d.updateSourceLabels("seal@1", { title: null });
    expect(sourceLabels(d.requireSource("seal@1"))).toEqual({ title: null, groups: ["pinnipeds"] });
    expect(JSON.parse(d.requireSource("seal@1").options)).not.toHaveProperty("title");
  } finally {
    d.removeSource("seal@1");
  }
  // A removed source leaves its groups; a group with no sources no longer exists.
  expect(d.listGroups().map((g) => g.name)).toEqual(["arctic", "whales"]);
});

test("setSourceGroup adds and removes one membership", () => {
  expect(d.setSourceGroup("otter@1", "Coast", true)).toEqual(["coast"]);
  expect(d.setSourceGroup("otter@1", "coast", true)).toEqual(["coast"]);
  expect(d.setSourceGroup("otter@1", "coast", false)).toEqual([]);
  expect(JSON.parse(d.requireSource("otter@1").options)).not.toHaveProperty("groups");
});

test("invalid titles and group names are rejected without writing", () => {
  const before = d.requireSource("walrus@1").options;
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return err instanceof DocifyError ? `${err.code}:${err.field}` : String(err);
    }
    return "no error";
  };
  expect(code(() => d.updateSourceLabels("walrus@1", { groups: ["bun@1"] }))).toBe("invalid_input:groups");
  expect(code(() => d.updateSourceLabels("walrus@1", { groups: "arctic" }))).toBe("invalid_input:groups");
  expect(code(() => d.updateSourceLabels("walrus@1", { groups: [""] }))).toBe("invalid_input:groups");
  expect(code(() => d.updateSourceLabels("walrus@1", { title: 5 }))).toBe("invalid_input:title");
  expect(code(() => d.updateSourceLabels("walrus@1", { title: "x".repeat(121) }))).toBe("invalid_input:title");
  expect(code(() => d.updateSourceLabels("walrus@1", {}))).toBe("invalid_input:undefined");
  expect(code(() => d.updateSourceLabels("nope@1", { title: "x" }))).toBe("source_unknown:undefined");
  expect(d.requireSource("walrus@1").options).toBe(before);
});

test("a malformed stored group list is an error, not an empty group", () => {
  const before = d.requireSource("walrus@1").options;
  try {
    d.db.run("UPDATE sources SET options = json_set(options, '$.groups', 'arctic') WHERE id = 'walrus@1'");
    expect(() => scope(d, { groups: ["arctic"], project })).toThrow("source walrus@1 has a malformed stored group list");
    expect(() => sources(d)).toThrow("malformed stored group list");
    // Control: a valid list reads back.
    d.db.run("UPDATE sources SET options = ? WHERE id = 'walrus@1'", [before]);
    expect(sourceLabels(d.requireSource("walrus@1")).groups).toEqual(["arctic"]);
  } finally {
    d.db.run("UPDATE sources SET options = ? WHERE id = 'walrus@1'", [before]);
  }
});

test("MCP docs_search and docs_scope accept groups; docs_sources lists them", async () => {
  const server = createMcpServer(d, project);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  try {
    const text = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
      return (r.content as { text: string }[])[0]!.text;
    };
    const scoped = await text("docs_scope", { groups: ["arctic"] });
    expect(scoped).toContain("selected: narwhal@1");
    expect(scoped).toContain("selected: walrus@1");
    expect(scoped).not.toContain("otter@1");
    const found = await text("docs_search", { query: "tusks", groups: ["arctic"], mode: "lexical" });
    expect(found).toContain("walrus@1");
    expect(found).not.toContain("otter@1");
    expect(await text("docs_search", { query: "tusks", groups: ["nope"], mode: "lexical" })).toContain("source_unknown");
    expect(await text("docs_sources", {})).toContain("arctic: narwhal@1, walrus@1");
    expect(await text("docs_sources", { query: "whales" })).toContain("narwhal@1");
  } finally {
    await client.close();
  }
});

test("web API sets title and groups, lists groups and searches by group", async () => {
  const server = await startServer(0, { docify: d, quiet: true, token: "g".repeat(32) });
  const base = `http://127.0.0.1:${server.port}/api`;
  const call = (path: string, method = "GET", body?: unknown) =>
    fetch(`${base}${path}`, { method, headers: { "x-docify-token": server.token!, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  try {
    expect((await call("/sources/otter%401", "PATCH", { title: "Sea otter", groups: ["coast"] })).status).toBe(200);
    expect(sourceLabels(d.requireSource("otter@1"))).toEqual({ title: "Sea otter", groups: ["coast"] });
    const bad = await call("/sources/otter%401", "PATCH", { title: "ok", groups: ["Bad Name"] });
    expect(bad.status).toBe(400);
    expect((await bad.json()).field).toBe("groups");
    // Validated before writing: the valid title in the same request was not applied.
    expect(sourceLabels(d.requireSource("otter@1")).title).toBe("Sea otter");
    expect(await (await call("/groups")).json()).toContainEqual({ name: "coast", sources: ["otter@1"] });
    // A wrong type fails in the zod schema and still names the field.
    const typed = await call("/sources/otter%401", "PATCH", { title: 5 });
    expect(typed.status).toBe(400);
    expect((await typed.json()).field).toBe("title");
    const r = await (await call("/search", "POST", { query: "tusks", groups: ["coast"], mode: "lexical" })).json();
    expect(sourcesOf(r.hits)).toEqual(["otter@1"]);
    const sc = await (await call("/scope?group=coast")).json();
    expect(sc.selected.map((x: { source: string }) => x.source)).toEqual(["otter@1"]);
    const listed = await (await call("/sources/otter%401")).json();
    expect(listed).toMatchObject({ title: "Sea otter", groups: ["coast"] });
    const spec = await (await fetch(`http://127.0.0.1:${server.port}/api/docs/openapi.json`, { headers: { "x-docify-token": server.token! } })).json();
    expect(spec.paths["/api/groups"].get).toBeDefined();
    expect(spec.components.schemas.PatchSource.properties).toHaveProperty("groups");
  } finally {
    d.updateSourceLabels("otter@1", { title: null, groups: null });
    server.stop(true);
  }
});

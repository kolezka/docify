import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { startServer } from "../src/web/server.ts";
import { fakeGraph, newDocify, tempDir, writeDocs } from "./helpers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

async function setup() {
  const roots = tempDir("docify-src-");
  const savedRoots = process.env.DOCIFY_SOURCE_ROOTS;
  process.env.DOCIFY_SOURCE_ROOTS = roots;
  const d = newDocify(tempDir());
  const server = await startServer(0, { docify: d, quiet: true, project: tempDir("docify-project-"), token: "a".repeat(32) });
  cleanup.push(() => {
    server.stop(true);
    d.close();
    if (savedRoots === undefined) delete process.env.DOCIFY_SOURCE_ROOTS;
    else process.env.DOCIFY_SOURCE_ROOTS = savedRoots;
  });
  const call = async (path: string, method = "GET", body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: { "x-docify-token": server.token!, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  return { d, roots, call, port: server.port };
}

// A prepared local source with two documents, built without the API.
async function prepared(d: ReturnType<typeof newDocify>, roots: string) {
  const dir = writeDocs(join(roots, "docs"), {
    "guide.md": "# Guide\n\nInstall with the widget command.\n\n## Options\n\nThe frobnicate option turns on frobs.\n",
    "api.md": "# API\n\nCall widget.start() to begin.\n",
  });
  const source = d.addSource({ library: "widget", version: "1.0.0", kind: "local", locator: dir });
  await d.prepare(source.id, { graph: false, graphRunner: fakeGraph });
  return source.id;
}

test("status reports the version, store and source counts", async () => {
  const { d, roots, call } = await setup();
  await prepared(d, roots);
  const res = await call("/api/status");
  expect(res.status).toBe(200);
  expect(res.data).toMatchObject({ home: d.config.home, importing: false, running: [], sources: { ready: 1 } });
  expect(typeof res.data.version).toBe("string");
});

test("a source can be read alone, with its generations, and is 404 when unknown", async () => {
  const { d, roots, call } = await setup();
  const id = await prepared(d, roots);
  const one = await call(`/api/sources/${encodeURIComponent(id)}`);
  expect(one.status).toBe(200);
  expect(one.data).toMatchObject({ id, state: "ready", library: "widget" });
  const gens = await call(`/api/sources/${encodeURIComponent(id)}/generations`);
  expect(gens.status).toBe(200);
  expect(gens.data.activeGeneration).toBe(one.data.activeGeneration.id);
  expect(gens.data.generations).toHaveLength(1);
  expect(gens.data.generations[0]).toMatchObject({ status: "active", finishedAt: expect.any(String) });
  expect(typeof gens.data.generations[0].stats).toBe("object");
  for (const path of ["/api/sources/missing", "/api/sources/missing/generations"]) {
    const res = await call(path);
    expect([path, res.status, res.data.code]).toEqual([path, 404, "source_unknown"]);
  }
});

test("sources can be found by topic with query, and an over-long query is invalid input", async () => {
  const { d, roots, call } = await setup();
  const id = await prepared(d, roots);
  expect((await call("/api/sources?query=widget")).data.map((s: { id: string }) => s.id)).toEqual([id]);
  expect((await call("/api/sources?query=nothing-like-this")).data).toEqual([]);
  const long = await call(`/api/sources?query=${"x".repeat(501)}`);
  expect([long.status, long.data.code]).toEqual([400, "invalid_input"]);
});

test("search takes one query or several, and refuses both or neither", async () => {
  const { d, roots, call } = await setup();
  const id = await prepared(d, roots);
  const one = await call("/api/search", "POST", { query: "frobnicate option", mode: "lexical", sources: [id] });
  expect(one.status).toBe(200);
  expect(one.data.status).toBe("ok");
  expect(one.data.hits[0].citation.document).toBe("guide.md");
  const many = await call("/api/search", "POST", { queries: ["frobnicate option", "widget.start"], mode: "lexical", sources: [id] });
  expect(many.status).toBe(200);
  expect(many.data.queries.map((q: { status: string }) => q.status)).toEqual(["ok", "ok"]);
  for (const body of [{}, { query: "a", queries: ["b"] }, { queries: [] }, { queries: Array(9).fill("x") }, { query: "x", mode: "fuzzy" }]) {
    const res = await call("/api/search", "POST", body);
    expect([JSON.stringify(body), res.status, res.data.code]).toEqual([JSON.stringify(body), 400, "invalid_input"]);
  }
});

test("scope, outline and open answer like the CLI commands", async () => {
  const { d, roots, call } = await setup();
  const id = await prepared(d, roots);
  const enc = encodeURIComponent(id);
  const sc = await call(`/api/scope?library=widget`);
  expect(sc.status).toBe(200);
  expect(sc.data.selected.map((s: { source: string }) => s.source)).toEqual([id]);
  // A repeated source parameter is a list; an unknown id in it makes the scope unknown.
  expect((await call(`/api/scope?source=${enc}`)).data.selected).toHaveLength(1);
  expect((await call(`/api/scope?source=${enc}&source=other%401`)).data.status).toBe("source_unknown");

  const ol = await call(`/api/sources/${enc}/outline`);
  expect(ol.status).toBe(200);
  expect(ol.data.status).toBe("ok");
  expect(ol.data.documents.map((doc: { path: string }) => doc.path).sort()).toEqual(["api.md", "guide.md"]);
  expect((await call(`/api/sources/${enc}/outline?path=api`)).data.documents.map((doc: { path: string }) => doc.path)).toEqual(["api.md"]);

  const op = await call(`/api/sources/${enc}/open?path=guide.md&heading=options`);
  expect(op.status).toBe(200);
  expect(op.data.status).toBe("ok");
  expect(op.data.text).toContain("frobnicate");
  expect(op.data.text).not.toContain("Install with");
  expect((await call(`/api/sources/${enc}/open?path=nope.md`)).data.status).toBe("not_found");

  for (const path of [`/api/sources/${enc}/open`, `/api/sources/${enc}/outline?maxTokens=12`, `/api/sources/${enc}/open?path=guide.md&maxTokens=abc`, `/api/read/p_x?maxTokens=99999`]) {
    const res = await call(path);
    expect([path, res.status, res.data.code]).toEqual([path, 400, "invalid_input"]);
  }
});

test("read accepts a token budget", async () => {
  const { d, roots, call } = await setup();
  const id = await prepared(d, roots);
  const hit = (await call("/api/search", "POST", { query: "frobnicate", mode: "lexical", sources: [id] })).data.hits[0];
  const res = await call(`/api/read/${hit.id}?maxTokens=200`);
  expect(res.status).toBe(200);
  expect(res.data.status).toBe("ok");
  expect(res.data.tokens).toBeLessThanOrEqual(200);
});

test("compress runs through the API and finds nothing to do on a new store", async () => {
  const { d, roots, call } = await setup();
  await prepared(d, roots);
  const res = await call("/api/compress", "POST", {});
  expect(res.status).toBe(200);
  expect(res.data).toMatchObject({ files: 0, skipped: [] });
});

test("guards answer before validation, and wrong body types keep their codes", async () => {
  const { call, port } = await setup();
  const base = `http://127.0.0.1:${port}`;
  // No token: 401 even for input that would be invalid.
  expect((await fetch(`${base}/api/search`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status).toBe(401);
  expect((await fetch(`${base}/api/logs?after=-1`)).status).toBe(401);
  const token = { "x-docify-token": "a".repeat(32) };
  const text = await fetch(`${base}/api/search`, { method: "POST", headers: { ...token, "content-type": "text/plain" }, body: "{}" });
  expect([text.status, (await text.json()).code]).toEqual([415, "unsupported"]);
  const malformed = await fetch(`${base}/api/search`, { method: "POST", headers: { ...token, "content-type": "application/json" }, body: "{" });
  expect([malformed.status, (await malformed.json()).code]).toEqual([400, "invalid_input"]);
  const unknown = await fetch(`${base}/api/nothing`, { headers: token });
  expect([unknown.status, await unknown.text()]).toEqual([404, "not found"]);
  expect((await call("/api/status")).status).toBe(200);
});

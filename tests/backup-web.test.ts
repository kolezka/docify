import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Docify } from "../src/core/docify.ts";
import { startServer } from "../src/web/server.ts";
import { fakeGraph, newDocify, tempDir, writeDocs } from "./helpers.ts";

// A local stand-in for an embedding server, so these tests need no model files.
const URL_ENV = "DOCIFY_TEST_BACKUP_WEB_EMBED_URL";
const KEY_ENV = "DOCIFY_TEST_BACKUP_WEB_EMBED_KEY";
const embedServer = Bun.serve({
  port: 0,
  async fetch(req) {
    const b = (await req.json()) as { model: string; input: string[] };
    return Response.json({ object: "list", model: b.model, data: b.input.map((t, index) => ({ object: "embedding", index, embedding: [t.length, 1, 2, 3] })) });
  },
});
const EMBED = { embeddingProvider: "openai", embeddingBaseUrlEnv: URL_ENV, embeddingApiKeyEnv: KEY_ENV, embeddingModel: "fake-embed", embeddingDims: 4, embeddingQueryPrefix: "" };

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
const savedRoots = process.env.DOCIFY_SOURCE_ROOTS;
afterAll(() => {
  embedServer.stop(true);
  if (savedRoots === undefined) delete process.env.DOCIFY_SOURCE_ROOTS;
  else process.env.DOCIFY_SOURCE_ROOTS = savedRoots;
});

// Source roots are read when the server starts.
async function serve(d: Docify, roots: string) {
  process.env.DOCIFY_SOURCE_ROOTS = roots;
  const server = await startServer(0, { docify: d, quiet: true, project: tempDir("docify-project-"), token: "a".repeat(32) });
  cleanup.push(() => {
    server.stop(true);
    d.close();
  });
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { "x-docify-token": server.token! };
  return { base, headers };
}

let backup: Uint8Array<ArrayBuffer>;
let passageId: string;
beforeAll(async () => {
  process.env[URL_ENV] = `http://127.0.0.1:${embedServer.port}`;
  process.env[KEY_ENV] = "sk-test";
  const d = newDocify(tempDir(), EMBED);
  d.addSource({ library: "lib", version: "1", kind: "local", locator: writeDocs(join(tempDir("docify-src-"), "lib"), { "guide.md": "# Guide\n\n## Usage\n\nCall the frobnicate function.\n" }) });
  await d.prepare("lib@1", { graphRunner: fakeGraph });
  passageId = d.db.query<{ id: string }, []>("SELECT id FROM passages LIMIT 1").get()!.id;
  const { base, headers } = await serve(d, realpathSync(tmpdir()));
  const res = await fetch(`${base}/api/export`, { headers });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/gzip");
  expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="docify-backup-[\d-]+\.tar\.gz"$/);
  backup = new Uint8Array(await res.arrayBuffer());
  for (const fn of cleanup.splice(0)) fn();
});

const upload = (base: string, headers: Record<string, string>, body: Uint8Array<ArrayBuffer>, type = "application/octet-stream", query = "") =>
  fetch(`${base}/api/import${query}`, { method: "POST", headers: { ...headers, "content-type": type }, body });

test("a backup exported by one server imports into another, which serves it right away", async () => {
  const { base, headers } = await serve(newDocify(tempDir(), EMBED), realpathSync(tmpdir()));
  const res = await upload(base, headers, backup);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { sources: string[] }).sources).toEqual(["lib@1"]);
  const list = (await (await fetch(`${base}/api/sources`, { headers })).json()) as { id: string; state: string }[];
  expect(list.map((s) => [s.id, s.state])).toEqual([["lib@1", "ready"]]);
  const raw = await fetch(`${base}/api/raw/${passageId}`, { headers });
  expect(raw.status).toBe(200);
  expect(await raw.text()).toContain("frobnicate");
});

test("import needs the token and a raw upload, not JSON or a form", async () => {
  const { base, headers } = await serve(newDocify(tempDir(), EMBED), realpathSync(tmpdir()));
  expect((await upload(base, {}, backup)).status).toBe(401);
  expect((await upload(base, headers, backup, "application/json")).status).toBe(415);
  expect((await upload(base, headers, backup, "multipart/form-data; boundary=x")).status).toBe(415);
});

test("import refuses local sources outside DOCIFY_SOURCE_ROOTS", async () => {
  const d = newDocify(tempDir(), EMBED);
  const { base, headers } = await serve(d, tempDir("docify-roots-"));
  const res = await upload(base, headers, backup);
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toMatch(/outside DOCIFY_SOURCE_ROOTS/);
  expect(d.listSourceRows()).toEqual([]);
});

import { test, expect, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/core/config.ts";
import { embedTexts, ModelNotPreparedError } from "../src/core/embed.ts";
import { search } from "../src/core/search.ts";
import { fakeGraph, newDocify, tempDir, writeDocs } from "./helpers.ts";

// Fake Ollama /api/embed: answers 413 when the request body exceeds `limit` characters of
// input, like a real server whose model context is exceeded.
function fakeOllama(limit: number) {
  const calls: number[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { input } = (await req.json()) as { input: string[] };
      calls.push(input.length);
      if (input.reduce((n, t) => n + t.length, 0) > limit) return new Response("too large", { status: 413 });
      // 4-dim vector, not normalized, so the client must normalize it.
      return Response.json({ embeddings: input.map((t) => [t.length, 1, t.includes("sqlite") ? 3 : 0, 2]) });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}

const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

function ollamaConfig(url: string) {
  const home = tempDir();
  homes.push(home);
  return { ...loadConfig(home), embeddingProvider: "ollama" as const, embeddingUrl: url, embeddingModel: "bge-m3", embeddingDims: 4, embeddingQueryPrefix: "" };
}

test("ollama embedding returns one unit vector per text, in order, despite the server size limit", async () => {
  const srv = fakeOllama(1000);
  try {
    const texts = ["a".repeat(300), "b".repeat(300), "c".repeat(300), "d".repeat(4000), "e".repeat(10)];
    const vecs = await embedTexts(ollamaConfig(srv.url), texts);
    expect(vecs).toHaveLength(texts.length);
    for (const v of vecs) expect(Math.hypot(...v)).toBeCloseTo(1, 5);
    // First component is proportional to the embedded length: 4000 chars were halved to 1000.
    const lengths = vecs.map((v) => Math.round(v[0]! / v[3]! * 2));
    expect(lengths).toEqual([300, 300, 300, 1000, 10]);
    expect(srv.calls.length).toBeGreaterThan(1);
  } finally {
    srv.stop();
  }
});

test("an unreachable ollama server fails with instructions, not a fetch stack", async () => {
  const srv = fakeOllama(1000);
  const url = srv.url;
  srv.stop();
  const err = await embedTexts(ollamaConfig(url), ["q"]).catch((e) => e);
  expect(err).toBeInstanceOf(ModelNotPreparedError);
  expect(String(err.message)).toContain("docker compose up -d");
});

test("generations record the provider, so a provider switch skips stale vectors", async () => {
  const srv = fakeOllama(100000);
  const home = tempDir();
  homes.push(home);
  try {
    const cfg = { embeddingProvider: "ollama" as const, embeddingUrl: srv.url, embeddingModel: "bge-m3", embeddingDims: 4, embeddingQueryPrefix: "" };
    const d = newDocify(home, cfg);
    const docs = writeDocs(join(tempDir("docify-src-"), "lib"), { "a.md": "# Lib\n\n## Open a database\n\nUse sqlite to open a file.\n" });
    d.addSource({ library: "lib", version: "1", kind: "local", locator: docs });
    await d.prepare("lib@1", { graphRunner: fakeGraph });
    expect(d.getGeneration(d.db.query<{ active_generation: number }, []>("SELECT active_generation FROM sources").get()!.active_generation)!.embedding_model).toBe("ollama:bge-m3");
    d.close();

    // Same model name, different provider: vectors must not be mixed.
    const other = newDocify(home, { ...cfg, embeddingProvider: "transformers" });
    const r = await search(other, { query: "open a database", library: "lib", mode: "lexical" });
    expect(r.text).toContain("indexed with ollama:bge-m3, current model is bge-m3");
    other.close();
  } finally {
    srv.stop();
  }
});

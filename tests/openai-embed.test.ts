import { test, expect, afterAll, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/core/config.ts";
import { embedTexts, ModelNotPreparedError } from "../src/core/embed.ts";
import { fakeGraph, newDocify, tempDir, writeDocs } from "./helpers.ts";

// Test-only variable names, so a developer's real LITELLM_* settings are never read or changed.
const URL_ENV = "DOCIFY_TEST_EMBED_BASE_URL";
const KEY_ENV = "DOCIFY_TEST_EMBED_API_KEY";
const KEY = "sk-test-0123456789";

interface Call {
  path: string;
  auth: string | null;
  model: string;
  input: string[];
}

// Fake OpenAI-compatible /v1/embeddings. Returns `data` in reverse order, as the API allows,
// and unnormalized 4-dim vectors, so the client must reorder and normalize.
function fakeOpenAI(opts: { status?: number; body?: string; limit?: number; delayMs?: number } = {}) {
  const calls: Call[] = [];
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const b = (await req.json()) as { model: string; input: string[] };
      calls.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization"), model: b.model, input: b.input });
      if (opts.delayMs) await Bun.sleep(opts.delayMs);
      if (opts.status) return new Response(opts.body ?? "error", { status: opts.status });
      if (opts.limit && b.input.reduce((n, t) => n + t.length, 0) > opts.limit) {
        return new Response("This model's maximum context length is 8192 tokens", { status: 400 });
      }
      const data = b.input.map((t, index) => ({ object: "embedding", index, embedding: [t.length, 1, t.includes("sqlite") ? 3 : 0, 2] }));
      return Response.json({ object: "list", model: b.model, data: data.reverse() });
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}

const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
afterEach(() => {
  delete process.env[URL_ENV];
  delete process.env[KEY_ENV];
});

// null leaves the variable unset (an explicit undefined would pick up the default key).
function openaiConfig(base: string | null, key: string | null = KEY) {
  const home = tempDir();
  homes.push(home);
  if (base !== null) process.env[URL_ENV] = base;
  if (key !== null) process.env[KEY_ENV] = key;
  return {
    ...loadConfig(home),
    embeddingProvider: "openai" as const,
    embeddingBaseUrlEnv: URL_ENV,
    embeddingApiKeyEnv: KEY_ENV,
    embeddingModel: "text-embedding-3-small",
    embeddingDims: 4,
    embeddingQueryPrefix: "",
  };
}

test("openai embedding sends the key and model, and returns unit vectors in input order", async () => {
  const srv = fakeOpenAI();
  try {
    const texts = ["a".repeat(30), "b".repeat(10), "c".repeat(20)];
    const vecs = await embedTexts(openaiConfig(srv.base), texts);
    expect(srv.calls).toHaveLength(1);
    expect(srv.calls[0]).toEqual({ path: "/v1/embeddings", auth: `Bearer ${KEY}`, model: "text-embedding-3-small", input: texts });
    for (const v of vecs) expect(Math.hypot(...v)).toBeCloseTo(1, 5);
    // First component over the last is length / 2, so it identifies which text a vector belongs to.
    expect(vecs.map((v) => Math.round((v[0]! / v[3]!) * 2))).toEqual([30, 10, 20]);
  } finally {
    srv.stop();
  }
});

test("a base URL that already ends in /v1 is not doubled", async () => {
  const srv = fakeOpenAI();
  try {
    await embedTexts(openaiConfig(`${srv.base}/v1/`), ["q"]);
    expect(srv.calls.map((c) => c.path)).toEqual(["/v1/embeddings"]);
  } finally {
    srv.stop();
  }
});

test("inputs over the model context are split and shortened, not dropped", async () => {
  const srv = fakeOpenAI({ limit: 1000 });
  try {
    const texts = ["a".repeat(300), "b".repeat(300), "c".repeat(300), "d".repeat(4000), "e".repeat(10)];
    const vecs = await embedTexts(openaiConfig(srv.base), texts);
    expect(vecs.map((v) => Math.round((v[0]! / v[3]!) * 2))).toEqual([300, 300, 300, 1000, 10]);
  } finally {
    srv.stop();
  }
});

test("missing base URL or key fails before any request and names the variable", async () => {
  const srv = fakeOpenAI();
  try {
    const noUrl = await embedTexts(openaiConfig(null), ["q"]).catch((e) => e);
    expect(noUrl).toBeInstanceOf(ModelNotPreparedError);
    expect(String(noUrl.message)).toContain(URL_ENV);
    delete process.env[KEY_ENV];
    const noKey = await embedTexts(openaiConfig(srv.base, null), ["q"]).catch((e) => e);
    expect(noKey).toBeInstanceOf(ModelNotPreparedError);
    expect(String(noKey.message)).toContain(KEY_ENV);
    expect(srv.calls).toHaveLength(0);
  } finally {
    srv.stop();
  }
});

test("a rejected key and a server error never put the key in the error message", async () => {
  const denied = fakeOpenAI({ status: 401, body: `Invalid API key: ${KEY}` });
  const broken = fakeOpenAI({ status: 500, body: `upstream failed for key ${KEY}` });
  try {
    const e401 = await embedTexts(openaiConfig(denied.base), ["q"]).catch((e) => e);
    expect(e401).toBeInstanceOf(ModelNotPreparedError);
    expect(String(e401.message)).toContain(KEY_ENV);
    expect(String(e401.message)).not.toContain(KEY);
    const e500 = await embedTexts(openaiConfig(broken.base), ["q"]).catch((e) => e);
    expect(String(e500.message)).toContain("HTTP 500");
    expect(String(e500.message)).toContain("<redacted>");
    expect(String(e500.message)).not.toContain(KEY);
  } finally {
    denied.stop();
    broken.stop();
  }
});

test("a server that stops answering times out instead of hanging", async () => {
  const srv = fakeOpenAI({ delayMs: 3000 });
  try {
    const started = performance.now();
    const err = await embedTexts({ ...openaiConfig(srv.base), embeddingTimeoutSeconds: 0.2 }, ["q"]).catch((e) => e);
    expect(String(err?.message)).toContain("did not answer within 0.2 s");
    expect(performance.now() - started).toBeLessThan(2000);
  } finally {
    srv.stop();
  }
});

test("cancelling a preparation aborts the request in flight", async () => {
  const srv = fakeOpenAI({ delayMs: 3000 });
  const home = tempDir();
  homes.push(home);
  try {
    const { embeddingProvider, embeddingBaseUrlEnv, embeddingApiKeyEnv, embeddingModel, embeddingDims, embeddingQueryPrefix } = openaiConfig(srv.base);
    const d = newDocify(home, { embeddingProvider, embeddingBaseUrlEnv, embeddingApiKeyEnv, embeddingModel, embeddingDims, embeddingQueryPrefix });
    const docs = writeDocs(join(tempDir("docify-src-"), "lib"), { "a.md": "# Lib\n\n## Open a database\n\nUse sqlite to open a file.\n" });
    d.addSource({ library: "lib", version: "1", kind: "local", locator: docs });
    const controller = new AbortController();
    const started = performance.now();
    const pending = d.prepare("lib@1", { graphRunner: fakeGraph, signal: controller.signal }).catch((e) => e);
    // Abort once the server holds the request.
    while (srv.calls.length === 0) await Bun.sleep(10);
    controller.abort();
    const err = await pending;
    expect(err?.code).toBe("cancelled");
    expect(performance.now() - started).toBeLessThan(2000);
    const gen = d.db.query<{ status: string; error: string }, []>("SELECT status, error FROM generations ORDER BY id DESC LIMIT 1").get()!;
    expect(gen).toEqual({ status: "failed", error: "preparation cancelled" });
    d.close();
  } finally {
    srv.stop();
  }
});

test("generations prepared through an openai server record the openai provider", async () => {
  const srv = fakeOpenAI();
  const home = tempDir();
  homes.push(home);
  try {
    const { embeddingProvider, embeddingBaseUrlEnv, embeddingApiKeyEnv, embeddingModel, embeddingDims, embeddingQueryPrefix } = openaiConfig(srv.base);
    const d = newDocify(home, { embeddingProvider, embeddingBaseUrlEnv, embeddingApiKeyEnv, embeddingModel, embeddingDims, embeddingQueryPrefix });
    const docs = writeDocs(join(tempDir("docify-src-"), "lib"), { "a.md": "# Lib\n\n## Open a database\n\nUse sqlite to open a file.\n" });
    d.addSource({ library: "lib", version: "1", kind: "local", locator: docs });
    await d.prepare("lib@1", { graphRunner: fakeGraph });
    const active = d.db.query<{ active_generation: number }, []>("SELECT active_generation FROM sources").get()!.active_generation;
    expect(d.getGeneration(active)!.embedding_model).toBe("openai:text-embedding-3-small");
    expect(srv.calls.length).toBeGreaterThan(0);
    d.close();
  } finally {
    srv.stop();
  }
});

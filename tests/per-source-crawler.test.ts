import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { sources } from "../src/core/search.ts";
import { newDocify, tempDir } from "./helpers.ts";

const homes: string[] = [];
const home = () => {
  const dir = tempDir();
  homes.push(dir);
  return dir;
};
const page = "<html><body><h1>Guide</h1><p>Useful documentation text.</p></body></html>";
const url = "http://docs.test/docs/";
let renders = 0;
const service = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname === "/api/embed") {
      const { input } = await req.json() as { input: string[] };
      return Response.json({ embeddings: input.map(() => [1, 2, 3, 4]) });
    }
    const path = new URL(req.url).pathname;
    if (path !== "/crawl" && path !== "/crawl/stream") return new Response("not found", { status: 404 });
    const { urls } = await req.json() as { urls: string[] };
    renders++;
    const result = { url: urls[0], html: page, success: true, status_code: 200, redirected_url: urls[0] };
    return path === "/crawl/stream" ? new Response(`${JSON.stringify(result)}\n${JSON.stringify({ status: "completed" })}`) : Response.json({ success: true, results: [result] });
  },
});
const serviceUrl = `http://127.0.0.1:${service.port}`;
const config = { crawl4aiUrl: serviceUrl, embeddingProvider: "ollama" as const, embeddingUrl: serviceUrl, embeddingModel: "test", embeddingDims: 4, embeddingQueryPrefix: "" };
const fetcher = async (input: string | URL | Request) => {
  const target = String(input);
  return target === url ? new Response(page, { headers: { "content-type": "text/html" } }) : new Response("not found", { status: 404 });
};
afterAll(() => {
  service.stop(true);
  homes.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

test("source overrides and legacy sources report their effective provider", () => {
  const d = newDocify(home(), { ...config, crawlProvider: "crawl4ai" });
  try {
    d.addSource({ library: "legacy", kind: "url", locator: url });
    d.addSource({ library: "explicit", kind: "url", locator: url, crawlProvider: "builtin" });
    d.addSource({ library: "local", kind: "local", locator: tempDir() });
    const all = sources(d);
    expect(all.find((s) => s.id === "legacy@unknown")).toMatchObject({ crawlProvider: null, effectiveCrawlProvider: "crawl4ai" });
    expect(all.find((s) => s.id === "explicit@unknown")).toMatchObject({ crawlProvider: "builtin", effectiveCrawlProvider: "builtin" });
    expect(all.find((s) => s.id === "local@unknown")).toMatchObject({ crawlProvider: null, effectiveCrawlProvider: null });
  } finally { d.close(); }
});

test("updates preserve crawl limits and unknown options, and null restores inheritance", () => {
  const d = newDocify(home(), { ...config, crawlProvider: "crawl4ai" });
  try {
    const id = d.addSource({ library: "web", kind: "url", locator: url, crawl: { maxDepth: 2, maxPages: 7 }, crawlProvider: "builtin" }).id;
    d.db.run("UPDATE sources SET options = ? WHERE id = ?", [JSON.stringify({ crawl: { maxDepth: 2, maxPages: 7 }, crawlProvider: "builtin", future: { value: 42 } }), id]);
    d.updateSourceCrawler(id, "browserless");
    expect(JSON.parse(d.getSource(id)!.options)).toEqual({ crawl: { maxDepth: 2, maxPages: 7 }, crawlProvider: "browserless", future: { value: 42 } });
    d.updateSourceCrawler(id, null);
    expect(JSON.parse(d.getSource(id)!.options)).toEqual({ crawl: { maxDepth: 2, maxPages: 7 }, future: { value: 42 } });
    expect(sources(d).find((s) => s.id === id)).toMatchObject({ crawlProvider: null, effectiveCrawlProvider: "crawl4ai" });
  } finally { d.close(); }
});

test("Crawl4AI settings replace only their own options and reject invalid values", () => {
  const d = newDocify(home(), config);
  try {
    const id = d.addSource({ library: "web", kind: "url", locator: url, crawlProvider: "crawl4ai", crawl: { maxDepth: 0 } }).id;
    d.updateSourceCrawler(id, undefined, { stream: true, waitUntil: "networkidle", delayBeforeReturnHtml: 0 });
    expect(sources(d).find((s) => s.id === id)?.crawl4ai).toEqual({ stream: true, waitUntil: "networkidle", delayBeforeReturnHtml: 0 });
    d.updateSourceCrawler(id, undefined, { scanFullPage: false });
    expect(JSON.parse(d.requireSource(id).options)).toEqual({ crawl: { maxDepth: 0 }, crawlProvider: "crawl4ai", crawl4ai: { scanFullPage: false } });
    for (const invalid of [{ stream: "yes" }, { waitUntil: "unknown" }, { delayBeforeReturnHtml: -1 }, { extra: true }]) {
      expect(() => d.updateSourceCrawler(id, undefined, invalid)).toThrow();
    }
  } finally { d.close(); }
});

test("Crawl4AI transport is selected independently for each source", async () => {
  const d = newDocify(home(), config);
  try {
    const regular = d.addSource({ library: "regular", kind: "url", locator: url, crawlProvider: "crawl4ai", crawl: { maxDepth: 0 } }).id;
    const streaming = d.addSource({ library: "streaming", kind: "url", locator: url, crawlProvider: "crawl4ai", crawl: { maxDepth: 0 } }).id;
    d.updateSourceCrawler(streaming, undefined, { stream: true });
    expect((await d.prepare(regular, { graph: false })).status).toBe("activated");
    expect((await d.prepare(streaming, { graph: false })).status).toBe("activated");
    expect(sources(d).find(s => s.id === regular)?.crawl4ai).toEqual({});
    expect(sources(d).find(s => s.id === streaming)?.crawl4ai).toEqual({ stream: true });
  } finally { d.close(); }
});

test("provider validation rejects invalid values, local sources and missing sources", () => {
  const d = newDocify(home(), config);
  try {
    const local = tempDir();
    for (const provider of ["invalid", "", 42, null]) {
      expect(() => d.addSource({ library: "bad", kind: "url", locator: url, crawlProvider: provider as never })).toThrow();
    }
    expect(() => d.addSource({ library: "local", kind: "local", locator: local, crawlProvider: "builtin" })).toThrow();
    d.addSource({ library: "local", kind: "local", locator: local });
    d.addSource({ library: "web", kind: "url", locator: url });
    expect(() => d.updateSourceCrawler("local@unknown", "builtin")).toThrow();
    expect(() => d.updateSourceCrawler("local@unknown", null)).toThrow();
    expect(() => d.updateSourceCrawler("missing", "builtin")).toThrow();
    for (const provider of ["invalid", "", 42, undefined]) {
      expect(() => d.updateSourceCrawler("web@unknown", provider as never)).toThrow();
    }
  } finally { d.close(); }
});

test("updating a source with a live lease is rejected without changing its options", () => {
  const d = newDocify(home(), config);
  try {
    const id = d.addSource({ library: "web", kind: "url", locator: url, crawlProvider: "builtin" }).id;
    const before = d.getSource(id)!.options;
    d.db.run("UPDATE sources SET lock_pid = ?, lock_at = ? WHERE id = ?", [process.pid, new Date().toISOString(), id]);
    expect(() => d.updateSourceCrawler(id, "crawl4ai")).toThrow(/prepar|busy/i);
    expect(d.getSource(id)!.options).toBe(before);
  } finally { d.close(); }
});

test("prepare selects each source provider and rebuilds identical content after a provider change", async () => {
  const d = newDocify(home(), { ...config, crawlProvider: "crawl4ai" });
  try {
    const id = d.addSource({ library: "web", kind: "url", locator: url, crawl: { maxDepth: 0 }, crawlProvider: "builtin" }).id;
    const initialRenders = renders;
    const first = await d.prepare(id, { graph: false, fetcher });
    expect(first.status).toBe("activated");
    expect(first.stats.collector).toBe("builtin");
    expect(renders).toBe(initialRenders);
    const unchanged = await d.prepare(id, { graph: false, fetcher });
    expect(unchanged.status).toBe("unchanged");
    d.updateSourceCrawler(id, null);
    const changed = await d.prepare(id, { graph: false, fetcher });
    expect(changed.status).toBe("activated");
    expect(changed.generationId).not.toBe(first.generationId);
    expect(changed.stats.collector).toBe("crawl4ai");
    expect(renders).toBeGreaterThan(initialRenders);
    expect((await d.prepare(id, { graph: false, fetcher })).status).toBe("unchanged");
  } finally { d.close(); }
});

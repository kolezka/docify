import { test, expect, afterAll, beforeEach } from "bun:test";
import { rmSync } from "node:fs";
import { crawl, DEFAULT_LIMITS } from "../src/core/collect.ts";
import { crawl4aiFetcher } from "../src/core/crawl4ai.ts";
import { defaultConfig, validateConfigPatch, ConfigError } from "../src/core/config.ts";
import { search } from "../src/core/search.ts";
import { newDocify, tempDir, writeDocs } from "./helpers.ts";

// A stand-in for the Crawl4AI Docker server: POST /crawl renders one URL of a site that does not
// exist on the network (docs.test), so any page Docify gets must have come through the service.
const KEY = "c4ai-secret-token-123";
const SITE = "http://docs.test/docs/";
const page = (title: string, body: string) => `<html><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const pages: Record<string, { html: string; status?: number; redirect?: string; success?: boolean; error?: string }> = {
  "http://docs.test/docs/": {
    html: page(
      "Index",
      `<p>Start.</p><a href="guide.html">guide</a><a href="/other/x.html">out of path</a><a href="https://elsewhere.test/docs/y.html">off origin</a>
       <a href="redir-out.html">redir out</a><a href="redir-in.html">redir in</a><a href="missing.html">missing</a><a href="big.html">big</a>`,
    ),
  },
  "http://docs.test/docs/guide.html": { html: page("Guide", `<h2 id="falcon-option">Falcon option</h2><p>The falconDive option is rendered by JavaScript.</p>`) },
  "http://docs.test/docs/redir-out.html": { html: page("Secret", "<p>must not be collected</p>"), redirect: "http://docs.test/other/secret.html" },
  "http://docs.test/docs/redir-in.html": { html: page("Moved", "<p>Moved page.</p>"), redirect: "http://docs.test/docs/moved.html" },
  "http://docs.test/docs/missing.html": { html: "", success: false, status: 404, error: "404" },
  "http://docs.test/docs/big.html": { html: page("Big", "<p>" + "x".repeat(20_000) + "</p>") },
};

type Mode = "ok" | "not-json" | "top-failure" | "no-results" | "two-results" | "no-html" | "html-number" | "wrong-url" | "http-500" | "http-401" | "slow" | "render-error" | "huge";
let mode: Mode = "ok";
let requests: { auth: string | null; body: any }[] = [];
// Indexes into `requests` whose HTTP request was aborted by the client. Not reset between tests:
// a server notices a disconnect late, so the index identifies the request instead.
let totalRequests = 0;
const abortedRequests = new Set<number>();

const service = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/crawl") return new Response("not found", { status: 404 });
    const body = await req.json();
    requests.push({ auth: req.headers.get("authorization"), body });
    const index = totalRequests++;
    const target: string = body.urls[0];
    const p = pages[target];
    const result = p
      ? { url: target, html: p.html, cleaned_html: p.html, success: p.success ?? true, status_code: p.status ?? 200, redirected_url: p.redirect ?? target, error_message: p.error ?? "" }
      : { url: target, html: "", success: false, status_code: 404, redirected_url: target, error_message: "404" };
    const json = (v: unknown, status = 200) => Response.json(v, { status });
    switch (mode) {
      case "not-json":
        return new Response("<html>gateway</html>", { headers: { "content-type": "text/html" } });
      case "top-failure":
        return json({ success: false, results: [result] });
      case "no-results":
        return json({ success: true });
      case "two-results":
        return json({ success: true, results: [result, result] });
      case "no-html": {
        const { html: _html, ...rest } = result;
        return json({ success: true, results: [rest] });
      }
      case "html-number":
        return json({ success: true, results: [{ ...result, html: 42 }] });
      case "wrong-url":
        return json({ success: true, results: [{ ...result, url: "http://docs.test/other/x.html" }] });
      case "http-500":
        return json({ detail: "browser pool exhausted" }, 500);
      case "http-401":
        return json({ detail: `invalid token ${req.headers.get("authorization")}` }, 401);
      case "render-error":
        return json({ success: true, results: [{ ...result, success: false, status_code: null, error_message: "net::ERR_NAME_NOT_RESOLVED" }] });
      case "huge":
        return json({ success: true, results: [{ ...result, html: "y".repeat(2_000_000) }] });
      case "slow":
        return new Promise<Response>((resolve) => {
          const t = setTimeout(() => resolve(json({ success: true, results: [result] })), 3000);
          req.signal.addEventListener("abort", () => {
            abortedRequests.add(index);
            clearTimeout(t);
          });
        });
    }
    return json({ success: true, results: [result], server_processing_time_s: 0.1 });
  },
});
const serviceUrl = `http://127.0.0.1:${service.port}`;
const homes: string[] = [];
const home = () => {
  const h = tempDir();
  homes.push(h);
  return h;
};
process.env.DOCIFY_TEST_C4AI_KEY = KEY;
const c4ai = { crawlProvider: "crawl4ai", crawl4aiUrl: serviceUrl, crawl4aiApiKeyEnv: "DOCIFY_TEST_C4AI_KEY", crawl4aiTimeoutSeconds: 5 };

beforeEach(() => {
  mode = "ok";
  requests = [];
});
afterAll(() => {
  service.stop(true);
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

const fetcher = (extra: Partial<Parameters<typeof crawl4aiFetcher>[0]> = {}) =>
  crawl4aiFetcher({ url: serviceUrl, apiKey: KEY, apiKeyEnv: "DOCIFY_TEST_C4AI_KEY", timeoutMs: 5000, maxBytesPerPage: 10_000, ...extra });

test("the built-in crawler stays the default", () => {
  const c = defaultConfig("/tmp/x", {});
  expect(c.crawlProvider).toBe("builtin");
  expect(c.crawl4aiUrl).toBe("http://127.0.0.1:11235");
  expect(c.crawl4aiApiKeyEnv).toBe("CRAWL4AI_API_KEY");
});

test("a URL source prepared with crawlProvider crawl4ai is rendered by the service and keeps Docify's scope", async () => {
  const d = newDocify(home(), c4ai);
  d.addSource({ library: "js", version: null, kind: "url", locator: SITE, crawl: { maxDepth: 1, maxBytesPerPage: 10_000 } });
  const r = await d.prepare("js@unknown", { graph: false });
  expect(r.status).toBe("activated");
  const asked = requests.map((q) => q.body.urls[0] as string);
  expect(requests.every((q) => q.auth === `Bearer ${KEY}`)).toBe(true);
  expect(requests.every((q) => q.body.urls.length === 1)).toBe(true);
  expect(requests[0]!.body.browser_config).toEqual({ type: "BrowserConfig", params: { headless: true } });
  expect(requests[0]!.body.crawler_config.type).toBe("CrawlerRunConfig");
  expect(requests[0]!.body.crawler_config.params.cache_mode).toBe("bypass");
  // Out-of-scope links are never sent to the service, and an in-scope redirect is not rendered twice.
  expect(asked.some((u) => u.includes("/other/") || u.includes("elsewhere.test"))).toBe(false);
  expect(asked.filter((u) => u.endsWith("moved.html")).length).toBe(0);
  // No .md export probes through the browser.
  expect(asked.some((u) => u.endsWith(".md"))).toBe(false);
  const hit = await search(d, { query: "falconDive rendered", library: "js" });
  expect(hit.hits[0]!.citation.url).toBe(`${SITE}guide.html#falcon-option`);
  const all = await search(d, { query: "must not be collected", library: "js", mode: "lexical" });
  expect(all.hits.length).toBe(0);
  const moved = await search(d, { query: "Moved page", library: "js", mode: "lexical" });
  expect(moved.hits[0]?.citation.url).toStartWith(`${SITE}moved.html`);
  expect(r.stats.collector).toBe("crawl4ai");
  d.close();
});

test("service failures fail the prepare and leave the previous generation active", async () => {
  const d = newDocify(home(), c4ai);
  d.addSource({ library: "js", version: null, kind: "url", locator: SITE, crawl: { maxDepth: 0 } });
  const first = await d.prepare("js@unknown", { graph: false });
  mode = "http-500";
  await expect(d.prepare("js@unknown", { graph: false, force: true })).rejects.toThrow(/HTTP 500/);
  const src = d.getSource("js@unknown")!;
  expect(src.active_generation).toBe(first.generationId);
  d.close();
});

test("malformed or incomplete service responses are errors, never an empty success", async () => {
  const cases: [Mode, RegExp][] = [
    ["not-json", /not JSON/],
    ["top-failure", /reported failure/],
    ["no-results", /exactly one result/],
    ["two-results", /exactly one result/],
    ["no-html", /has no html/],
    ["html-number", /has no html/],
    ["wrong-url", /another URL/],
    ["render-error", /could not render.*ERR_NAME_NOT_RESOLVED/],
    ["huge", /larger than/],
  ];
  for (const [m, re] of cases) {
    mode = m;
    await expect(crawl(SITE, { ...DEFAULT_LIMITS, maxDepth: 0 }, fetcher(), { markdownExports: false })).rejects.toThrow(re);
  }
});

test("a page the site refuses is skipped below the start page and fatal at the start page", async () => {
  const docs = await crawl(SITE, { ...DEFAULT_LIMITS, maxDepth: 1, maxBytesPerPage: 10_000 }, fetcher(), { markdownExports: false });
  const paths = docs.map((x) => x.path).sort();
  expect(paths).toEqual(["guide.html", "index.html", "moved.html"]);
  await expect(crawl("http://docs.test/docs/missing.html", DEFAULT_LIMITS, fetcher(), { markdownExports: false })).rejects.toThrow(/HTTP 404/);
});

test("maxPages bounds the number of renders", async () => {
  await crawl(SITE, { ...DEFAULT_LIMITS, maxPages: 2 }, fetcher(), { markdownExports: false });
  expect(requests.length).toBe(2);
});

test("the API key never appears in errors", async () => {
  mode = "http-401";
  let message = "";
  try {
    await crawl(SITE, DEFAULT_LIMITS, fetcher(), { markdownExports: false });
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message).toMatch(/HTTP 401.*DOCIFY_TEST_C4AI_KEY/);
  expect(message).not.toContain(KEY);
});

test("a slow service times out and the request is aborted", async () => {
  mode = "slow";
  await expect(crawl(SITE, DEFAULT_LIMITS, fetcher({ timeoutMs: 200 }), { markdownExports: false })).rejects.toThrow(/timed out after 200 ms/);
});

test("cancelling a prepare aborts the in-flight render and keeps the previous generation", async () => {
  const d = newDocify(home(), c4ai);
  d.addSource({ library: "js", version: null, kind: "url", locator: SITE, crawl: { maxDepth: 0 } });
  const first = await d.prepare("js@unknown", { graph: false });
  mode = "slow";
  const ac = new AbortController();
  const started = Date.now();
  const index = totalRequests;
  setTimeout(() => ac.abort(), 150);
  const err = await d.prepare("js@unknown", { graph: false, force: true, signal: ac.signal }).catch((e) => e);
  expect((err as { code?: string }).code).toBe("cancelled");
  expect(Date.now() - started).toBeLessThan(2500);
  await Bun.sleep(50);
  expect(abortedRequests.has(index)).toBe(true);
  expect(d.getSource("js@unknown")!.active_generation).toBe(first.generationId);
  d.close();
});

test("local sources never call the service", async () => {
  const d = newDocify(home(), c4ai);
  const dir = writeDocs(tempDir("docify-src-"), { "a.md": "# A\n\nLocal heron text.\n" });
  homes.push(dir);
  d.addSource({ library: "loc", version: null, kind: "local", locator: dir });
  await d.prepare("loc@unknown", { graph: false });
  expect(requests.length).toBe(0);
  d.close();
});

test("config accepts the provider settings and rejects credentials in the service URL", () => {
  expect(validateConfigPatch({ crawlProvider: "crawl4ai", crawl4aiUrl: "http://10.0.0.5:11235/", crawl4aiApiKeyEnv: "MY_TOKEN", crawl4aiTimeoutSeconds: 60 })).toEqual({
    crawlProvider: "crawl4ai",
    crawl4aiUrl: "http://10.0.0.5:11235",
    crawl4aiApiKeyEnv: "MY_TOKEN",
    crawl4aiTimeoutSeconds: 60,
  });
  expect(() => validateConfigPatch({ crawlProvider: "playwright" })).toThrow(ConfigError);
  expect(() => validateConfigPatch({ crawl4aiUrl: "http://user:pw@127.0.0.1:11235" })).toThrow(/credentials/);
  expect(() => validateConfigPatch({ crawl4aiApiKeyEnv: "abc def" })).toThrow(/environment variable name/);
  expect(() => crawl4aiFetcher({ url: "http://u:p@127.0.0.1:1", apiKey: undefined, apiKeyEnv: "X", timeoutMs: 1, maxBytesPerPage: 1 })).toThrow(/credentials/);
});

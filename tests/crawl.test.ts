import { test, expect, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { crawl, DEFAULT_LIMITS } from "../src/core/collect.ts";
import { search } from "../src/core/search.ts";
import { newDocify, tempDir } from "./helpers.ts";

const page = (title: string, body: string) => `<html><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    const html = (s: string) => new Response(s, { headers: { "content-type": "text/html" } });
    switch (url.pathname) {
      case "/docs/":
        return html(
          page(
            "Index",
            `<p>Start.</p><a href="guide.html">guide</a><a href="/other/x.html">out of path</a><a href="https://example.com/docs/y.html">off origin</a>
             <a href="redir-out.html">redir out</a><a href="redir-in.html">redir in</a><a href="big.html">big</a><a href="deep1.html">deep</a>`,
          ),
        );
      case "/docs/guide.html":
        return html(page("Guide", `<h2 id="kestrel-option">Kestrel option<a class="headerlink" href="#kestrel-option">¶</a></h2><p>The kestrelSpeed option sets hover speed.</p>`));
      case "/docs/redir-out.html":
        return new Response(null, { status: 302, headers: { location: "/other/secret.html" } });
      case "/docs/redir-in.html":
        return new Response(null, { status: 301, headers: { location: "/docs/moved.html" } });
      case "/docs/moved.html":
        return html(page("Moved", "<p>Moved page.</p>"));
      case "/docs/big.html":
        return html(page("Big", "<p>" + "x".repeat(20_000) + "</p>"));
      case "/docs/deep1.html":
        return html(page("Deep1", `<a href="deep2.html">next</a>`));
      case "/docs/deep2.html":
        return html(page("Deep2", `<a href="deep3.html">next</a>`));
      case "/docs/deep3.html":
        return html(page("Deep3", "<p>too deep</p>"));
      case "/other/x.html":
      case "/other/secret.html":
        return html(page("Outside", "<p>must not be crawled</p>"));
    }
    return new Response("nope", { status: 404 });
  },
});
const base = `http://127.0.0.1:${server.port}/docs/`;
const home = tempDir();
afterAll(() => {
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
});

test("crawl stays inside origin and path, follows only in-scope redirects and respects limits", async () => {
  const docs = await crawl(base, { ...DEFAULT_LIMITS, maxDepth: 2, maxBytesPerPage: 10_000 });
  const paths = docs.map((d) => d.path).sort();
  expect(paths).toContain("index.html");
  expect(paths).toContain("guide.html");
  expect(paths).toContain("moved.html");
  expect(paths).toContain("deep2.html");
  expect(paths).not.toContain("deep3.html");
  expect(paths).not.toContain("big.html");
  expect(docs.every((d) => d.url!.startsWith(base))).toBe(true);
  expect(docs.some((d) => new TextDecoder().decode(d.bytes).includes("must not be crawled"))).toBe(false);
  const few = await crawl(base, { ...DEFAULT_LIMITS, maxPages: 2 });
  expect(few.length).toBe(2);
});

test("a crawled source prepares and cites url#anchor", async () => {
  const d = newDocify(home);
  d.addSource({ library: "web", version: null, kind: "url", locator: base, crawl: { maxDepth: 1 } });
  await d.prepare("web@unknown", { graph: false });
  const r = await search(d, { query: "kestrelSpeed hover", library: "web" });
  expect(r.hits[0]!.citation.url).toBe(`${base}guide.html#kestrel-option`);
  expect(r.hits[0]!.citation.version).toBeNull();
  expect(r.text).toContain("web@unknown");
  d.close();
});

import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { crawl, DEFAULT_LIMITS } from "../src/core/collect.ts";
import { crawl4aiFetcher } from "../src/core/crawl4ai.ts";
import { newDocify, tempDir } from "./helpers.ts";

const root = "https://docs.test/docs/";
const valid = (url: string, html = "<h1>Valid page</h1>") => ({ url, html, success: true, status_code: 200, redirected_url: url });
const limits = { ...DEFAULT_LIMITS, maxDepth: 1 };
const adapter = (result: (url: string) => Record<string, unknown>) => crawl4aiFetcher({
  url: "http://127.0.0.1:11235", apiKey: undefined, apiKeyEnv: "CRAWL4AI_API_KEY", timeoutMs: 1000, maxBytesPerPage: 10_000,
  fetchImpl: (async (_url, init) => {
    const target = JSON.parse(String(init?.body)).urls[0];
    return Response.json({ success: true, results: [result(target)] });
  }) as typeof fetch,
});

for (const [name, patch, diagnostic] of [
  ["missing success", { success: undefined, status_code: 404 }, /invalid success/],
  ["malformed success", { success: "false", status_code: 404 }, /invalid success/],
  ["missing html on a site error", { success: false, status_code: 404, html: undefined }, /has no html/],
  ["malformed redirect", { redirected_url: 42 }, /invalid redirected_url/],
  ["malformed status", { status_code: "200" }, /invalid status_code/],
] as const) {
  test(`Crawl4AI rejects ${name} instead of dropping or misattributing a page`, async () => {
    const control = await crawl(root, limits, adapter((url) => valid(url)), { markdownExports: false });
    expect(control[0]?.kind).toBe("html");
    expect(new TextDecoder().decode(control[0]?.bytes)).toContain("Valid page");
    await expect(crawl(root, limits, adapter((url) => url === root
      ? valid(url, '<h1>Index</h1><a href="child.html">Child</a>')
      : { ...valid(url), ...patch }), { markdownExports: false })).rejects.toThrow(diagnostic);
  });
}

for (const filename of ["llms.txt", "overview.md"]) {
  test(`Crawl4AI preserves Markdown links and entities from browser-rendered ${filename}`, async () => {
    const docs = await crawl(root + filename, limits, adapter((url) => valid(url, url.endsWith(filename)
      ? '<html><body><pre># Docs\n\n[Guide](guide.md)\n\nUse &lt;T&gt; &amp; examples.</pre></body></html>'
      : '<html><body><pre># Guide\n\nMeaningful guide text.</pre></body></html>')), { markdownExports: false });
    expect(docs.map((d) => d.path)).toEqual([filename, "guide.md"]);
    expect(docs.every((d) => d.kind === "markdown")).toBe(true);
    expect(new TextDecoder().decode(docs[0]!.bytes)).toContain("Use <T> & examples.");
    expect(new TextDecoder().decode(docs[1]!.bytes)).toContain("Meaningful guide text.");
  });
}

test("malformed child metadata fails prepare and preserves the complete active generation", async () => {
  let malformed = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const { urls } = await req.json();
    const url = urls[0] as string;
    const result: Record<string, unknown> = valid(url, url === root
      ? '<h1>Index</h1><a href="child.html">Child</a>' : '<h1>Child</h1><p>Previously indexed evidence.</p>');
    if (malformed && url !== root) { delete result.success; result.status_code = 404; }
    return Response.json({ success: true, results: [result] });
  } });
  const home = tempDir();
  const d = newDocify(home, { crawlProvider: "crawl4ai", crawl4aiUrl: server.url.origin });
  try {
    d.addSource({ library: "strict", kind: "url", locator: root });
    const first = await d.prepare("strict@unknown", { graph: false });
    expect(first.stats.documents).toBe(2);
    malformed = true;
    await expect(d.prepare("strict@unknown", { graph: false, force: true })).rejects.toThrow(/invalid success/);
    expect(d.getSource("strict@unknown")?.active_generation).toBe(first.generationId);
    expect(d.generations("strict@unknown")[0]?.status).toBe("failed");
  } finally {
    d.close(); server.stop(true); rmSync(home, { recursive: true, force: true });
  }
});

import { test, expect } from "bun:test";
import { crawl, DEFAULT_LIMITS, type Fetcher } from "../src/core/collect.ts";

const base = "https://docs.example.test/docs/";
const markdown = "# Example docs\n\nDocumentation for the kestrelSpeed setting.\n";

for (const name of ["llm.txt", "llms.txt"]) {
  test(`crawl reads ${name} served as plain text as Markdown`, async () => {
    const fetcher: Fetcher = async () => new Response(markdown, { headers: { "content-type": "text/plain; charset=utf-8" } });
    const docs = await crawl(base + name, DEFAULT_LIMITS, fetcher);
    expect(docs.map(({ path, kind, url }) => ({ path, kind, url }))).toEqual([
      { path: name, kind: "markdown", url: base + name },
    ]);
    expect(new TextDecoder().decode(docs[0]!.bytes)).toBe(markdown);
  });
}

test("crawl follows Markdown index links including extensionless documentation pages", async () => {
  const index = `# Example\n- [Guide](guide.md)\n- [Setup](setup)\n- [HTML](usage.html)\n- [Titled](<options.md> "Options")\n`;
  const fetcher: Fetcher = async (url) => {
    const path = new URL(url).pathname;
    return new Response(path.endsWith("llms.txt") ? index : markdown, {
      headers: { "content-type": path.endsWith("llms.txt") ? "text/plain" : "text/markdown" },
    });
  };
  const docs = await crawl(base + "llms.txt", DEFAULT_LIMITS, fetcher);
  expect(docs.map((d) => d.path)).toEqual(["llms.txt", "guide.md", "setup", "usage.html", "options.md"]);
  expect(new TextDecoder().decode(docs[1]!.bytes)).toContain("kestrelSpeed");
});

test("Markdown index crawling keeps scope, redirect, deduplication and asset guards", async () => {
  const requested: string[] = [];
  const index = `# Example
- [Guide](guide.md#first)
- [Same guide](guide.md?view=all#second)
- [Outside path](/other/private.md)
- [Outside origin](https://other.example.test/docs/private.md)
- [Redirect](redirect.md)
- [Image](logo.png)
- [Self](llm.txt#top)
- [Invalid](http://[)
`;
  const fetcher: Fetcher = async (url) => {
    requested.push(url);
    if (url === base + "llm.txt") return new Response(index, { headers: { "content-type": "text/plain" } });
    if (url === base + "redirect.md") return new Response(null, { status: 302, headers: { location: "/other/private.md" } });
    return new Response(markdown, { headers: { "content-type": "text/markdown" } });
  };
  const docs = await crawl(base + "llm.txt", DEFAULT_LIMITS, fetcher);
  expect(docs.map((d) => d.path)).toEqual(["llm.txt", "guide.md"]);
  expect(requested).toEqual([base + "llm.txt", base + "guide.md#first", base + "redirect.md"]);
});

test("Markdown indexes honor page, depth and byte limits", async () => {
  const index = "# Example\n[One](one.md)\n[Two](two.md)\n";
  const fetcher: Fetcher = async (url) => new Response(url.endsWith("llms.txt") ? index : markdown, {
    headers: { "content-type": url.endsWith("llms.txt") ? "text/plain" : "text/markdown" },
  });
  const shallow = await crawl(base + "llms.txt", { ...DEFAULT_LIMITS, maxDepth: 0 }, fetcher);
  expect(shallow.map((d) => d.path)).toEqual(["llms.txt"]);
  const capped = await crawl(base + "llms.txt", { ...DEFAULT_LIMITS, maxPages: 2 }, fetcher);
  expect(capped.map((d) => d.path)).toEqual(["llms.txt", "one.md"]);
  await expect(crawl(base + "llms.txt", { ...DEFAULT_LIMITS, maxBytesPerPage: 5 }, fetcher)).rejects.toThrow("no documents fetched");
  await expect(crawl(base + "llms.txt", { ...DEFAULT_LIMITS, maxTotalBytes: index.length }, fetcher)).rejects.toThrow("crawl exceeded");
});

test("ordinary plain text URLs remain unsupported", async () => {
  const fetcher: Fetcher = async () => new Response(markdown, { headers: { "content-type": "text/plain" } });
  await expect(crawl(base + "notes.txt", DEFAULT_LIMITS, fetcher)).rejects.toThrow("no documents fetched");
});

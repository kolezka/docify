import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { crawl, DEFAULT_LIMITS, type Fetcher } from "../src/core/collect.ts";
import { newDocify, tempDir } from "./helpers.ts";

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

// A route can be a page and the parent of other pages, and two routes can differ only by a
// trailing slash or by case. Each page still needs its own preserved file.
test("every crawled page keeps its own snapshot files whatever its route looks like", async () => {
  const pages: Record<string, string> = {
    automation: "# Automation\n\nThe overview page mentions the heron.\n",
    "automation/": "# Automation slash\n\nThe trailing slash twin mentions the osprey.\n",
    "automation/cron-jobs": "# Cron jobs\n\nThe cron page mentions the kestrel.\n",
    "automation/cron-jobs/gmail": "# Gmail\n\nThe gmail page mentions the plover.\n",
    API: "# API upper\n\nThe upper case route mentions the bittern.\n",
    api: "# API lower\n\nThe lower case route mentions the curlew.\n",
  };
  const index = "# Docs\n" + Object.keys(pages).map((p) => `- [${p}](${p})`).join("\n") + "\n";
  const fetcher: Fetcher = async (url) => {
    const path = url.slice(base.length);
    const body = path === "llms.txt" ? index : pages[path];
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body, { headers: { "content-type": "text/markdown" } });
  };
  const d = newDocify(tempDir());
  d.addSource({ library: "routes", version: null, kind: "url", locator: base + "llms.txt" });
  const result = await d.prepare("routes@unknown", { graph: false, fetcher });
  expect(result.status).toBe("activated");

  const rows = d.db
    .query<{ path: string; raw_file: string; normalized_file: string }, [number]>("SELECT path, raw_file, normalized_file FROM documents WHERE generation_id = ?")
    .all(result.generationId);
  expect(rows.map((r) => r.path).sort()).toEqual(["llms.txt", ...Object.keys(pages)].sort());
  for (const row of rows) {
    if (row.path === "llms.txt") continue;
    expect(readFileSync(row.raw_file, "utf8")).toBe(pages[row.path]!);
    expect(gunzipSync(readFileSync(row.normalized_file)).toString("utf8")).toContain(pages[row.path]!.split("mentions the ")[1]!.trim());
  }
  // Distinct even on a case-insensitive file system.
  expect(new Set(rows.map((r) => r.raw_file.toLowerCase())).size).toBe(rows.length);
  expect(new Set(rows.map((r) => r.normalized_file.toLowerCase())).size).toBe(rows.length);
  // Routes that clash with nothing keep their readable mirrored names.
  const gmail = rows.find((r) => r.path === "automation/cron-jobs/gmail")!;
  expect(gmail.raw_file.endsWith("/raw/automation/cron-jobs/gmail")).toBe(true);
  expect(gmail.normalized_file.endsWith("/normalized/automation/cron-jobs/gmail.md.gz")).toBe(true);
  d.close();
});

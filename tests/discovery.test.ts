import { expect, test } from "bun:test";
import { crawl, DEFAULT_LIMITS, type Fetcher } from "../src/core/collect.ts";

const base = "https://docs.example.test/design/";
const markdown = (text: string) => new Response(text, { headers: { "content-type": "text/markdown" } });

// Restricting Markdown traversal to llms.txt loses the section links in ordinary docs.
for (const entry of ["guide.md", "guide.mdx", "guide"]) {
  test(`ordinary Markdown at ${entry} discovers linked pages and preserves their content`, async () => {
    const pages: Record<string, string> = {
      [base + entry]: "# Guide\n[Foundations](Guide/foundations)\n[More](details.md)\n",
      [base + "Guide/foundations"]: "# Foundations\n\nUse accessible contrast.\n[Color](color)\n",
      [base + "details.md"]: "# Details\n\nKeep controls consistent.\n",
      [base + "Guide/color"]: "# Color\n\nAvoid conveying meaning through color alone.\n",
    };
    const fetcher: Fetcher = async (url) => pages[url] === undefined
      ? new Response("missing", { status: 404 }) : markdown(pages[url]!);
    const docs = await crawl(base + entry, DEFAULT_LIMITS, fetcher);
    expect(docs.map((d) => d.path)).toEqual([entry, "Guide/foundations", "details.md", "Guide/color"]);
    expect(new TextDecoder().decode(docs[3]!.bytes)).toContain("Avoid conveying meaning through color alone.");
  });
}

test("HTML discovers extensionless routes alongside a Markdown alternate", async () => {
  const fetcher: Fetcher = async (url) => {
    if (url === base + "guide") return new Response(`<html><head>
      <link rel="alternate" type="text/markdown" href="guide.md">
      </head><body><a href="Guide/foundations">Foundations</a></body></html>`, { headers: { "content-type": "text/html" } });
    if (url === base + "guide.md") return markdown("# Guide\n[Color](Guide/color)");
    if (url === base + "Guide/foundations") return markdown("# Foundations\nAccessible controls.");
    if (url === base + "Guide/color") return markdown("# Color\nUse semantic colors.");
    return new Response("missing", { status: 404 });
  };
  const docs = await crawl(base + "guide", DEFAULT_LIMITS, fetcher);
  expect(docs.map((d) => d.path)).toEqual(["guide", "guide.md", "Guide/foundations", "Guide/color"]);
  expect(new TextDecoder().decode(docs[3]!.bytes)).toContain("Use semantic colors.");
});

test("ordinary Markdown discovery keeps scope, asset, duplicate and redirect guards", async () => {
  const requested: string[] = [];
  const fetcher: Fetcher = async (url) => {
    requested.push(url);
    if (url === base + "guide.md") return markdown(`# Guide
[Child](child)
[Duplicate](child?view=all#top)
[Outside](/elsewhere/secret)
[Other origin](https://other.example.test/design/secret)
[Image](logo.png)
[Archive](download.zip)
![Image without extension](image)
[Redirect](redirect)
[Invalid](http://[)
`);
    if (url === base + "redirect") return new Response(null, { status: 302, headers: { location: "/elsewhere/secret" } });
    if (url === base + "child") return markdown("# Child\nSafe content.");
    return new Response("unexpected", { status: 500 });
  };
  const docs = await crawl(base + "guide.md", DEFAULT_LIMITS, fetcher);
  expect(docs.map((d) => d.path)).toEqual(["guide.md", "child"]);
  expect(new TextDecoder().decode(docs[1]!.bytes)).toContain("Safe content.");
  expect(requested).toEqual([base + "guide.md", base + "child.md", base + "child", base + "redirect.md", base + "redirect"]);
});

test("Markdown discovery prefers sibling Markdown representations before broken HTML routes", async () => {
  const fetcher: Fetcher = async (url) => {
    if (url === base + "guide.md") return markdown("# Guide\n[Accessibility](Guide/accessibility)\n");
    if (url === base + "Guide/accessibility.md") return markdown("# Accessibility\nMake controls perceivable and adaptable.\n");
    return new Response("<h1>Page not found</h1>", { headers: { "content-type": "text/html" } });
  };
  const docs = await crawl(base + "guide.md", DEFAULT_LIMITS, fetcher);
  expect(docs.map((d) => d.path)).toEqual(["guide.md", "Guide/accessibility.md"]);
  expect(new TextDecoder().decode(docs[1]!.bytes)).toContain("Make controls perceivable and adaptable.");
});

for (const response of ["missing", "html", "redirect", "json"]) {
  test(`Markdown preference falls back safely when the export is ${response}`, async () => {
    const requested: string[] = [];
    const fetcher: Fetcher = async (url) => {
      requested.push(url);
      if (url === base + "guide.md") return markdown("# Guide\n[Child](child)\n");
      if (url === base + "child.md") {
        if (response === "missing") return new Response("missing", { status: 404 });
        if (response === "json") return Response.json({ error: "no export" });
        if (response === "redirect") return new Response(null, { status: 302, headers: { location: "https://other.example.test/private.md" } });
        return new Response("<h1>Not Markdown</h1>", { headers: { "content-type": "text/html" } });
      }
      if (url === base + "child") return markdown("# Child\nFallback content remains available.");
      throw new Error(`unexpected request: ${url}`);
    };
    const docs = await crawl(base + "guide.md", DEFAULT_LIMITS, fetcher);
    expect(docs.map((d) => d.path)).toEqual(["guide.md", "child"]);
    expect(new TextDecoder().decode(docs[1]!.bytes)).toContain("Fallback content remains available.");
    expect(requested).toEqual([base + "guide.md", base + "child.md", base + "child"]);
  });
}

test("a Markdown export linked both explicitly and through its HTML route is collected once", async () => {
  const fetcher: Fetcher = async (url) => {
    if (url === base + "guide.md") return markdown("# Guide\n[Child](child)\n[Export](child.md)\n");
    if (url === base + "child.md") return markdown("# Child\nOne copy of this guidance.");
    throw new Error(`unexpected request: ${url}`);
  };
  const docs = await crawl(base + "guide.md", DEFAULT_LIMITS, fetcher);
  expect(docs.map((d) => d.path)).toEqual(["guide.md", "child.md"]);
});

test("HTML route discovery uses available Markdown even when HTML also links the route first", async () => {
  const fetcher: Fetcher = async (url) => {
    if (url === base + "guide") return new Response('<a href="child">Child</a><a href="guide.md">Markdown</a>', { headers: { "content-type": "text/html" } });
    if (url === base + "guide.md") return markdown("# Guide\n[Child](child)\n");
    if (url === base + "child.md") return markdown("# Child\nAccessible navigation.");
    return new Response("<h1>Page not found</h1>", { headers: { "content-type": "text/html" } });
  };
  const docs = await crawl(base + "guide", DEFAULT_LIMITS, fetcher);
  expect(docs.map((d) => d.path)).toEqual(["guide", "child.md", "guide.md"]);
  expect(new TextDecoder().decode(docs[1]!.bytes)).toContain("Accessible navigation.");
});

for (const failure of ["network", "redirect-loop"]) {
  test(`a guessed Markdown ${failure} failure does not abort a working linked route`, async () => {
    const fetcher: Fetcher = async (url) => {
      if (url === base + "guide.md") return markdown("# Guide\n[Child](child)\n");
      if (url === base + "child.md") {
        if (failure === "network") throw new TypeError("probe connection failed");
        return new Response(null, { status: 302, headers: { location: "child.md" } });
      }
      if (url === base + "child") return markdown("# Child\nThe linked page still works.");
      throw new Error(`unexpected request: ${url}`);
    };
    const docs = await crawl(base + "guide.md", DEFAULT_LIMITS, fetcher);
    expect(docs.map((d) => d.path)).toEqual(["guide.md", "child"]);
    expect(new TextDecoder().decode(docs[1]!.bytes)).toContain("The linked page still works.");
  });
}

test("ordinary Markdown discovery honors depth, page and byte limits", async () => {
  const index = "# Guide\n[One](one)\n[Two](two)\n";
  const child = "# Child\n[Deeper](deep/child)\n";
  const fetcher: Fetcher = async (url) => markdown(url === base + "guide.md" ? index : child);
  const run = (limits: Partial<typeof DEFAULT_LIMITS>) => crawl(base + "guide.md", { ...DEFAULT_LIMITS, ...limits }, fetcher);
  expect((await run({ maxDepth: 0 })).map((d) => d.path)).toEqual(["guide.md"]);
  expect((await run({ maxDepth: 1 })).map((d) => d.path)).toEqual(["guide.md", "one.md", "two.md"]);
  expect((await run({ maxPages: 2 })).map((d) => d.path)).toEqual(["guide.md", "one.md"]);
  await expect(run({ maxTotalBytes: index.length })).rejects.toThrow("crawl exceeded");
  await expect(run({ maxBytesPerPage: 5 })).rejects.toThrow("no documents fetched");
});

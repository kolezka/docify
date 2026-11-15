import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { crawl, DEFAULT_LIMITS, type Fetcher } from "../src/core/collect.ts";
import { lazyPageContent } from "../src/core/lazy-content.ts";
import { normalize } from "../src/core/normalize.ts";
import { search } from "../src/core/search.ts";
import { newDocify, tempDir } from "./helpers.ts";

// The shape samsungtizenos.com serves: the article is an empty placeholder, the text sits
// HTML-escaped in the wire:snapshot attribute of a component the browser loads later, and a
// sidebar many times larger than the text is on every page.
const attr = (value: unknown) => JSON.stringify(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
const sidebar = (links: string[]) => `<aside><ul>${links.map((l) => `<li><a href="${l}">${l} menu entry</a></li>`).join("")}${"<li>wagtail filler entry</li>".repeat(300)}</ul></aside>`;
const component = (data: unknown, memo: Record<string, unknown>, inner: string) =>
  `<div wire:key="k" wire:snapshot="${attr({ data, memo: { name: "documentation::article", ...memo }, checksum: "c" })}" wire:effects="[]" wire:name="documentation::article" x-init="$wire.__lazyLoad(&#039;eyJ4IjoxfQ==&#039;)">${inner}</div>`;
const skeleton = `<article>\n  <div class="skeleton"><span></span></div>\n  &nbsp;\n</article>`;
const livewirePage = (title: string, body: string, links: string[] = [], memo: Record<string, unknown> = { lazyLoaded: false }) =>
  `<html><head><title>${title} - Docs</title></head><body><main>${sidebar(links)}` +
  `<div wire:snapshot="${attr({ data: { open: true, label: "<p>menu</p>" }, memo: { name: "sidebar" } })}"></div>` +
  component({ markdown: [{ body, table_of_content: "<ul><li>short</li></ul>", title, raw: null }, { s: "arr" }], document: [null, { class: "Doc" }] }, memo, skeleton) +
  `</main></body></html>`;

// The same page after the browser loaded the component: the article shows the text, in the
// site's own wrappers and spacing, next to a short table of contents.
const loadedPage = (title: string, body: string, shown: string, links: string[] = []) =>
  livewirePage(title, body, links, { lazyLoaded: true }).replace(
    skeleton,
    `<article>\n  <div class="toc"><ul><li>On this page</li></ul></div>\n  <div class="prose">\n    ${shown.replace(/></g, ">\n    <")}\n  </div>\n</article>`,
  );

const contactsBody =
  `<h1 id="content-contacts"><a href="#content-contacts" class="heading-permalink" aria-hidden="true" title="Permalink">¶</a>Contacts</h1>` +
  `<p>Connect with <code>contacts_connect()</code> before reading the plover address book.</p>` +
  `<pre class="shiki"><code><span class="line"><span style="color:#D73A49">int</span> error = contacts_connect();</span></code></pre>` +
  `<h2 id="content-xml"><a href="#content-xml" class="heading-permalink">¶</a>XML</h2><p>Write &lt;contact&gt; &amp; close it; it's "quoted".</p>`;

test("a page whose article is empty is kept as the text its lazy component carries", () => {
  const page = livewirePage("Contacts", contactsBody, ["guides/other"]);
  const kept = lazyPageContent(page)!;
  expect(kept).toBe(`<!doctype html>\n<html><head><meta charset="utf-8"><title>Contacts - Docs</title></head><body>\n${contactsBody}\n</body></html>\n`);
  expect(kept.length).toBeLessThan(page.length / 5);

  // What the page gave before: the menu and nothing of the article.
  const before = normalize(page, "html").markdown;
  expect(before).toContain("menu entry");
  expect(before).not.toContain("contacts_connect");

  const doc = normalize(kept, "html");
  expect(doc.title).toBe("Contacts");
  expect(doc.markdown).not.toContain("menu entry");
  expect(doc.markdown).toContain("# Contacts\n");
  expect(doc.markdown).toContain("## XML\n");
  expect(doc.markdown).toContain("```\nint error = contacts_connect();\n```");
  // Entities of the article survive the attribute's own escaping.
  expect(doc.markdown).toContain(`Write <contact> & close it; it's "quoted".`);
});

test("the page is kept as it is unless a lazy component holds the HTML of its article", () => {
  const withText = livewirePage("Contacts", contactsBody).replace(skeleton, "<article><p>Rendered text.</p></article>");
  const cases: Record<string, string> = {
    "an ordinary page": `<html><body><main><article></article></main></body></html>`,
    "an article with text of its own": withText,
    "an empty article beside a component that has loaded": livewirePage("Contacts", contactsBody, [], { lazyLoaded: true }),
    "an article that shows other text than the component": loadedPage("Contacts", contactsBody, contactsBody.replace("plover", "petrel")),
    "an article the component is a small part of": loadedPage("Contacts", contactsBody, contactsBody + `<p>${"More of the article that no component carries. ".repeat(8)}</p>`),
    "a component that is not lazy": livewirePage("Contacts", contactsBody, [], {}),
    "a lazy component without HTML": `<html><body>${component({ title: "plain words, no markup", count: 3 }, { lazyLoaded: false }, skeleton)}</body></html>`,
    "no article element": livewirePage("Contacts", contactsBody).replace(skeleton, "<section></section>"),
    "a snapshot that is not JSON": livewirePage("Contacts", contactsBody).replace(/wire:snapshot="\{&quot;data&quot;:\{&quot;markdown/, 'wire:snapshot="{broken&quot;data&quot;:{&quot;markdown'),
  };
  for (const [what, page] of Object.entries(cases)) expect(lazyPageContent(page), what).toBeNull();
  // The same page with nothing changed is rewritten, so each case above fails for its own reason.
  expect(lazyPageContent(livewirePage("Contacts", contactsBody))).not.toBeNull();
});

test("a page whose lazy component has loaded is kept as the same text as before it loaded", () => {
  const waiting = livewirePage("Contacts", contactsBody, ["guides/other"]);
  const loaded = loadedPage("Contacts", contactsBody, contactsBody, ["guides/other"]);
  // The loaded page shows the text itself, and still carries it in the component's data.
  expect(normalize(loaded, "html").markdown).toContain("contacts_connect");
  expect(loaded.length).toBeGreaterThan(waiting.length);

  const kept = lazyPageContent(loaded)!;
  expect(kept).toBe(lazyPageContent(waiting)!);
  expect(kept.length).toBeLessThan(loaded.length / 5);
  expect(normalize(kept, "html").markdown).not.toContain("menu entry");
});

test("the longest HTML a lazy component carries is the page text, wherever it sits in the data", () => {
  const short = "<p>Short summary.</p>";
  const page = `<html><head><title>T</title></head><body>` +
    component({ part: "<p>Another lazy part.</p>" }, { lazyLoaded: false }, "") +
    component({ summary: short, nested: { deep: [{ html: contactsBody }] }, count: 3, flag: null }, { lazyLoaded: false }, skeleton) +
    component({ other: `<p>${"x".repeat(contactsBody.length + 50)}</p>` }, { lazyLoaded: true }, "") +
    `</body></html>`;
  const kept = lazyPageContent(page)!;
  expect(kept).toContain(contactsBody);
  expect(kept).not.toContain(short);
  expect(kept).not.toContain("Another lazy part");
  expect(kept).not.toContain("xxxx");
});

const site = "https://docs.example.test/docs/";
const pages: Record<string, string> = {
  "": livewirePage("Overview", "<h1>Overview</h1><p>Start with the heron guide.</p>", ["/docs/guides/contacts", "/docs/guides/plain"]),
  "guides/contacts": livewirePage("Contacts", contactsBody, ["/docs/guides/hidden"]),
  "guides/plain": `<html><head><title>Plain</title></head><body><main><h1>Plain</h1><p>An ordinary page about the osprey.</p></main></body></html>`,
  "guides/hidden": livewirePage("Hidden", "<h1>Hidden</h1><p>Reached only through the menu of another page: the curlew.</p>"),
};
const siteFetcher = (requested: string[] = []): Fetcher => async (url) => {
  const path = url.slice(site.length);
  requested.push(path);
  return pages[path] === undefined ? new Response("missing", { status: 404 }) : new Response(pages[path], { headers: { "content-type": "text/html" } });
};
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test("a crawl keeps and counts the lazy text of each page, and still follows the page's own links", async () => {
  const requested: string[] = [];
  const lines: string[] = [];
  const downloaded = Object.values(pages).reduce((n, p) => n + p.length, 0);
  // Far under what the pages weigh: the crawl fits only because the kept text is what counts.
  const limits = { ...DEFAULT_LIMITS, maxTotalBytes: Math.round(downloaded / 5) };
  const docs = await crawl(site, limits, siteFetcher(requested), { markdownExports: false, log: (_level, line) => lines.push(line) });
  expect(docs.map((d) => d.path)).toEqual(["index.html", "guides/contacts", "guides/plain", "guides/hidden"]);
  // "guides/hidden" is linked only from the menu, which is not part of the kept text.
  expect(requested).toEqual(["", "guides/contacts", "guides/plain", "guides/hidden"]);

  expect(text(docs[1]!.bytes)).toBe(lazyPageContent(pages["guides/contacts"]!)!);
  expect(text(docs[1]!.bytes)).not.toContain("menu entry");
  expect(text(docs[2]!.bytes)).toBe(pages["guides/plain"]!);
  const kept = docs.reduce((n, d) => n + d.bytes.length, 0);
  expect(kept).toBeLessThan(limits.maxTotalBytes);
  expect(lines.find((l) => l.startsWith(`Fetched ${site}guides/contacts `))).toContain("of lazy-loaded content");
  expect(lines.find((l) => l.startsWith(`Fetched ${site}guides/plain `))).not.toContain("lazy-loaded");
  expect(lines.at(-1)).toMatch(/^Crawl finished: 4 pages, /);

  // The kept text is still limited: one byte less than it needs and the crawl stops.
  await expect(crawl(site, { ...DEFAULT_LIMITS, maxTotalBytes: kept - 1 }, siteFetcher(), { log: () => {} })).rejects.toThrow("crawl exceeded");
  // The page limit applies to the page as downloaded, before anything is taken out of it.
  const small = await crawl(site, { ...DEFAULT_LIMITS, maxBytesPerPage: pages["guides/plain"]!.length }, siteFetcher(), { log: () => {} }).catch((e: Error) => e.message);
  expect(small).toBe(`no documents fetched from ${site}`);
});

test("a source with lazy-loaded pages is searchable by its text and preserves that text", async () => {
  const d = newDocify(tempDir());
  d.addSource({ library: "lazy", version: null, kind: "url", locator: site });
  const result = await d.prepare("lazy@unknown", { graph: false, fetcher: siteFetcher() });
  expect(result.status).toBe("activated");

  const found = await search(d, { query: "contacts_connect plover address book", library: "lazy", mode: "lexical" });
  expect(found.status).toBe("ok");
  expect(found.hits[0]!.citation.url!.split("#")[0]).toBe(site + "guides/contacts");
  expect(found.hits[0]!.excerpt).toContain("contacts_connect()");
  // The menu repeated on every page is not indexed.
  expect((await search(d, { query: "wagtail", library: "lazy", mode: "lexical" })).hits).toEqual([]);
  expect(d.db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM passages WHERE generation_id = ? AND text LIKE '%wagtail%'").get(result.generationId)!.n).toBe(0);

  const row = d.db
    .query<{ title: string; raw_file: string; normalized_file: string }, [number]>("SELECT title, raw_file, normalized_file FROM documents WHERE generation_id = ? AND path = 'guides/contacts'")
    .get(result.generationId)!;
  expect(row.title).toBe("Contacts");
  expect(gunzipSync(readFileSync(row.raw_file)).toString("utf8")).toBe(lazyPageContent(pages["guides/contacts"]!)!);
  expect(gunzipSync(readFileSync(row.normalized_file)).toString("utf8")).toContain("int error = contacts_connect();");

  // The same pages again are the same snapshot.
  expect((await d.prepare("lazy@unknown", { graph: false, fetcher: siteFetcher() })).status).toBe("unchanged");
  d.close();
});

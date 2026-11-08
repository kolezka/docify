// Page-level retrieval evaluation against the store in DOCIFY_HOME, for corpora whose questions are
// labelled with the pages that answer them (one Markdown file per page of a docs site).
// Each JSONL line: {"q": "question", "expect": ["https://docs.example.com/guide/install", ...], "tags": ["paraphrase"]}
// Usage: bun scripts/eval-pages.ts <questions.jsonl> [--url-base https://docs.example.com/] [--library L] [--modes combined,vector] [--out results.json]
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Docify } from "../src/core/docify.ts";
import { search, type Mode } from "../src/core/search.ts";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: { "url-base": { type: "string" }, library: { type: "string" }, modes: { type: "string" }, out: { type: "string" } },
});
const file = positionals[0];
if (!file) throw new Error("usage: bun scripts/eval-pages.ts <questions.jsonl> [--url-base URL] [--library L] [--modes combined,vector] [--out FILE]");
const questions = readFileSync(file, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as { q: string; expect: string[]; tags?: string[] });
const modes = (values.modes ?? "combined").split(",") as Mode[];
const urlBase = values["url-base"] ?? "";
// A cited document path ("guide/install.md") names the page "<url-base>guide/install".
const pageOf = (document: string) => urlBase + document.replace(/\.(mdx?|html?)$/, "");

const docify = new Docify();
const report: Record<string, unknown> = {};
for (const mode of modes) {
  const rows: { tags: string[]; rank: number | null; ms: number }[] = [];
  for (const q of questions) {
    const t0 = performance.now();
    const r = await search(docify, { query: q.q, library: values.library, mode, maxTokens: 100_000 });
    const ms = performance.now() - t0;
    const pages = [...new Set(r.hits.map((h) => pageOf(h.citation.document)))];
    const i = pages.findIndex((p) => q.expect.includes(p));
    rows.push({ tags: q.tags ?? [], rank: i < 0 ? null : i + 1, ms });
  }
  const summarize = (subset: typeof rows) => {
    const hit = (k: number) => +(subset.filter((r) => r.rank !== null && r.rank <= k).length / subset.length).toFixed(3);
    const mrr = +(subset.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / subset.length).toFixed(3);
    return { n: subset.length, hit1: hit(1), hit3: hit(3), hit10: hit(10), mrr };
  };
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  const tags = [...new Set(rows.flatMap((r) => r.tags))].sort();
  const result = {
    all: summarize(rows),
    byTag: Object.fromEntries(tags.map((t) => [t, summarize(rows.filter((r) => r.tags.includes(t)))])),
    p50Ms: +ms[Math.floor(ms.length / 2)]!.toFixed(1),
    p95Ms: +ms[Math.floor(ms.length * 0.95)]!.toFixed(1),
  };
  report[mode] = result;
  console.log(`== ${mode}\n${JSON.stringify(result)}`);
}
docify.close();
if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 2) + "\n");

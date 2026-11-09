// Budget split check for searchMany: per-query passage recall when eval/questions.json is
// asked in batches, for the equal split against filling queries in order ("sequential").
// Builds a throwaway store from fixtures/corpus in a temp dir with a loopback stub embedder,
// so it needs no model and no network; that limits it to lexical mode.
// Usage: bun scripts/eval-many.ts [--size 3] [--budgets 1500,2000]
import { parseArgs } from "node:util";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Docify } from "../src/core/docify.ts";
import { search, searchMany } from "../src/core/search.ts";

interface Locator {
  source: string | string[];
  document: string | string[];
  heading: string;
  contains: string;
}
interface Question {
  id: string;
  query: string;
  library?: string;
  version?: string;
  expect: Locator[];
}

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { size: { type: "string" }, budgets: { type: "string" } } });
const size = Number(values.size ?? 3);
const budgets = (values.budgets ?? "1500,2000").split(",").map(Number);
const spec = JSON.parse(readFileSync(new URL("../eval/questions.json", import.meta.url), "utf8")) as { questions: Question[] };

const stub = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const { input } = (await req.json()) as { input: string[] };
    return Response.json({ embeddings: input.map((t) => [t.length % 97, 1, 2, 3]) });
  },
});
const home = mkdtempSync(join(tmpdir(), "docify-eval-many-"));
const docify = new Docify({ home, embeddingProvider: "ollama", embeddingUrl: `http://127.0.0.1:${stub.port}`, embeddingModel: "stub", embeddingDims: 4, embeddingQueryPrefix: "" });
const corpus = new URL("../fixtures/corpus/", import.meta.url).pathname;
for (const [library, version] of [["bun", "1.4.3"], ["bun", "1.2.0"], ["python", "3.13"]] as const) {
  docify.addSource({ library, version, kind: "local", locator: join(corpus, `${library}-${version}`) });
  await docify.prepare(`${library}@${version}`, { graph: false });
}

const many = (x: string | string[]) => (Array.isArray(x) ? x : [x]);
const norm = (s: string) => s.replace(/`/g, "").trim().toLowerCase();
const textOf = (id: string) => docify.db.query<{ text: string }, [string]>("SELECT text FROM passages WHERE id = ?").get(id)!.text;
const found = (loc: Locator, hits: { id: string; citation: { source: string; document: string; headingPath: string[] } }[]) =>
  hits.some(
    (h) =>
      many(loc.source).includes(h.citation.source) &&
      many(loc.document).includes(h.citation.document) &&
      norm(h.citation.headingPath.at(-1) ?? "") === norm(loc.heading) &&
      textOf(h.id).toLowerCase().includes(loc.contains.toLowerCase()),
  );

// Batches of `size` questions that share library and version filters.
const byScope = new Map<string, Question[]>();
for (const q of spec.questions.filter((x) => x.expect.length)) {
  const key = `${q.library ?? ""}@${q.version ?? ""}`;
  byScope.set(key, [...(byScope.get(key) ?? []), q]);
}
const batches: Question[][] = [];
for (const qs of byScope.values()) for (let i = 0; i < qs.length; i += size) batches.push(qs.slice(i, i + size));

const expectedTotal = batches.flat().reduce((n, q) => n + q.expect.length, 0);
console.log(`lexical mode, ${batches.flat().length} questions in ${batches.length} batches of up to ${size}, ${expectedTotal} expected passages`);
const rows: string[] = [];
for (const budget of budgets) {
  // Ceiling: each question alone with the whole budget, as one search call per question.
  let single = 0;
  for (const q of batches.flat()) {
    const r = await search(docify, { query: q.query, library: q.library, version: q.version, mode: "lexical", maxTokens: budget });
    single += q.expect.filter((loc) => found(loc, r.hits)).length;
  }
  rows.push(`| ${budget} | single call per question | ${(single / expectedTotal).toFixed(3)} | - | - |`);
  for (const split of ["equal", "sequential"] as const) {
    let hit = 0;
    let starved = 0;
    let maxTokens = 0;
    for (const batch of batches) {
      const r = await searchMany(docify, { queries: batch.map((q) => q.query), library: batch[0]!.library, version: batch[0]!.version, mode: "lexical", maxTokens: budget, budgetSplit: split });
      maxTokens = Math.max(maxTokens, r.tokens);
      batch.forEach((q, i) => {
        const shown = r.queries[i]!.hits.map((rank) => r.hits[rank - 1]!);
        if (!shown.length && r.queries[i]!.status !== "no_match") starved++;
        hit += q.expect.filter((loc) => found(loc, shown)).length;
      });
    }
    rows.push(`| ${budget} | searchMany, ${split} | ${(hit / expectedTotal).toFixed(3)} | ${starved} | ${maxTokens} |`);
  }
}
console.log("| Budget | Policy | Passage recall | Queries with no hit shown | Max tokens |\n| --- | --- | --- | --- | --- |\n" + rows.join("\n"));
docify.close();
stub.stop(true);
rmSync(home, { recursive: true, force: true });

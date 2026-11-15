// Retrieval evaluation over eval/questions.json against the prepared store.
// Usage: bun scripts/eval.ts [--modes combined,lexical,vector,graph] [--out eval/results.json]
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { Docify } from "../src/core/docify.ts";
import { search, type Mode, type SearchHit } from "../src/core/search.ts";
import { readSnapshotFile } from "../src/core/snapshot-file.ts";

type OneOrMany = string | string[];
interface Locator {
  source: OneOrMany;
  document: OneOrMany;
  heading: string;
  contains: string;
}
interface Question {
  id: string;
  kind: string;
  must: boolean;
  query: string;
  library?: string;
  version?: string;
  expect: Locator[];
  expectStatus?: string[];
  versionAllowed?: string[];
}

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { modes: { type: "string" }, out: { type: "string" }, "graph-weight": { type: "string" } } });
const spec = JSON.parse(readFileSync(new URL("../eval/questions.json", import.meta.url), "utf8")) as {
  budget: number;
  targets: { recallCombined: number; p95LatencyMs: number };
  questions: Question[];
  negativeControl: Locator;
};
const modes = (values.modes ?? "combined,lexical,vector,graph").split(",") as Mode[];
const docify = new Docify();

const many = (x: OneOrMany) => (Array.isArray(x) ? x : [x]);
const norm = (s: string) => s.replace(/`/g, "").trim().toLowerCase();

interface PassageRef {
  source: string;
  document: string;
  heading: string;
  text: string;
}
const active = docify.db
  .query<{ source: string; document: string; heading_path: string; text: string }, []>(
    `SELECT g.source_id AS source, d.path AS document, p.heading_path, p.text FROM passages p
     JOIN documents d ON d.id = p.document_id JOIN generations g ON g.id = p.generation_id WHERE g.status = 'active'`,
  )
  .all()
  .map((r) => ({ source: r.source, document: r.document, heading: (JSON.parse(r.heading_path) as string[]).at(-1) ?? "", text: r.text }));

const matches = (loc: Locator, p: PassageRef) =>
  many(loc.source).includes(p.source) &&
  many(loc.document).includes(p.document) &&
  norm(p.heading) === norm(loc.heading) &&
  p.text.toLowerCase().includes(loc.contains.toLowerCase());

// 1. Validate the instrument: every expected locator must resolve, the negative control must not.
const problems: string[] = [];
for (const q of spec.questions) {
  for (const loc of q.expect) if (!active.some((p) => matches(loc, p))) problems.push(`${q.id}: expected passage not in store: ${JSON.stringify(loc)}`);
  if (!q.expect.length && !q.expectStatus) problems.push(`${q.id}: no expectation`);
}
if (active.some((p) => matches(spec.negativeControl, p))) problems.push("negative control resolved; locator matching is too loose");
const probe = spec.questions.find((q) => q.expect.length)!;
const shifted = { ...probe.expect[0]!, heading: probe.expect[0]!.heading + " x" };
if (active.some((p) => matches(shifted, p))) problems.push("altered heading still matched; heading comparison is broken");
if (problems.length) {
  console.error("Measurement fixture invalid, not scoring:\n" + problems.join("\n"));
  process.exit(2);
}
console.log(`fixture ok: ${spec.questions.length} questions, ${spec.questions.reduce((n, q) => n + q.expect.length, 0)} expected passages, negative controls rejected`);

const normalizedCache = new Map<string, string[]>();
function citationValid(h: SearchHit): boolean {
  const row = docify.db
    .query<{ normalized_file: string; normalized_sha256: string; text: string }, [string]>(
      "SELECT d.normalized_file, d.normalized_sha256, p.text FROM passages p JOIN documents d ON d.id = p.document_id WHERE p.id = ?",
    )
    .get(h.id);
  if (!row) return false;
  let lines = normalizedCache.get(row.normalized_file);
  if (!lines) {
    // Stored gzipped or plain; null means the file is not what the database recorded.
    const content = readSnapshotFile(row.normalized_file, row.normalized_sha256);
    if (!content) return false;
    normalizedCache.set(row.normalized_file, (lines = Buffer.from(content).toString("utf8").split("\n")));
  }
  const slice = lines.slice(h.citation.lines[0] - 1, h.citation.lines[1]).join("\n");
  if (slice !== row.text) return false;
  if (h.citation.linesMatchRaw) {
    const raw = readFileSync(h.citation.rawFile, "utf8").split("\n");
    if (raw.length < h.citation.lines[1]) return false;
  }
  return h.truncated ? row.text.startsWith(h.excerpt.replace(/\n```$/, "")) || row.text.includes(h.excerpt.split("\n")[0]!) : h.excerpt === row.text;
}

// Warm the embedding model so latency reflects queries, not model loading.
await search(docify, { query: "warm up", mode: "combined" });

const report: Record<string, unknown> = {};
for (const mode of modes) {
  const rows = [];
  for (const q of spec.questions) {
    const t0 = performance.now();
    const r = await search(docify, { query: q.query, library: q.library, version: q.version, mode, maxTokens: spec.budget, graphWeight: values["graph-weight"] ? Number(values["graph-weight"]) : undefined });
    const ms = performance.now() - t0;
    const hitRefs = r.hits.map((h) => ({ h, ref: { source: h.citation.source, document: h.citation.document, heading: h.citation.headingPath.at(-1) ?? "", text: docify.db.query<{ text: string }, [string]>("SELECT text FROM passages WHERE id = ?").get(h.id)!.text } }));
    const found = q.expect.map((loc) => hitRefs.find((x) => matches(loc, x.ref))?.h.rank ?? 0);
    const allowed = q.versionAllowed ?? (q.library && q.version ? [`${q.library}@${q.version}`] : null);
    const leaks = allowed ? r.hits.filter((h) => !allowed.includes(h.citation.source)).length : 0;
    const badCitations = r.hits.filter((h) => !citationValid(h)).length;
    // weak_match still hands the agent the excerpts, flagged as low confidence.
    const statusOk = q.expectStatus ? q.expectStatus.includes(r.status) : r.status === "ok" || r.status === "weak_match";
    const pass = statusOk && found.every((rank) => rank > 0) && leaks === 0 && badCitations === 0 && r.tokens <= spec.budget;
    rows.push({ id: q.id, kind: q.kind, must: q.must, pass, status: r.status, found, tokens: r.tokens, hits: r.hits.length, truncated: r.hits.filter((h) => h.truncated).length, leaks, badCitations, ms: Math.round(ms * 10) / 10 });
  }
  const withExpect = rows.filter((_, i) => spec.questions[i]!.expect.length);
  const expectedTotal = spec.questions.reduce((n, q) => n + q.expect.length, 0);
  const foundTotal = rows.reduce((n, r) => n + r.found.filter((x) => x > 0).length, 0);
  const firstRanks = withExpect.map((r) => Math.min(...r.found.map((x) => (x > 0 ? x : Infinity))));
  const lat = rows.map((r) => r.ms).sort((a, b) => a - b);
  const summary = {
    pass: rows.filter((r) => r.pass).length,
    weak: rows.filter((r) => r.status === "weak_match").length,
    of: rows.length,
    mustPass: rows.filter((r) => r.must && r.pass).length,
    mustOf: rows.filter((r) => r.must).length,
    passageRecall: +(foundTotal / expectedTotal).toFixed(3),
    mrr: +(firstRanks.reduce((s, r) => s + (Number.isFinite(r) ? 1 / r : 0), 0) / firstRanks.length).toFixed(3),
    avgTokens: Math.round(rows.reduce((s, r) => s + r.tokens, 0) / rows.length),
    maxTokens: Math.max(...rows.map((r) => r.tokens)),
    versionLeaks: rows.reduce((s, r) => s + r.leaks, 0),
    badCitations: rows.reduce((s, r) => s + r.badCitations, 0),
    truncatedHits: rows.reduce((s, r) => s + r.truncated, 0),
    p50Ms: lat[Math.floor(lat.length * 0.5)],
    p95Ms: lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))],
    failed: rows.filter((r) => !r.pass).map((r) => `${r.id}${r.must ? "*" : ""}:${r.status}:${r.found.join("/")}`),
  };
  report[mode] = { summary, rows };
  console.log(`\n== ${mode}\n${JSON.stringify(summary)}`);
}
if (values.out) await Bun.write(values.out, JSON.stringify(report, null, 2) + "\n");
docify.close();

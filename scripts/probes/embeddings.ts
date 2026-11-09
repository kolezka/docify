// Bounded embedding model comparison on real Bun docs: paraphrase queries plus lexical controls.
// Usage: bun scripts/probes/embeddings.ts [--offline] <docs-dir>
import { env, pipeline } from "@huggingface/transformers";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { docifyHome } from "../../src/core/config.ts";

const args = Bun.argv.slice(2);
const offline = args.includes("--offline");
const docsDir = args.find((a) => !a.startsWith("--"));
if (!docsDir) throw new Error("usage: embeddings.ts [--offline] <docs-dir>");

env.cacheDir = join(docifyHome(), "models");
env.allowRemoteModels = !offline;

type Model = { id: string; queryPrefix: string; docPrefix: string };
const models: Model[] = [
  { id: "Xenova/all-MiniLM-L6-v2", queryPrefix: "", docPrefix: "" },
  { id: "Xenova/bge-small-en-v1.5", queryPrefix: "Represent this sentence for searching relevant passages: ", docPrefix: "" },
  { id: "nomic-ai/nomic-embed-text-v1.5", queryPrefix: "search_query: ", docPrefix: "search_document: " },
];

// Split on headings so each passage is one section.
const passages: { id: string; text: string }[] = [];
for (const file of readdirSync(docsDir).filter((f) => /\.mdx?$/.test(f))) {
  const lines = (await Bun.file(join(docsDir, file)).text()).split("\n");
  let start = 0;
  let heading = "(intro)";
  const flush = (end: number) => {
    const text = lines.slice(start, end).join("\n").trim();
    if (text.length > 40) passages.push({ id: `${file}#${heading}`, text: text.slice(0, 2000) });
  };
  lines.forEach((line, i) => {
    const m = /^#{1,4} (.+)$/.exec(line);
    if (m && m[1]) {
      flush(i);
      start = i;
      heading = m[1];
    }
  });
  flush(lines.length);
}

// Expected heading substring per query. Paraphrases avoid the heading words on purpose.
const queries: { q: string; expect: string; kind: "paraphrase" | "lexical" }[] = [
  { q: "keep the -wal and -shm files on disk after closing the db", expect: "WAL sidecar file cleanup", kind: "paraphrase" },
  { q: "store a user's login secret so it can be checked later without keeping plaintext", expect: "`Bun.password`", kind: "paraphrase" },
  { q: "quick non-cryptographic checksum of a string", expect: "`Bun.hash`", kind: "paraphrase" },
  { q: "apply several inserts all-or-nothing and undo them if one throws", expect: "Transactions", kind: "paraphrase" },
  { q: "read result rows lazily one by one instead of loading them all", expect: "`.iterate()`", kind: "paraphrase" },
  { q: "very large 64-bit numbers come back with wrong digits", expect: "`safeIntegers: true`", kind: "paraphrase" },
  { q: "turn query results into instances of my own class", expect: "`.as(Class)`", kind: "paraphrase" },
  { q: "keyed message authentication code with sha256", expect: "HMAC in `Bun.CryptoHasher`", kind: "paraphrase" },
  { q: "fileControl SQLITE_FCNTL_PERSIST_WAL", expect: "fileControl", kind: "lexical" },
  { q: "Bun.CryptoHasher digest", expect: "`Bun.CryptoHasher`", kind: "lexical" },
  { q: "Database.prepare finalize", expect: "`.finalize()`", kind: "lexical" },
];

const cos = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

for (const model of models) {
  const t0 = performance.now();
  let extractor;
  try {
    extractor = await pipeline("feature-extraction", model.id, { dtype: "fp32" });
  } catch (err) {
    console.log(JSON.stringify({ model: model.id, error: String(err).slice(0, 200) }));
    continue;
  }
  const loadMs = performance.now() - t0;
  const embed = async (texts: string[]) => {
    const out = await extractor(texts, { pooling: "mean", normalize: true });
    const [n, dim] = out.dims as [number, number];
    const data = out.data as Float32Array;
    return Array.from({ length: n }, (_, i) => data.slice(i * dim, (i + 1) * dim));
  };
  const t1 = performance.now();
  const docVecs: Float32Array[] = [];
  for (let i = 0; i < passages.length; i += 16) {
    docVecs.push(...(await embed(passages.slice(i, i + 16).map((p) => model.docPrefix + p.text))));
  }
  const indexMs = performance.now() - t1;
  const results = [];
  let rr = 0;
  let qMs = 0;
  for (const { q, expect, kind } of queries) {
    const t2 = performance.now();
    const [qv] = await embed([model.queryPrefix + q]);
    qMs += performance.now() - t2;
    const ranked = passages
      .map((p, i) => ({ id: p.id, score: cos(qv!, docVecs[i]!) }))
      .sort((a, b) => b.score - a.score);
    const rank = ranked.findIndex((r) => r.id.includes(expect)) + 1;
    rr += rank ? 1 / rank : 0;
    results.push({ kind, rank, top: ranked[0]!.id });
  }
  console.log(
    JSON.stringify({
      model: model.id,
      offline,
      dims: docVecs[0]!.length,
      passages: passages.length,
      loadMs: Math.round(loadMs),
      indexMs: Math.round(indexMs),
      avgQueryMs: Math.round(qMs / queries.length),
      mrr: +(rr / queries.length).toFixed(3),
      top1: results.filter((r) => r.rank === 1).length,
      top3: results.filter((r) => r.rank > 0 && r.rank <= 3).length,
      ranks: results.map((r) => `${r.kind[0]}${r.rank}`).join(" "),
    }),
  );
}

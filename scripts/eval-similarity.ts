// Best vector similarity per evaluation question, for choosing strongVectorSim and weakVectorSim
// for an embedding model. Uses the prepared store and config in DOCIFY_HOME (see docs/evaluation.md).
// Usage: bun scripts/eval-similarity.ts
import { readFileSync } from "node:fs";
import { Docify } from "../src/core/docify.ts";
import { embedQuery, embeddingIdentity } from "../src/core/embed.ts";
import { resolveScope } from "../src/core/search.ts";

interface Question {
  id: string;
  kind: string;
  must: boolean;
  query: string;
  library: string | null;
  version: string | null;
  expect: unknown[];
}

const spec = JSON.parse(readFileSync(new URL("../eval/questions.json", import.meta.url), "utf8")) as { questions: Question[] };
const docify = new Docify();
const identity = embeddingIdentity(docify.config);
const rows: { id: string; kind: string; must: boolean; answered: boolean; best: number }[] = [];

for (const q of spec.questions) {
  const scope = resolveScope(docify, { query: q.query, library: q.library ?? undefined, version: q.version ?? undefined });
  // A status (unknown source, unavailable version) ends the search before the evidence gate.
  if (scope.status) continue;
  const gens = [...scope.generations.values()].filter((g) => g.generation.embedding_model === identity).map((g) => g.generation.id);
  if (!gens.length) throw new Error(`${q.id}: no generation in scope was prepared with ${identity}`);
  const qv = await embedQuery(docify.config, q.query);
  let best = -1;
  for (const row of docify.db
    .query<{ embedding: Uint8Array }, []>(`SELECT embedding FROM vectors WHERE generation_id IN (${gens.join(",")})`)
    .all()) {
    const v = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i]! * qv[i]!;
    if (s > best) best = s;
  }
  rows.push({ id: q.id, kind: q.kind, must: q.must, answered: q.expect.length > 0, best });
}
docify.close();

const { strongVectorSim: strong, weakVectorSim: weak } = docify.config;
console.log(`${identity}, thresholds strong ${strong} / weak ${weak}\n`);
for (const r of rows.sort((a, b) => b.best - a.best)) {
  const tier = r.best >= strong ? "strong" : r.best >= weak ? "weak" : "none";
  console.log(`${r.best.toFixed(3)}  ${r.id.padEnd(4)} ${(r.answered ? "answer" : "no answer").padEnd(10)} ${r.must ? "must" : "    "} ${r.kind.padEnd(13)} vector tier ${tier}`);
}
const answered = rows.filter((r) => r.answered).map((r) => r.best);
const unanswered = rows.filter((r) => !r.answered).map((r) => r.best);
console.log(`\nlowest with an answer: ${Math.min(...answered).toFixed(3)}; highest without: ${Math.max(...unanswered).toFixed(3)}`);
console.log("The vector tier is one input of the gate; term coverage can still make a hit strong (src/core/search.ts).");

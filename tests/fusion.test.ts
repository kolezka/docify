import { test, expect, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { search } from "../src/core/search.ts";
import { fakeGraph, newDocify, tempDir, writeDocs } from "./helpers.ts";

const URL_ENV = "DOCIFY_TEST_FUSION_BASE_URL";
const KEY_ENV = "DOCIFY_TEST_FUSION_API_KEY";
const QUERY = "zebra crossing rules";

// The query points along x. Pages marked MARKn lie close to x, nearer for smaller n, so the vector
// ranks them first. The zebra page shares the query's words but lies along z, so the vector ranks it
// last, outside its 30 candidates: lexical search is the only thing that finds it.
function fakeEmbedding(t: string): number[] {
  if (t === QUERY) return [1, 0, 0];
  const mark = /MARK(\d+)/.exec(t);
  if (mark) return [1 - Number(mark[1]) * 0.01, 0.05 + Number(mark[1]) * 0.01, 0];
  if (t.toLowerCase().includes("zebra")) return [0, 0, 1];
  return [0, 1, 0];
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const { input } = (await req.json()) as { input: string[] };
    return Response.json({ data: input.map((t, index) => ({ index, embedding: fakeEmbedding(t) })) });
  },
});
process.env[URL_ENV] = `http://127.0.0.1:${server.port}`;
process.env[KEY_ENV] = "k";

const homes: string[] = [];
afterAll(() => {
  server.stop(true);
  delete process.env[URL_ENV];
  delete process.env[KEY_ENV];
  homes.forEach((h) => rmSync(h, { recursive: true, force: true }));
});

const files: Record<string, string> = { "zebra.md": "# Zebra\n\n## Crossing\n\nzebra crossing rules for pedestrians.\n" };
for (let i = 0; i < 34; i++) files[`page${i}.md`] = `# Page MARK${i}\n\n## Part\n\nNotes about sockets and timeouts.\n`;
const docs = writeDocs(join(tempDir("docify-src-"), "lib"), files);

async function rankOfZebra(lexicalWeight: number, mode: "combined" | "lexical") {
  const home = tempDir();
  homes.push(home);
  const d = newDocify(home, {
    embeddingProvider: "openai",
    embeddingBaseUrlEnv: URL_ENV,
    embeddingApiKeyEnv: KEY_ENV,
    embeddingModel: "m",
    embeddingDims: 3,
    embeddingQueryPrefix: "",
    lexicalWeight,
  });
  d.addSource({ library: "lib", version: "1", kind: "local", locator: docs });
  await d.prepare("lib@1", { graphRunner: fakeGraph });
  const r = await search(d, { query: QUERY, library: "lib", mode, maxTokens: 50_000 });
  d.close();
  const i = r.hits.findIndex((h) => h.citation.document === "zebra.md");
  return { rank: i < 0 ? null : i + 1, hits: r.hits.length };
}

test("at full weight a page found only by words can outrank the vector's hits", async () => {
  const { rank } = await rankOfZebra(1, "combined");
  expect(rank).not.toBeNull();
  expect(rank!).toBeLessThanOrEqual(2);
});

test("at half weight a page found only by words ranks below every vector candidate", async () => {
  const { rank, hits } = await rankOfZebra(0.5, "combined");
  expect(hits).toBeGreaterThan(5);
  expect(rank === null || rank > 30).toBe(true);
});

test("lexical mode ignores the weight", async () => {
  expect((await rankOfZebra(0, "lexical")).rank).toBe(1);
});

import { test, expect, afterAll } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newDocify, tempDir, writeDocs } from "./helpers.ts";

// A loopback embedder that records every input, so the test can see what was sent for embedding.
const URL_ENV = "DOCIFY_TEST_REUSE_BASE_URL";
const KEY_ENV = "DOCIFY_TEST_REUSE_API_KEY";
const sent: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const { input } = (await req.json()) as { input: string[] };
    sent.push(...input);
    // Vector depends on the input, so a copied vector can be checked against a fresh one.
    return Response.json({ data: input.map((t, index) => ({ index, embedding: [t.length, 1, (t.charCodeAt(0) || 0) % 7] })) });
  },
});
process.env[URL_ENV] = `http://127.0.0.1:${server.port}`;
process.env[KEY_ENV] = "k";

const homes: string[] = [];
afterAll(() => {
  server.stop(true);
  delete process.env[URL_ENV];
  delete process.env[KEY_ENV];
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

function setup(model = "m") {
  const home = tempDir();
  homes.push(home);
  return newDocify(home, { embeddingProvider: "openai", embeddingBaseUrlEnv: URL_ENV, embeddingApiKeyEnv: KEY_ENV, embeddingModel: model, embeddingDims: 3, graph: null });
}

const vectorsOf = (d: ReturnType<typeof setup>, genId: number) =>
  new Map(
    d.db
      .query<{ text: string; heading_path: string; embedding: Uint8Array }, [number]>(
        "SELECT p.text, p.heading_path, v.embedding FROM passages p JOIN vectors v ON v.passage_rowid = p.rowid WHERE p.generation_id = ?",
      )
      .all(genId)
      .map((r) => [`${r.heading_path}\0${r.text}`, Buffer.from(r.embedding).toString("hex")]),
  );

test("prepare embeds only passages without a matching earlier vector", async () => {
  const d = setup();
  const lib = writeDocs(join(tempDir("docify-src-"), "lib"), {
    "a.md": "# A\n\n## Install\n\nRun the installer.\n\n## Configure\n\nEdit the config file.\n",
    "b.md": "# B\n\n## Usage\n\nCall connect.\n",
  });
  d.addSource({ library: "lib", version: "1", kind: "local", locator: lib });
  sent.length = 0;
  const first = await d.prepare("lib@1");
  const firstSent = sent.length;
  expect(firstSent).toBe(first.stats.passages as number);
  expect(first.stats.embedReused).toBe(0);

  writeFileSync(join(lib, "b.md"), "# B\n\n## Usage\n\nCall connect with a timeout.\n");
  sent.length = 0;
  const second = await d.prepare("lib@1");
  expect(second.status).toBe("activated");
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("Call connect with a timeout.");
  expect(second.stats.embedReused).toBe((second.stats.passages as number) - 1);

  // Copied vectors are the same bytes as the ones the first generation got for the same input.
  const before = vectorsOf(d, first.generationId);
  const after = vectorsOf(d, second.generationId);
  expect(after.size).toBe(second.stats.passages as number);
  for (const [k, v] of after) if (before.has(k)) expect(v).toBe(before.get(k)!);

  // A forced rebuild of unchanged content still sends nothing.
  sent.length = 0;
  const forced = await d.prepare("lib@1", { force: true });
  expect(forced.status).toBe("activated");
  expect(sent).toHaveLength(0);
  d.close();
});

test("vectors from another embedding model are not reused", async () => {
  const lib = writeDocs(join(tempDir("docify-src-"), "lib"), { "a.md": "# A\n\n## Install\n\nRun the installer.\n" });
  const d1 = setup("m1");
  d1.addSource({ library: "lib", version: "1", kind: "local", locator: lib });
  await d1.prepare("lib@1");
  const home = d1.config.home;
  d1.close();

  const d2 = newDocify(home, { embeddingProvider: "openai", embeddingBaseUrlEnv: URL_ENV, embeddingApiKeyEnv: KEY_ENV, embeddingModel: "m2", embeddingDims: 3, graph: null });
  sent.length = 0;
  const r = await d2.prepare("lib@1");
  expect(r.status).toBe("activated");
  expect(sent.length).toBe(r.stats.passages as number);
  expect(r.stats.embedReused).toBe(0);
  d2.close();
});

test("a heading change alone is embedded again, since the heading is part of the input", async () => {
  const d = setup();
  const lib = writeDocs(join(tempDir("docify-src-"), "lib"), { "a.md": "# A\n\n## Install\n\nSame body.\n" });
  d.addSource({ library: "lib", version: "1", kind: "local", locator: lib });
  await d.prepare("lib@1");
  writeFileSync(join(lib, "a.md"), "# A\n\n## Setup\n\nSame body.\n");
  sent.length = 0;
  await d.prepare("lib@1");
  expect(sent.some((t) => t.includes("Setup"))).toBe(true);
  d.close();
});

// Graphify exits 0 when the model leaves files out or a chunk fails, and still writes a graph
// for the rest. These tests run the real runGraphify against a stand-in executable.
import { describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stagedName } from "../src/core/graph.ts";
import { search } from "../src/core/search.ts";
import { newDocify, tempDir, writeDocs } from "./helpers.ts";

// One node per document, named after its first "## " heading. control.json picks which staged
// files get no nodes and what goes to stderr, so a test can change the outcome between runs.
function fakeGraphify(dir: string) {
  const bin = join(dir, "graphify");
  const control = join(dir, "control.json");
  writeFileSync(
    bin,
    `#!${process.execPath}
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const control = JSON.parse(readFileSync(${JSON.stringify(control)}, "utf8"));
const args = process.argv.slice(2);
const corpus = args[1];
const out = args[args.indexOf("--out") + 1];
const nodes = [];
for (const f of readdirSync(corpus).sort()) {
  if (control.omit.includes(f)) continue;
  const heading = /^## (.+)$/m.exec(readFileSync(join(corpus, f), "utf8"))?.[1] ?? f;
  nodes.push({ id: f, label: heading, source_file: join(corpus, f) });
}
mkdirSync(join(out, "graphify-out"), { recursive: true });
writeFileSync(join(out, "graphify-out", "graph.json"), JSON.stringify({ nodes, edges: [] }));
for (const line of control.stderr) console.error(line);
`,
  );
  chmodSync(bin, 0o755);
  const set = (omit: string[], stderr: string[]) => writeFileSync(control, JSON.stringify({ omit, stderr }));
  set([], []);
  return { bin, set };
}

function setup() {
  const fake = fakeGraphify(tempDir("docify-fake-graphify-"));
  const d = newDocify(tempDir(), { graph: { backend: "ollama", model: "fake", timeoutSeconds: 60 }, graphifyBin: fake.bin });
  const dir = writeDocs(join(tempDir("docify-src-"), "lib"), {
    "a.md": "# A\n\n## Otter knob\n\nThe otterKnob setting enables floating.\n",
    "b.md": "# B\n\n## Beaver dam\n\nThe beaverDam option stacks logs.\n",
  });
  d.addSource({ library: "lib", version: "1", kind: "local", locator: dir });
  const active = () => d.getGeneration(d.getSource("lib@1")!.active_generation!)!;
  return { d, fake, dir, active };
}

// Lines in the format graphify 0.9.70 prints (graphify/llm.py and graphify/cli.py).
const omitted = (name: string) => [
  `[graphify] WARNING: 1/2 dispatched file(s) produced no nodes and are absent from the graph: ${name}. The model returned a response but omitted them; a re-run will retry them.`,
  "[graphify extract] semantic extraction is incomplete: 1 dispatched file(s) produced no nodes and 0 came back truncated or hollow. The shrink guard stays armed for this write; pass --allow-partial to overwrite a larger existing graph anyway.",
];
const failedChunk = [
  "[graphify] chunk 2/2 failed: Error code: 429 - rate limited",
  "[graphify] WARNING: 1/2 semantic chunk(s) failed — see errors above. Partial results returned.",
];

describe("partial Graphify extraction", () => {
  for (const [name, stderr] of [
    ["a file the model left out", omitted(stagedName("b.md"))],
    ["a failed chunk", failedChunk],
  ] as const) {
    test(`${name} activates the graph as partial and names the missing document`, async () => {
      const { d, fake, active } = setup();
      fake.set([stagedName("b.md")], [...stderr]);
      const r = await d.prepare("lib@1");
      expect(r.status).toBe("activated");
      const g = active();
      expect(g.id).toBe(r.generationId);
      expect(g.graph_status).toBe("partial");
      const stats = JSON.parse(g.stats);
      expect(stats.graphMissing).toEqual(["b.md"]);
      expect(stats.graphWarnings).toContain(stderr[stderr.length - 1]);
      expect(stats.groundedNodes).toBe(1);
      // The partial graph is used: graph mode finds the document that has nodes.
      const hits = (await search(d, { query: "Otter knob", library: "lib", mode: "graph" })).hits;
      expect(hits[0]?.citation.generation).toBe(r.generationId);
      expect(hits[0]?.excerpt).toContain("otterKnob");
    });
  }

  test("a document without nodes makes the graph partial even when Graphify prints no warning", async () => {
    const { d, fake, active } = setup();
    fake.set([stagedName("b.md")], []);
    expect((await d.prepare("lib@1")).status).toBe("activated");
    expect(active().graph_status).toBe("partial");
    expect(JSON.parse(active().stats).graphMissing).toEqual(["b.md"]);
  });

  test("a truncated file that kept some nodes still makes the graph partial", async () => {
    const { d, fake, active } = setup();
    fake.set(
      [],
      [
        "[graphify extract] semantic extraction is incomplete: 0 dispatched file(s) produced no nodes and 1 came back truncated or hollow. The shrink guard stays armed for this write; pass --allow-partial to overwrite a larger existing graph anyway.",
      ],
    );
    expect((await d.prepare("lib@1")).status).toBe("activated");
    expect(active().graph_status).toBe("partial");
    const stats = JSON.parse(active().stats);
    expect(stats.graphMissing).toEqual([]);
    expect(stats.graphWarnings[0]).toContain("came back truncated");
  });

  test("the next prepare of the same snapshot retries a partial graph, then counts as unchanged", async () => {
    const { d, fake, active } = setup();
    fake.set([stagedName("b.md")], omitted(stagedName("b.md")));
    const first = await d.prepare("lib@1");
    expect(active().graph_status).toBe("partial");

    fake.set([], []);
    const second = await d.prepare("lib@1");
    expect(second.status).toBe("activated");
    expect(second.generationId).not.toBe(first.generationId);
    expect(active().graph_status).toBe("ok");
    const stats = JSON.parse(active().stats);
    expect(stats.graphMissing).toEqual([]);
    expect(stats.groundedNodes).toBe(2);

    expect((await d.prepare("lib@1")).status).toBe("unchanged");
  });

  test("a partial graph with no grounded nodes still fails and keeps the previous generation", async () => {
    const { d, fake, dir, active } = setup();
    const good = await d.prepare("lib@1");
    expect(active().graph_status).toBe("ok");
    writeFileSync(join(dir, "a.md"), "# A\n\n## Otter knob\n\nChanged before an empty extraction.\n");
    fake.set([stagedName("a.md"), stagedName("b.md")], omitted(stagedName("a.md")));
    const err = await d.prepare("lib@1").catch((e) => e);
    expect(String(err)).toContain("no nodes grounded in passages");
    expect(active().id).toBe(good.generationId);
  });
});

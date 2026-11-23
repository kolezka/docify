import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { DocifyError } from "../src/core/docify.ts";
import { graphView } from "../src/core/graph-view.ts";
import { read } from "../src/core/search.ts";
import { startServer } from "../src/web/server.ts";
import { fakeGraph, newDocify, tempDir, writeDocs } from "./helpers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

// fakeGraph plus what real Graphify output carries: a link repeated in the other direction
// and a hyperedge, which prepare stores as "group:<label>" edges.
const runner: typeof fakeGraph = async (...args) => {
  const r = await fakeGraph(...args);
  const [first, second, third] = r.graph.nodes;
  r.graph.links.push({ source: second!.id, target: first!.id, relation: "references" });
  r.graph.hyperedges = [{ id: "h1", label: "Setup steps", nodes: [first!.id, second!.id, third!.id], relation: "form" }];
  return r;
};

// A stand-in Ollama server, so these tests need no local embedding model.
function setup() {
  const embed = Bun.serve({
    port: 0,
    async fetch(req) {
      const { input } = (await req.json()) as { input: string[] };
      return Response.json({ embeddings: input.map((t) => [t.length, 1, 2, 3]) });
    },
  });
  const d = newDocify(tempDir(), { embeddingProvider: "ollama", embeddingUrl: `http://127.0.0.1:${embed.port}`, embeddingModel: "stub", embeddingDims: 4, embeddingQueryPrefix: "" });
  cleanup.push(() => {
    d.close();
    embed.stop(true);
  });
  const dir = writeDocs(join(tempDir("docify-src-"), "lib"), {
    "guide.md": "# Guide\n\n## Install the CLI\n\nRun the installer.\n\n## Configure tokens\n\nSet the token.\n\n## Start the server\n\nRun serve.\n",
  });
  d.addSource({ library: "lib", version: "1", kind: "local", locator: dir });
  return d;
}

test("an unknown source is an error, not an empty graph", () => {
  const d = setup();
  expect(() => graphView(d, "nope@1")).toThrow(DocifyError);
});

test("a source that is not prepared, or prepared without a graph, has no nodes and says why", async () => {
  const d = setup();
  const before = graphView(d, "lib@1");
  expect(before.generation).toBeNull();
  expect(before.graphStatus).toBeNull();
  expect(before.nodes).toEqual([]);

  await d.prepare("lib@1", { graph: false });
  const skipped = graphView(d, "lib@1");
  expect(skipped.generation).not.toBeNull();
  expect(skipped.graphStatus).toBe("skipped");
  expect(skipped.nodes).toEqual([]);
  expect(skipped.stats.ignoredDocuments).toBe(0);
});

test("pages left out by graphIgnore are counted as ignored, not as missing", async () => {
  const d = setup();
  const dir = writeDocs(join(tempDir("docify-src-"), "two"), {
    "guide.md": "# Guide\n\n## Install\n\nRun the installer.\n",
    "notes-a.md": "# A\n\n## Draft a\n\nText.\n",
    "notes-b.md": "# B\n\n## Draft b\n\nText.\n",
  });
  d.addSource({ library: "two", version: "1", kind: "local", locator: dir, graphIgnore: ["^notes-"] });
  await d.prepare("two@1", { graphRunner: fakeGraph });
  const some = graphView(d, "two@1");
  expect(some.graphStatus).toBe("ok");
  expect(some.stats.ignoredDocuments).toBe(2);
  expect(some.stats.missingDocuments).toEqual([]);
  expect(some.nodes.every((n) => n.page === "guide.md")).toBe(true);

  // Every page ignored: no graph, and the view can say that the patterns are the reason.
  d.updateSourceIgnore("two@1", { graphIgnore: ["."] });
  await d.prepare("two@1", { graphRunner: fakeGraph });
  const none = graphView(d, "two@1");
  expect(none.graphStatus).toBe("skipped");
  expect(none.stats.ignoredDocuments).toBe(3);
  expect(none.nodes).toEqual([]);
});

test("the active graph comes back with pages, grounding, one edge per pair and hyperedges as groups", async () => {
  const d = setup();
  await d.prepare("lib@1", { graphRunner: runner });
  const g = graphView(d, "lib@1");
  expect(g.graphStatus).toBe("ok");
  expect(g.generation).toBe(d.getSource("lib@1")!.active_generation);
  expect(g.nodes.map((n) => n.label).sort()).toEqual(["Configure tokens", "Install the CLI", "Start the server"]);
  expect(g.nodes.every((n) => n.page === "guide.md")).toBe(true);

  // The chain has two links; the reversed duplicate and the group edges are not extra edges.
  expect(g.edges).toHaveLength(2);
  for (const e of g.edges) {
    expect(g.nodes[e.source]).toBeDefined();
    expect(g.nodes[e.target]).toBeDefined();
  }
  expect(g.stats.edges).toBe(2);
  expect(g.nodes.reduce((sum, n) => sum + n.degree, 0)).toBe(4);
  expect(g.groups).toEqual([{ label: "Setup steps", size: 3 }]);
  expect(g.nodes.every((n) => n.group === 0)).toBe(true);

  // Grounding points at a passage of this generation that read() resolves.
  const install = g.nodes.find((n) => n.label === "Install the CLI")!;
  expect(install.grounding).not.toBeNull();
  expect(install.grounding!.excerpt).toContain("installer");
  expect(read(d, install.grounding!.passage).status).toBe("ok");
  expect(g.stats.grounded).toBe(g.nodes.filter((n) => n.grounding).length);
});

// Graphify's raw (--no-cluster) output is not validated. The first two edges are the records
// that failed a real prepare with "NOT NULL constraint failed: graph_edges.src".
test("malformed records in graph.json are skipped and counted, they never fail the prepare", async () => {
  const d = setup();
  const broken: typeof fakeGraph = async (...args) => {
    const r = await fakeGraph(...args);
    const [first, second, third] = r.graph.nodes.map((n) => n.id);
    const bad: unknown[] = [
      { id: "claude_desktop_config_json", label: "claude_desktop_config.json", file_type: "document", source_file: "doc1.md" },
      { id: first, target: second, relation: "references", confidence: "EXTRACTED" },
      { source: first, target: null, relation: "references" },
      { source: first, target: third },
      null,
    ];
    r.graph.links.push(...(bad as typeof r.graph.links));
    r.graph.nodes.push({ id: "no_label" } as (typeof r.graph.nodes)[number]);
    r.graph.hyperedges = [
      { id: "h1", label: "Setup steps", nodes: [null, first, second, third], relation: "form" },
      { id: "h2", label: "Not a list", nodes: "abc", relation: "form" },
    ] as unknown as typeof r.graph.hyperedges;
    return r;
  };
  const result = await d.prepare("lib@1", { graphRunner: broken });
  expect(result.status).toBe("activated");
  // 5 edges, 1 node, 1 hyperedge member and 1 hyperedge.
  expect(result.stats).toMatchObject({ graphNodes: 3, graphEdges: 4, graphDropped: 8, graphMissing: [] });

  // Documents are all covered, so the graph is not partial: a retry would get the same cached records.
  const g = graphView(d, "lib@1");
  expect(g.graphStatus).toBe("ok");
  expect(g.nodes).toHaveLength(3);
  expect(g.edges).toHaveLength(2);
  expect(g.groups).toEqual([{ label: "Setup steps", size: 3 }]);
});

test("the web API serves the graph and maps an unknown source to 404", async () => {
  const d = setup();
  await d.prepare("lib@1", { graphRunner: runner });
  const server = await startServer(0, { docify: d, quiet: true, project: tempDir("docify-project-"), token: "a".repeat(32) });
  cleanup.push(() => server.stop(true));
  const get = (path: string) => fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { "x-docify-token": server.token! } });

  const ok = await get(`/api/sources/${encodeURIComponent("lib@1")}/graph`);
  expect(ok.status).toBe(200);
  expect((await ok.json()).nodes).toHaveLength(3);
  const missing = await get("/api/sources/nope%401/graph");
  expect(missing.status).toBe(404);
  expect((await missing.json()).code).toBe("source_unknown");
  expect((await fetch(`http://127.0.0.1:${server.port}/api/sources/lib%401/graph`)).status).toBe(401);
});

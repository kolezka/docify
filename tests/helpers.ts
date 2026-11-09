import { mkdtempSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docifyHome } from "../src/core/config.ts";
import { Docify } from "../src/core/docify.ts";
import { stagedName, type GraphRunResult } from "../src/core/graph.ts";

export const FIXTURES = join(import.meta.dir, "..", "fixtures", "corpus");
export const MODELS_DIR = process.env.DOCIFY_MODELS_DIR ?? join(docifyHome(), "models");

export function tempDir(prefix = "docify-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function newDocify(home: string, extra: Record<string, unknown> = {}) {
  return new Docify({ home, modelsDir: MODELS_DIR, ...extra });
}

export function copyFixture(name: string, into = tempDir("docify-src-")) {
  const dest = join(into, name);
  cpSync(join(FIXTURES, name), dest, { recursive: true });
  return dest;
}

export function writeDocs(dir: string, files: Record<string, string>) {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

// Deterministic stand-in for Graphify: one node per heading, linked to the next heading.
export const fakeGraph = async (_config: unknown, _sourceId: string, docs: { path: string; markdown: string }[]): Promise<GraphRunResult> => {
  const nodes: GraphRunResult["graph"]["nodes"] = [];
  const links: GraphRunResult["graph"]["links"] = [];
  const fileToPath = new Map<string, string>();
  for (const d of docs) {
    const file = stagedName(d.path);
    fileToPath.set(file, d.path);
    const headings = [...d.markdown.matchAll(/^#{2,3} (.+)$/gm)].map((m) => m[1]!.replace(/`/g, ""));
    headings.forEach((h, i) => {
      nodes.push({ id: `${file}:${i}`, label: h, source_file: file });
      if (i > 0) links.push({ source: `${file}:${i - 1}`, target: `${file}:${i}`, relation: "next" });
    });
  }
  const graph = { nodes, links };
  return { graph, graphJsonText: JSON.stringify(graph), fileToPath, durationMs: 0, tokensIn: 0, tokensOut: 0, costEstimate: null, log: "" };
};

import { expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGraphify } from "../src/core/graph.ts";
import { newDocify, tempDir } from "./helpers.ts";

// A fake Graphify that prints a line every `tickMs` for `ticks` lines, then writes a graph.
function fixture(ticks: number, tickMs: number, timeoutSeconds: number) {
  const dir = tempDir("docify-timeout-");
  const bin = join(dir, "graphify");
  writeFileSync(bin, `#!${process.execPath}
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const work = args[args.indexOf("--out") + 1];
for (let i = 0; i < ${ticks}; i++) { process.stdout.write("chunk " + i + " done\\n"); await Bun.sleep(${tickMs}); }
mkdirSync(join(work, "graphify-out"), { recursive: true });
writeFileSync(join(work, "graphify-out", "graph.json"), JSON.stringify({ nodes: [], edges: [] }));
`);
  chmodSync(bin, 0o755);
  return newDocify(tempDir(), { graphifyBin: bin, graph: { backend: "ollama", model: "fake", timeoutSeconds } });
}

test("graph timeout counts inactivity, so a run that keeps reporting progress outlives it", async () => {
  // 1.2 s of total work against a 0.5 s limit, with output every 0.1 s.
  const d = fixture(12, 100, 0.5);
  try {
    const result = await runGraphify(d.config, "busy", []);
    expect(result.log).toContain("chunk 11 done");
  } finally { d.close(); }
});

test("graph timeout stops a run that goes quiet and says so", async () => {
  const d = fixture(2, 1500, 0.3);
  try {
    await expect(runGraphify(d.config, "quiet", [])).rejects.toThrow(/stopped after 0\.3 s without output/);
  } finally { d.close(); }
});

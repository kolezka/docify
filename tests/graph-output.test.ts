import { expect, test } from "bun:test";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGraphify } from "../src/core/graph.ts";
import { newDocify, tempDir } from "./helpers.ts";

function fixture(exit = 0) {
  const dir = tempDir("docify-stream-");
  const release = join(dir, "release");
  const bin = join(dir, "graphify");
  writeFileSync(bin, `#!${process.execPath}
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const work = args[args.indexOf("--out") + 1];
process.stdout.write("graph fixture started\\n");
process.stderr.write("WARNING: fixture stderr\\n");
const bytes = new TextEncoder().encode("Zażółć\\rnext\\nfinal tail");
process.stdout.write(bytes.slice(0, 3));
await Bun.sleep(20);
process.stdout.write(bytes.slice(3));
const deadline = Date.now() + 3000;
while (!existsSync(${JSON.stringify(release)}) && Date.now() < deadline) await Bun.sleep(10);
mkdirSync(join(work, "graphify-out"), { recursive: true });
writeFileSync(join(work, "graphify-out", "graph.json"), JSON.stringify({ nodes: [], edges: [] }));
process.exit(${exit});
`);
  chmodSync(bin, 0o755);
  const d = newDocify(tempDir(), { graphifyBin: bin, graph: { backend: "ollama", model: "fake", timeoutSeconds: 10 } });
  return { d, release };
}

test("Graphify emits decoded stdout and stderr before exit and flushes the final fragment", async () => {
  const { d, release } = fixture();
  const lines: { stream: string; text: string }[] = [];
  let observedBeforeExit = false;
  try {
    const result = await runGraphify(d.config, "fixture", [], undefined, false, (stream, text) => {
      lines.push({ stream, text });
      if (text === "graph fixture started") {
        observedBeforeExit = !existsSync(release);
        writeFileSync(release, "go");
      }
    });
    expect(observedBeforeExit).toBe(true);
    expect(lines).toContainEqual({ stream: "stderr", text: "WARNING: fixture stderr" });
    expect(lines.filter((line) => line.stream === "stdout").map((line) => line.text)).toEqual(["graph fixture started", "Zażółć", "next", "final tail"]);
    expect(result.log).toContain("final tail");
    expect(result.log).toContain("WARNING: fixture stderr");
  } finally { d.close(); }
});

test("Graphify preserves streamed output and failure diagnostics on nonzero exit", async () => {
  const { d, release } = fixture(7);
  const lines: string[] = [];
  writeFileSync(release, "go");
  try {
    await expect(runGraphify(d.config, "failure", [], undefined, false, (_stream, text) => lines.push(text))).rejects.toThrow("graphify extract exited 7");
    expect(lines).toContain("final tail");
    expect(lines).toContain("WARNING: fixture stderr");
  } finally { d.close(); }
});

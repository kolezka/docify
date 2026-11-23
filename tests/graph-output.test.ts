import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGraphify, runtimeEnv } from "../src/core/graph.ts";
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
writeFileSync(join(work, "argv.json"), JSON.stringify(args));
writeFileSync(join(work, "env.json"), JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("GRAPHIFY_")))));
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

test("Graphify receives configured extraction options and retains owned arguments", async () => {
  const { d, release } = fixture();
  Object.assign(d.config.graph!, { mode: "deep", tokenBudget: 12000, apiTimeoutSeconds: 45, maxWorkers: 3, maxConcurrency: 2 });
  writeFileSync(release, "go");
  try {
    await runGraphify(d.config, "options", [], undefined, true);
    const argv = JSON.parse(readFileSync(join(d.config.home, "graphify", "options", "argv.json"), "utf8")) as string[];
    for (const [flag, value] of [["--mode", "deep"], ["--token-budget", "12000"], ["--api-timeout", "45"], ["--max-workers", "3"], ["--max-concurrency", "2"]]) {
      expect(argv[argv.indexOf(flag!) + 1]).toBe(value);
    }
    expect(argv).toContain("--no-cluster");
    expect(argv).toContain("--force");
    expect(argv[argv.indexOf("--out") + 1]).toBe(join(d.config.home, "graphify", "options"));
  } finally { d.close(); }
});

const graphifyEnv = (d: ReturnType<typeof newDocify>, sourceId: string) =>
  JSON.parse(readFileSync(join(d.config.home, "graphify", sourceId, "env.json"), "utf8")) as Record<string, string>;

test("Graphify receives the request settings as its own environment variables", async () => {
  const { d, release } = fixture();
  Object.assign(d.config.graph!, { maxOutputTokens: 32000, temperature: 0.2, maxRetries: 0, maxRetryDepth: 0, disableThinking: true });
  writeFileSync(release, "go");
  try {
    await runGraphify(d.config, "tuned", []);
    expect(graphifyEnv(d, "tuned")).toEqual({
      GRAPHIFY_MAX_OUTPUT_TOKENS: "32000",
      GRAPHIFY_LLM_TEMPERATURE: "0.2",
      GRAPHIFY_MAX_RETRIES: "0",
      GRAPHIFY_MAX_RETRY_DEPTH: "0",
      GRAPHIFY_DISABLE_THINKING: "1",
    });
  } finally { d.close(); }
});

test("unset request settings stay out of Graphify's environment, and so do the server's own", async () => {
  const { d, release } = fixture();
  Object.assign(d.config.graph!, { maxOutputTokens: null, temperature: null, disableThinking: false });
  writeFileSync(release, "go");
  const before = process.env.GRAPHIFY_MAX_RETRIES;
  process.env.GRAPHIFY_MAX_RETRIES = "99";
  try {
    await runGraphify(d.config, "plain", []);
    expect(graphifyEnv(d, "plain")).toEqual({});
  } finally {
    if (before === undefined) delete process.env.GRAPHIFY_MAX_RETRIES;
    else process.env.GRAPHIFY_MAX_RETRIES = before;
    d.close();
  }
});

test("a zero temperature or retry count is sent, not treated as unset", () => {
  expect(runtimeEnv({ backend: "openai", model: "m", temperature: 0, maxRetries: 0, maxRetryDepth: 0 })).toEqual({
    GRAPHIFY_LLM_TEMPERATURE: "0",
    GRAPHIFY_MAX_RETRIES: "0",
    GRAPHIFY_MAX_RETRY_DEPTH: "0",
  });
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

test("allowPartial passes --allow-partial to Graphify, and only when it is on", async () => {
  const { d, release } = fixture();
  writeFileSync(release, "go");
  const argvOf = (id: string) => JSON.parse(readFileSync(join(d.config.home, "graphify", id, "argv.json"), "utf8")) as string[];
  try {
    await runGraphify(d.config, "strict", []);
    expect(argvOf("strict")).not.toContain("--allow-partial");
    d.config.graph!.allowPartial = true;
    await runGraphify(d.config, "lenient", []);
    expect(argvOf("lenient")).toContain("--allow-partial");
  } finally { d.close(); }
});

test("a refused shrink points at allowPartial, not at --force", async () => {
  const dir = tempDir("docify-shrink-");
  const bin = join(dir, "graphify");
  writeFileSync(bin, `#!/bin/sh
echo "[graphify extract] error: extraction was incomplete and the resulting --no-cluster graph is smaller than the existing graph.json (505 < 4000 nodes). Refusing to overwrite a complete graph with a partial one." >&2
exit 1
`);
  chmodSync(bin, 0o755);
  const d = newDocify(tempDir(), { graphifyBin: bin, graph: { backend: "ollama", model: "fake", timeoutSeconds: 10 } });
  try {
    const error = await runGraphify(d.config, "shrink", []).then(() => null, (e: Error) => e);
    expect(error?.message).toContain("allowPartial");
    expect(error?.message).not.toContain("--force");
  } finally { d.close(); }
});

test("diagnostic, local-backend and limit settings reach Graphify as flags and variables", async () => {
  const { d, release } = fixture();
  Object.assign(d.config.graph!, { timing: true, debug: true, noBackup: true, parallelLocal: true, ollamaNumCtx: 32768, ollamaKeepAlive: "5m", maxGraphMb: 2048 });
  writeFileSync(release, "go");
  try {
    await runGraphify(d.config, "extras", []);
    const argv = JSON.parse(readFileSync(join(d.config.home, "graphify", "extras", "argv.json"), "utf8")) as string[];
    expect(argv).toContain("--timing");
    expect(graphifyEnv(d, "extras")).toEqual({
      GRAPHIFY_DEBUG: "1",
      GRAPHIFY_NO_BACKUP: "1",
      GRAPHIFY_OLLAMA_PARALLEL: "1",
      GRAPHIFY_CLAUDE_CLI_PARALLEL: "1",
      GRAPHIFY_OLLAMA_NUM_CTX: "32768",
      GRAPHIFY_OLLAMA_KEEP_ALIVE: "5m",
      GRAPHIFY_MAX_GRAPH_BYTES: "2048MB",
    });
  } finally { d.close(); }
});

test("the extra settings stay out of argv and the environment when off or unset", async () => {
  const { d, release } = fixture();
  Object.assign(d.config.graph!, { timing: false, debug: false, noBackup: false, parallelLocal: false, ollamaNumCtx: null, ollamaKeepAlive: null, maxGraphMb: null });
  writeFileSync(release, "go");
  try {
    await runGraphify(d.config, "extras-off", []);
    const argv = JSON.parse(readFileSync(join(d.config.home, "graphify", "extras-off", "argv.json"), "utf8")) as string[];
    expect(argv).not.toContain("--timing");
    expect(graphifyEnv(d, "extras-off")).toEqual({});
  } finally { d.close(); }
});

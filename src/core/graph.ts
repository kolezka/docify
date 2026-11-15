import { mkdirSync, readdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DocifyConfig, GraphProviderConfig } from "./config.ts";
import { sha256 } from "./hash.ts";

export interface GraphNode {
  id: string;
  label: string;
  norm_label?: string;
  file_type?: string;
  source_file?: string | null;
}
export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  confidence?: string;
}
export interface GraphJson {
  nodes: GraphNode[];
  links: GraphEdge[];
  input_tokens?: number;
  output_tokens?: number;
  hyperedges?: { id: string; label: string; nodes: string[]; relation: string }[];
}

export interface GraphRunResult {
  graph: GraphJson;
  graphJsonText: string;
  // Staged file name -> document path, so nodes can be mapped back.
  fileToPath: Map<string, string>;
  durationMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  costEstimate: string | null;
  log: string;
  // Graphify's own lines saying the extraction is incomplete; empty when it is complete.
  incomplete: string[];
}

export class GraphProviderError extends Error {}

// Graphify skips files whose names look sensitive (seen with "secrets.md"), so staged
// documents get neutral names. Letters and digits only: the model rewrote "d-<hash>.md"
// as "d_<hash>.md" in source_file and Graphify then dropped those nodes as out of scope.
export function stagedName(path: string): string {
  return `doc${sha256(path).slice(0, 12)}.md`;
}

export function providerEnv(provider: GraphProviderConfig): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "",
    LANG: "en_US.UTF-8",
    PYTHONUNBUFFERED: "1",
  };
  if (provider.backend === "openai") {
    const base = provider.baseUrlEnv ? process.env[provider.baseUrlEnv] : process.env.OPENAI_BASE_URL;
    const key = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : process.env.OPENAI_API_KEY;
    if (!base) throw new GraphProviderError(`graph provider base URL is not set (environment variable ${provider.baseUrlEnv ?? "OPENAI_BASE_URL"})`);
    if (!key) throw new GraphProviderError(`graph provider API key is not set (environment variable ${provider.apiKeyEnv ?? "OPENAI_API_KEY"})`);
    env.OPENAI_BASE_URL = base.replace(/\/$/, "") + (provider.baseUrlSuffix ?? "");
    env.OPENAI_API_KEY = key;
    env.OPENAI_MODEL = provider.model;
  }
  return env;
}

// Graphify reads these from its environment only, and it starts with a clean one.
export function runtimeEnv(provider: GraphProviderConfig): Record<string, string> {
  const env: Record<string, string> = {};
  if (provider.maxOutputTokens != null) env.GRAPHIFY_MAX_OUTPUT_TOKENS = String(provider.maxOutputTokens);
  if (provider.temperature != null) env.GRAPHIFY_LLM_TEMPERATURE = String(provider.temperature);
  if (provider.maxRetries != null) env.GRAPHIFY_MAX_RETRIES = String(provider.maxRetries);
  if (provider.maxRetryDepth != null) env.GRAPHIFY_MAX_RETRY_DEPTH = String(provider.maxRetryDepth);
  if (provider.disableThinking) env.GRAPHIFY_DISABLE_THINKING = "1";
  return env;
}

export async function runGraphify(
  config: DocifyConfig,
  sourceId: string,
  docs: { path: string; markdown: string }[],
  signal?: AbortSignal,
  force = false,
  onOutput?: (stream: "stdout" | "stderr", text: string) => void,
): Promise<GraphRunResult> {
  const provider = config.graph;
  if (!provider) throw new GraphProviderError("no graph provider configured");
  if (!existsSync(config.graphifyBin)) {
    throw new GraphProviderError(`Graphify is not installed at ${config.graphifyBin}. Run \`docify setup\`.`);
  }
  const work = join(config.home, "graphify", sourceId);
  const corpus = join(work, "corpus");
  mkdirSync(corpus, { recursive: true });
  const fileToPath = new Map<string, string>();
  const wanted = new Set<string>();
  for (const d of docs) {
    const name = stagedName(d.path);
    fileToPath.set(name, d.path);
    wanted.add(name);
    writeFileSync(join(corpus, name), d.markdown);
  }
  // Graphify's incremental extract drops nodes of files that disappear from the corpus.
  for (const name of readdirSync(corpus)) if (!wanted.has(name)) rmSync(join(corpus, name), { recursive: true, force: true });

  const argv = [
    config.graphifyBin,
    "extract",
    corpus,
    "--backend",
    provider.backend,
    "--model",
    provider.model,
    "--max-concurrency",
    String(provider.maxConcurrency ?? 4),
    "--token-budget",
    String(provider.tokenBudget ?? 60000),
    "--api-timeout",
    String(provider.apiTimeoutSeconds ?? 600),
    ...(provider.maxWorkers != null ? ["--max-workers", String(provider.maxWorkers)] : []),
    ...(provider.mode === "deep" ? ["--mode", "deep"] : []),
    "--no-cluster",
    "--out",
    work,
    // --force skips Graphify's semantic cache, which keeps a bad partial extraction otherwise.
    ...(force ? ["--force"] : []),
  ];
  const started = performance.now();
  const proc = Bun.spawn(argv, { env: { ...providerEnv(provider), ...runtimeEnv(provider) }, stdout: "pipe", stderr: "pipe", cwd: work });
  // SIGTERM first; SIGKILL if Graphify ignores it, so a hung extraction cannot hold the lock forever.
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    proc.kill();
    killTimer ??= setTimeout(() => proc.kill("SIGKILL"), 5000);
  };
  // An inactivity limit, not a wall clock: a large corpus takes longer than any fixed limit while
  // Graphify keeps reporting chunks, and a hung run still goes quiet and gets stopped.
  const idleSeconds = provider.timeoutSeconds ?? 900;
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const armTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => { timedOut = true; stop(); }, idleSeconds * 1000);
  };
  armTimeout();
  const onAbort = stop;
  signal?.addEventListener("abort", onAbort);
  // Read while it runs (a full pipe would block Graphify), but once it exits give the pipes
  // only 5 s: a grandchild holding them open must not hang preparation.
  const consume = (pipe: ReadableStream<Uint8Array>, stream: "stdout" | "stderr") => {
    const reader = pipe.getReader();
    const decoder = new TextDecoder();
    let full = "";
    let pending = "";
    const accept = (text: string, final = false) => {
      if (text && !timedOut) armTimeout();
      full += text;
      pending += text;
      const lines = pending.split(/\r\n|[\r\n]/);
      pending = lines.pop() ?? "";
      for (const line of lines) if (line) onOutput?.(stream, line);
      if (final && pending) { onOutput?.(stream, pending); pending = ""; }
    };
    const done = (async () => {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          accept(decoder.decode(chunk.value, { stream: true }));
        }
        accept(decoder.decode(), true);
      } finally { reader.releaseLock(); }
    })();
    return { done, text: () => full, cancel: () => reader.cancel().catch(() => {}) };
  };
  const out = consume(proc.stdout, "stdout");
  const err = consume(proc.stderr, "stderr");
  let code: number;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    code = await proc.exited;
    await Promise.race([
      Promise.all([out.done, err.done]),
      new Promise<void>((resolve) => { drainTimer = setTimeout(() => { void out.cancel(); void err.cancel(); resolve(); }, 5000); }),
    ]);
  } finally {
    clearTimeout(timeout);
    clearTimeout(killTimer);
    clearTimeout(drainTimer);
    signal?.removeEventListener("abort", onAbort);
  }
  const log = (out.text() + err.text()).trim();
  if (code !== 0) {
    const tail = log.split("\n").slice(-6).join("\n");
    if (timedOut) {
      throw new GraphProviderError(`graphify extract stopped after ${idleSeconds} s without output (graph timeoutSeconds). Finished chunks are cached, so the next prepare resumes; raise timeoutSeconds if the provider is slow. Last output: ${tail}`);
    }
    const hint = /semantic shrink|Refusing to overwrite/.test(log) ? " The provider returned a partial graph and Graphify cached it; rerun prepare with --force to re-extract." : "";
    throw new GraphProviderError(`graphify extract exited ${code}${proc.signalCode ? ` (${proc.signalCode})` : ""}: ${tail}${hint}`);
  }
  // A failed chunk or a file the model left out still exits 0 with a graph of the rest. Keep it:
  // prepare marks the generation partial, and Graphify's cache makes the next run resend only the gaps.
  const incomplete = /semantic chunk\(s\) failed|produced no nodes/.test(log)
    ? log.split("\n").filter((l) => /WARNING|failed|incomplete/.test(l))
    : [];
  const file = Bun.file(join(work, "graphify-out", "graph.json"));
  if (!(await file.exists())) throw new GraphProviderError("graphify extract finished without graph.json");
  const graphJsonText = await file.text();
  // The raw extraction (--no-cluster) names the edge list "edges"; clustered output uses "links".
  const parsed = JSON.parse(graphJsonText) as GraphJson & { edges?: GraphEdge[] };
  const graph: GraphJson = { ...parsed, links: parsed.links ?? parsed.edges ?? [] };
  if (!Array.isArray(graph.nodes)) throw new GraphProviderError("graph.json has no nodes array");
  const tokens = /tokens:\s*([\d,]+)\s*in\s*\/\s*([\d,]+)\s*out(?:,\s*est\. cost[^:]*:\s*(\S+))?/.exec(log);
  return {
    graph,
    graphJsonText,
    fileToPath,
    durationMs: Math.round(performance.now() - started),
    // graph.json totals survive cache hits, so only this run's log line counts as spend.
    tokensIn: tokens ? Number(tokens[1]!.replace(/,/g, "")) : 0,
    tokensOut: tokens ? Number(tokens[2]!.replace(/,/g, "")) : 0,
    costEstimate: tokens?.[3] ?? null,
    log,
    incomplete,
  };
}

// Terms that should appear in a passage that supports a node.
export function groundingTerms(label: string): string[] {
  const clean = label.replace(/\(.*?\)/g, "").replace(/`/g, "").trim();
  const terms = new Set([clean.toLowerCase()]);
  const parts = clean.split(".");
  if (parts.length > 1) {
    const last = parts[parts.length - 1]!;
    if (last.length >= 3) terms.add("." + last.toLowerCase());
  }
  return [...terms].filter((t) => t.length >= 3);
}

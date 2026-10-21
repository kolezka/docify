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

export async function runGraphify(
  config: DocifyConfig,
  sourceId: string,
  docs: { path: string; markdown: string }[],
  signal?: AbortSignal,
  force = false,
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
    "--no-cluster",
    "--out",
    work,
    // --force skips Graphify's semantic cache, which keeps a bad partial extraction otherwise.
    ...(force ? ["--force"] : []),
  ];
  const started = performance.now();
  const proc = Bun.spawn(argv, { env: providerEnv(provider), stdout: "pipe", stderr: "pipe", cwd: work });
  const timeout = setTimeout(() => proc.kill(), (provider.timeoutSeconds ?? 900) * 1000);
  const onAbort = () => proc.kill();
  signal?.addEventListener("abort", onAbort);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timeout);
  signal?.removeEventListener("abort", onAbort);
  const log = (stdout + stderr).trim();
  if (code !== 0) {
    const tail = log.split("\n").slice(-6).join("\n");
    const hint = /semantic shrink|Refusing to overwrite/.test(log) ? " The provider returned a partial graph and Graphify cached it; rerun prepare with --force to re-extract." : "";
    throw new GraphProviderError(`graphify extract exited ${code}${proc.signalCode ? ` (${proc.signalCode})` : ""}: ${tail}${hint}`);
  }
  if (/semantic chunk\(s\) failed|produced no nodes/.test(log)) {
    throw new GraphProviderError(`graphify extract returned partial results: ${log.split("\n").filter((l) => /WARNING|failed/.test(l)).join(" | ")}`);
  }
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

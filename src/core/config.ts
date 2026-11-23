import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface GraphProviderConfig {
  backend: string; // Graphify --backend value
  model: string;
  // Names of environment variables, never the values. Secrets stay out of the store.
  baseUrlEnv?: string;
  baseUrlSuffix?: string;
  apiKeyEnv?: string;
  maxConcurrency?: number;
  timeoutSeconds?: number;
  mode?: "standard" | "deep";
  tokenBudget?: number;
  apiTimeoutSeconds?: number;
  maxWorkers?: number | null;
  // The rest reach Graphify as GRAPHIFY_* variables. null leaves the choice to Graphify.
  maxOutputTokens?: number | null;
  temperature?: number | null;
  maxRetries?: number;
  maxRetryDepth?: number;
  disableThinking?: boolean;
  // Passes --allow-partial: an incomplete extraction may replace a larger graph from an earlier run.
  allowPartial?: boolean;
}

export interface DocifyConfig {
  home: string;
  // "transformers" runs the model in process; "ollama" calls an Ollama server at embeddingUrl;
  // "openai" calls any OpenAI-compatible /v1/embeddings server, such as a LiteLLM proxy.
  embeddingProvider: "transformers" | "ollama" | "openai";
  embeddingUrl: string;
  // For "openai": names of the environment variables holding the base URL and API key, never the values.
  embeddingBaseUrlEnv: string;
  embeddingApiKeyEnv: string;
  // For "openai": a remote server that stops answering must not hang a preparation forever.
  embeddingTimeoutSeconds: number;
  embeddingModel: string;
  embeddingQueryPrefix: string;
  embeddingDims: number;
  // Evidence gate thresholds on cosine similarity. They depend on the model's score scale.
  strongVectorSim: number;
  weakVectorSim: number;
  // Weight of lexical hits in combined fusion. Below 1, a page found only by words cannot push
  // vector hits down; 0.5 measured better with bge-m3 (docs/evaluation.md).
  lexicalWeight: number;
  graph: GraphProviderConfig | null;
  // How URL sources are fetched during prepare. "builtin" fetches pages directly; "crawl4ai" renders
  // each page through a Crawl4AI server at crawl4aiUrl (POST /crawl), for JavaScript-only docs.
  crawlProvider: "builtin" | "crawl4ai";
  maxPages: number;
  maxDepth: number;
  maxTotalMb: number; // 1 MB = 1,000,000 bytes
  crawl4aiUrl: string;
  // Name of the environment variable holding the Crawl4AI bearer token, never the value.
  crawl4aiApiKeyEnv: string;
  // Per page: a browser render is slower than a plain fetch.
  crawl4aiTimeoutSeconds: number;
  browserlessUrl: string;
  browserlessApiKeyEnv: string;
  browserlessTimeoutSeconds: number;
  graphifyBin: string;
  modelsDir: string;
  keepGenerations: number;
}

export const DEFAULT_GRAPH: GraphProviderConfig = {
  backend: "openai",
  model: "deepseek/deepseek-flash-nothink",
  baseUrlEnv: "LITELLM_BASE_URL",
  baseUrlSuffix: "/v1",
  apiKeyEnv: "LITELLM_API_KEY",
  maxConcurrency: 4,
  timeoutSeconds: 900,
  mode: "standard",
  tokenBudget: 60000,
  apiTimeoutSeconds: 600,
  maxWorkers: null,
  maxOutputTokens: null,
  temperature: null,
  maxRetries: 6,
  maxRetryDepth: 3,
  disableThinking: false,
  allowPartial: false,
};

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

type Env = Record<string, string | undefined>;

export function docifyHome(env: Env = process.env, userHome = homedir()): string {
  if (env.DOCIFY_HOME !== undefined) return env.DOCIFY_HOME;
  const current = join(userHome, ".config", "docify");
  const legacy = join(userHome, ".cache", "docify");
  // Stores made before the move to ~/.config keep working until they are moved.
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

export function configFilePath(home: string): string {
  return join(home, "config.json");
}

// A missing file is an empty config. A malformed one throws, so a save never overwrites it blindly.
export function readConfigFile(home: string): Record<string, unknown> {
  const file = configFilePath(home);
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  if (!isPlainObject(parsed)) throw new ConfigError(`${file} is not a JSON object`);
  return parsed;
}

export function defaultConfig(home: string, env: Env = process.env): DocifyConfig {
  return {
    home,
    embeddingProvider: "transformers",
    embeddingUrl: env.DOCIFY_EMBED_URL ?? "http://localhost:11434",
    embeddingBaseUrlEnv: "LITELLM_BASE_URL",
    embeddingApiKeyEnv: "LITELLM_API_KEY",
    embeddingTimeoutSeconds: 120,
    embeddingModel: "Xenova/bge-small-en-v1.5",
    embeddingQueryPrefix: "Represent this sentence for searching relevant passages: ",
    embeddingDims: 384,
    strongVectorSim: 0.65,
    weakVectorSim: 0.5,
    graph: DEFAULT_GRAPH,
    crawlProvider: "builtin",
    maxPages: 50,
    maxDepth: 2,
    maxTotalMb: 50,
    crawl4aiUrl: "http://127.0.0.1:11235",
    crawl4aiApiKeyEnv: "CRAWL4AI_API_KEY",
    crawl4aiTimeoutSeconds: 120,
    browserlessUrl: "http://127.0.0.1:3000",
    browserlessApiKeyEnv: "BROWSERLESS_API_KEY",
    browserlessTimeoutSeconds: 120,
    graphifyBin: env.DOCIFY_GRAPHIFY_BIN ?? join(home, "graphify-venv", "bin", "graphify"),
    modelsDir: env.DOCIFY_MODELS_DIR ?? join(home, "models"),
    keepGenerations: 3,
    lexicalWeight: 1,
  };
}

export const BYTES_PER_MB = 1_000_000;

// Older config.json files name the total crawl limit in bytes (maxTotalBytes). It is read as
// whole megabytes, rounded up so a crawl that fitted before still fits. maxTotalMb wins when both are set.
export function legacyMaxTotalMb(file: Record<string, unknown>): number | undefined {
  if ("maxTotalMb" in file || !("maxTotalBytes" in file)) return undefined;
  return Math.ceil(numberField("maxTotalBytes", file.maxTotalBytes, 1, 1_000_000_000, true) / BYTES_PER_MB);
}

export function withConfigFile(defaults: DocifyConfig, file: Record<string, unknown>): DocifyConfig {
  const config = { ...defaults, ...(file as Partial<DocifyConfig>) };
  config.maxTotalMb = legacyMaxTotalMb(file) ?? config.maxTotalMb;
  numberField("maxTotalMb", config.maxTotalMb, 1, 1000, true);
  return config;
}

export function loadConfig(home = docifyHome()): DocifyConfig {
  return withConfigFile(defaultConfig(home), readConfigFile(home));
}

// ---- editing (web UI) --------------------------------------------------------

export const EDITABLE_KEYS = [
  "embeddingProvider",
  "embeddingModel",
  "embeddingDims",
  "embeddingQueryPrefix",
  "embeddingUrl",
  "embeddingBaseUrlEnv",
  "embeddingApiKeyEnv",
  "embeddingTimeoutSeconds",
  "strongVectorSim",
  "weakVectorSim",
  "lexicalWeight",
  "graph",
  "keepGenerations",
  "crawlProvider",
  "maxPages",
  "maxDepth",
  "maxTotalMb",
  "crawl4aiUrl",
  "crawl4aiApiKeyEnv",
  "crawl4aiTimeoutSeconds",
  "browserlessUrl",
  "browserlessApiKeyEnv",
  "browserlessTimeoutSeconds",
] as const;
export type EditableKey = (typeof EDITABLE_KEYS)[number];
export type EditableConfig = Pick<DocifyConfig, EditableKey>;
export type ConfigPatch = Partial<Omit<EditableConfig, "graph">> & { graph?: Partial<GraphProviderConfig> | null };

// graphifyBin is executed during prepare and modelsDir is where model code is loaded from, so a
// browser must never be able to point them somewhere else. They stay editable in config.json.
const LOCKED_KEYS: Record<string, string> = { home: "DOCIFY_HOME", graphifyBin: "DOCIFY_GRAPHIFY_BIN", modelsDir: "DOCIFY_MODELS_DIR" };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// Model names reach argv and the model loader: no leading dash, no path traversal.
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const GRAPH_KEYS = ["backend", "model", "baseUrlEnv", "baseUrlSuffix", "apiKeyEnv", "maxConcurrency", "timeoutSeconds", "mode", "tokenBudget", "apiTimeoutSeconds", "maxWorkers", "maxOutputTokens", "temperature", "maxRetries", "maxRetryDepth", "disableThinking", "allowPartial"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function numberField(field: string, v: unknown, min: number, max: number, integer = false): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ConfigError(`${field} must be a number`, field);
  if (integer && !Number.isInteger(v)) throw new ConfigError(`${field} must be a whole number`, field);
  if (v < min || v > max) throw new ConfigError(`${field} must be between ${min} and ${max}`, field);
  return v;
}

function stringField(field: string, v: unknown, max: number, pattern?: RegExp, hint?: string): string {
  if (typeof v !== "string") throw new ConfigError(`${field} must be text`, field);
  const s = v.trim();
  if (s.length > max) throw new ConfigError(`${field} is longer than ${max} characters`, field);
  if (pattern && !pattern.test(s)) throw new ConfigError(`${field} ${hint ?? "has an invalid format"}`, field);
  return s;
}

const envNameField = (field: string, v: unknown) =>
  stringField(field, v, 128, ENV_NAME, "must be an environment variable name (letters, digits, underscore)");

function modelField(field: string, v: unknown): string {
  const s = stringField(field, v, 200, MODEL_NAME, "must be a model name such as bge-m3 or org/model");
  if (s.split("/").includes("..")) throw new ConfigError(`${field} must not contain ..`, field);
  return s;
}

function urlField(field: string, v: unknown): string {
  const s = stringField(field, v, 500);
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new ConfigError(`${field} must be a URL such as http://localhost:11434`, field);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ConfigError(`${field} must use http or https`, field);
  return s.replace(/\/+$/, "");
}

function graphField(v: unknown): Partial<GraphProviderConfig> | null {
  if (v === null) return null;
  if (!isPlainObject(v)) throw new ConfigError("graph must be an object or null", "graph");
  const out: Partial<GraphProviderConfig> = {};
  for (const [k, value] of Object.entries(v)) {
    const field = `graph.${k}`;
    switch (k) {
      case "backend":
        out.backend = stringField(field, value, 40, /^[A-Za-z0-9][A-Za-z0-9_-]*$/, "must be a Graphify backend name such as openai");
        break;
      case "model":
        out.model = modelField(field, value);
        break;
      case "baseUrlEnv":
        out.baseUrlEnv = envNameField(field, value);
        break;
      case "apiKeyEnv":
        out.apiKeyEnv = envNameField(field, value);
        break;
      case "baseUrlSuffix":
        out.baseUrlSuffix = stringField(field, value, 100, /^(\/[A-Za-z0-9._~/-]*)?$/, "must be empty or a path starting with /");
        break;
      case "maxConcurrency":
        out.maxConcurrency = numberField(field, value, 1, 64, true);
        break;
      case "timeoutSeconds":
        out.timeoutSeconds = numberField(field, value, 1, 86_400);
        break;
      case "mode":
        if (value !== "standard" && value !== "deep") throw new ConfigError(`${field} must be standard or deep`, field);
        out.mode = value;
        break;
      case "tokenBudget":
        out.tokenBudget = numberField(field, value, 1, 10_000_000, true);
        break;
      case "apiTimeoutSeconds":
        out.apiTimeoutSeconds = numberField(field, value, 1, 86_400);
        break;
      case "maxWorkers":
        out.maxWorkers = value === null ? null : numberField(field, value, 1, 256, true);
        break;
      case "maxOutputTokens":
        out.maxOutputTokens = value === null ? null : numberField(field, value, 1, 1_000_000, true);
        break;
      case "temperature":
        out.temperature = value === null ? null : numberField(field, value, 0, 2);
        break;
      case "maxRetries":
        out.maxRetries = numberField(field, value, 0, 100, true);
        break;
      case "maxRetryDepth":
        // Graphify splits a truncated chunk into up to 2**depth pieces, so the cap is low.
        out.maxRetryDepth = numberField(field, value, 0, 10, true);
        break;
      case "disableThinking":
        if (typeof value !== "boolean") throw new ConfigError(`${field} must be true or false`, field);
        out.disableThinking = value;
        break;
      case "allowPartial":
        if (typeof value !== "boolean") throw new ConfigError(`${field} must be true or false`, field);
        out.allowPartial = value;
        break;
      default:
        throw new ConfigError(`unknown graph setting: ${k} (known: ${GRAPH_KEYS.join(", ")})`, field);
    }
  }
  return out;
}

// Strict on purpose: a value of the wrong type or an unknown key is an error, never ignored.
export function validateConfigPatch(input: unknown): ConfigPatch {
  if (!isPlainObject(input)) throw new ConfigError("settings must be a JSON object");
  const out: ConfigPatch = {};
  for (const [key, v] of Object.entries(input)) {
    if (key in LOCKED_KEYS) {
      throw new ConfigError(`${key} cannot be changed from the web UI; edit config.json or set ${LOCKED_KEYS[key]}`, key);
    }
    switch (key as EditableKey) {
      case "embeddingProvider":
        if (v !== "transformers" && v !== "ollama" && v !== "openai") throw new ConfigError("embeddingProvider must be transformers, ollama or openai", key);
        out.embeddingProvider = v;
        break;
      case "embeddingModel":
        out.embeddingModel = modelField(key, v);
        break;
      case "embeddingDims":
        out.embeddingDims = numberField(key, v, 1, 65_536, true);
        break;
      case "embeddingQueryPrefix":
        // Not trimmed: a trailing space can be part of the prefix the model expects.
        if (typeof v !== "string" || v.length > 500) throw new ConfigError("embeddingQueryPrefix must be text of at most 500 characters", key);
        out.embeddingQueryPrefix = v;
        break;
      case "embeddingUrl":
        out.embeddingUrl = urlField(key, v);
        break;
      case "embeddingBaseUrlEnv":
        out.embeddingBaseUrlEnv = envNameField(key, v);
        break;
      case "embeddingApiKeyEnv":
        out.embeddingApiKeyEnv = envNameField(key, v);
        break;
      case "embeddingTimeoutSeconds":
        out.embeddingTimeoutSeconds = numberField(key, v, 1, 3600);
        break;
      case "strongVectorSim":
        out.strongVectorSim = numberField(key, v, 0, 1);
        break;
      case "weakVectorSim":
        out.weakVectorSim = numberField(key, v, 0, 1);
        break;
      case "lexicalWeight":
        out.lexicalWeight = numberField(key, v, 0, 10);
        break;
      case "keepGenerations":
        out.keepGenerations = numberField(key, v, 1, 100, true);
        break;
      case "graph":
        out.graph = graphField(v);
        break;
      case "maxPages":
        out.maxPages = numberField(key, v, 1, 100_000, true);
        break;
      case "maxDepth":
        out.maxDepth = numberField(key, v, 0, 1000, true);
        break;
      case "maxTotalMb":
        out.maxTotalMb = numberField(key, v, 1, 1000, true);
        break;
      case "crawlProvider":
        if (v !== "builtin" && v !== "crawl4ai") throw new ConfigError("crawlProvider must be builtin or crawl4ai", key);
        out.crawlProvider = v;
        break;
      case "crawl4aiUrl": {
        out.crawl4aiUrl = urlField(key, v);
        const url = new URL(out.crawl4aiUrl);
        if (url.username || url.password) throw new ConfigError("crawl4aiUrl must not contain credentials; name an environment variable for the key instead", key);
        break;
      }
      case "crawl4aiApiKeyEnv":
        out.crawl4aiApiKeyEnv = envNameField(key, v);
        break;
      case "crawl4aiTimeoutSeconds":
        out.crawl4aiTimeoutSeconds = numberField(key, v, 1, 3600);
        break;
      case "browserlessUrl": {
        out.browserlessUrl = urlField(key, v);
        const url = new URL(out.browserlessUrl);
        if (url.username || url.password || url.search || url.hash) throw new ConfigError("browserlessUrl must not contain credentials, query parameters or a fragment; name an environment variable for the key instead", key);
        break;
      }
      case "browserlessApiKeyEnv":
        out.browserlessApiKeyEnv = envNameField(key, v);
        break;
      case "browserlessTimeoutSeconds":
        out.browserlessTimeoutSeconds = numberField(key, v, 1, 3600);
        break;
      default:
        throw new ConfigError(`unknown setting: ${key}`, key);
    }
  }
  return out;
}

// Writes only the changed keys; keys the UI does not know survive. A partial graph object is
// merged over the current one (or the default), because a partial graph in config.json would
// otherwise replace the whole default provider.
export function saveConfig(home: string, input: unknown, env: Env = process.env): DocifyConfig {
  const patch = validateConfigPatch(input);
  const file = readConfigFile(home);
  const next: Record<string, unknown> = { ...file };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "graph" && value !== null) {
      next.graph = { ...(isPlainObject(file.graph) ? file.graph : DEFAULT_GRAPH), ...(value as Partial<GraphProviderConfig>) };
    } else next[key] = value;
  }
  if ("maxTotalMb" in patch) delete next.maxTotalBytes;
  const effective = withConfigFile(defaultConfig(home, env), next);
  if (effective.weakVectorSim > effective.strongVectorSim) {
    throw new ConfigError("weakVectorSim must not be above strongVectorSim", "weakVectorSim");
  }
  const g = effective.graph;
  if (g && (typeof g.backend !== "string" || !g.backend || typeof g.model !== "string" || !g.model)) {
    throw new ConfigError("graph needs a backend and a model", "graph");
  }
  mkdirSync(home, { recursive: true });
  const target = configFilePath(home);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  renameSync(tmp, target);
  return effective;
}

// ---- describing (web UI) -----------------------------------------------------

export interface PathSetting {
  value: string;
  source: "config.json" | "environment" | "default";
  variable: string;
}

export interface EnvEntry {
  name: string;
  purpose: string;
  set: boolean;
  // Only for Docify's own path and URL variables; credential variables never expose a value.
  value: string | null;
}

export interface ConfigDescription {
  values: EditableConfig;
  defaults: EditableConfig;
  inFile: string[];
  paths: { home: string; configFile: string; graphifyBin: PathSetting; modelsDir: PathSetting };
  environment: EnvEntry[];
}

function pick(config: DocifyConfig): EditableConfig {
  return Object.fromEntries(EDITABLE_KEYS.map((k) => [k, config[k]])) as EditableConfig;
}

export function describeConfig(config: DocifyConfig, env: Env = process.env): ConfigDescription {
  const file = readConfigFile(config.home);
  const pathSetting = (key: "graphifyBin" | "modelsDir", variable: string): PathSetting => ({
    value: config[key],
    source: key in file ? "config.json" : env[variable] !== undefined ? "environment" : "default",
    variable,
  });
  const own: [string, string][] = [
    ["DOCIFY_HOME", "store location"],
    ["DOCIFY_MODELS_DIR", "embedding model cache, unless config.json sets modelsDir"],
    ["DOCIFY_GRAPHIFY_BIN", "Graphify executable, unless config.json sets graphifyBin"],
    ["DOCIFY_EMBED_URL", "Ollama URL, unless config.json sets embeddingUrl"],
    ["DOCIFY_PROJECT", "project whose .docify.json pins apply in CLI search and MCP"],
  ];
  const credentials = new Map<string, string[]>();
  const addCredential = (name: string | undefined, purpose: string) => {
    if (name) credentials.set(name, [...(credentials.get(name) ?? []), purpose]);
  };
  addCredential(config.embeddingBaseUrlEnv, "embedding base URL");
  addCredential(config.embeddingApiKeyEnv, "embedding API key");
  addCredential(config.graph?.baseUrlEnv, "graph base URL");
  addCredential(config.graph?.apiKeyEnv, "graph API key");
  addCredential(config.crawl4aiApiKeyEnv, "Crawl4AI token");
  addCredential(config.browserlessApiKeyEnv, "Browserless token");
  return {
    values: pick(config),
    defaults: pick(defaultConfig(config.home, env)),
    inFile: Object.keys(file),
    paths: {
      home: config.home,
      configFile: configFilePath(config.home),
      graphifyBin: pathSetting("graphifyBin", "DOCIFY_GRAPHIFY_BIN"),
      modelsDir: pathSetting("modelsDir", "DOCIFY_MODELS_DIR"),
    },
    environment: [
      ...own.map(([name, purpose]) => ({ name, purpose, set: env[name] !== undefined, value: env[name] ?? null })),
      ...[...credentials].map(([name, purposes]) => ({ name, purpose: purposes.join(", "), set: !!env[name], value: null })),
    ],
  };
}

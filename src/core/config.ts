import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export interface GraphProviderConfig {
  backend: string; // Graphify --backend value
  model: string;
  // Names of environment variables, never the values. Secrets stay out of the store.
  baseUrlEnv?: string;
  baseUrlSuffix?: string;
  apiKeyEnv?: string;
  maxConcurrency?: number;
  timeoutSeconds?: number;
}

export interface DocifyConfig {
  home: string;
  embeddingModel: string;
  embeddingQueryPrefix: string;
  embeddingDims: number;
  graph: GraphProviderConfig | null;
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
};

export function docifyHome(): string {
  return process.env.DOCIFY_HOME ?? join(homedir(), ".cache", "docify");
}

export function loadConfig(home = docifyHome()): DocifyConfig {
  const file = join(home, "config.json");
  const user = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<DocifyConfig>) : {};
  return {
    home,
    embeddingModel: "Xenova/bge-small-en-v1.5",
    embeddingQueryPrefix: "Represent this sentence for searching relevant passages: ",
    embeddingDims: 384,
    graph: DEFAULT_GRAPH,
    graphifyBin: process.env.DOCIFY_GRAPHIFY_BIN ?? join(home, "graphify-venv", "bin", "graphify"),
    modelsDir: process.env.DOCIFY_MODELS_DIR ?? join(home, "models"),
    keepGenerations: 3,
    ...user,
  };
}

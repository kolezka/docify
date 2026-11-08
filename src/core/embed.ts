import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import type { DocifyConfig } from "./config.ts";

export class ModelNotPreparedError extends Error {}

// Huge code blocks exceed the model context; servers answer 413 for them.
const SERVER_MAX_CHARS = 16000;

const loaded = new Map<string, Promise<FeatureExtractionPipeline>>();

// Stored with every generation. Vectors from different providers are not interchangeable,
// even for the same model name.
export function embeddingIdentity(config: DocifyConfig): string {
  return config.embeddingProvider === "transformers" ? config.embeddingModel : `${config.embeddingProvider}:${config.embeddingModel}`;
}

function configure(config: DocifyConfig, allowDownload: boolean) {
  env.cacheDir = config.modelsDir;
  env.allowRemoteModels = allowDownload;
  env.allowLocalModels = true;
}

// Only `docify setup` passes allowDownload. Search and prepare load from the local cache.
export async function loadEmbedder(config: DocifyConfig, allowDownload = false): Promise<FeatureExtractionPipeline> {
  const key = `${config.modelsDir}|${config.embeddingModel}`;
  let p = loaded.get(key);
  if (!p) {
    configure(config, allowDownload);
    p = pipeline("feature-extraction", config.embeddingModel, { dtype: "fp32" }).catch((err) => {
      loaded.delete(key);
      if (!allowDownload) {
        throw new ModelNotPreparedError(
          `Embedding model ${config.embeddingModel} is not in the local cache (${config.modelsDir}). Run \`docify setup\` once with network access. (${String(err).slice(0, 160)})`,
        );
      }
      throw err;
    });
    loaded.set(key, p);
  }
  return p;
}

class PayloadTooLarge extends Error {}

async function ollamaPost(config: DocifyConfig, texts: string[], signal?: AbortSignal): Promise<number[][]> {
  let res: Response;
  try {
    res = await fetch(`${config.embeddingUrl.replace(/\/$/, "")}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.embeddingModel, input: texts }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ModelNotPreparedError(
      `Ollama at ${config.embeddingUrl} is not reachable (${String(err).slice(0, 120)}). Start it with \`docker compose up -d\` in the docify checkout, or fix embeddingUrl.`,
    );
  }
  if (res.status === 413) throw new PayloadTooLarge();
  if (res.status === 404) {
    throw new ModelNotPreparedError(
      `Ollama at ${config.embeddingUrl} has no model ${config.embeddingModel}: run \`ollama pull ${config.embeddingModel}\` there (docker-compose.yml does it).`,
    );
  }
  if (!res.ok) throw new Error(`Ollama /api/embed returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { embeddings: number[][] }).embeddings;
}

function openaiEndpoint(config: DocifyConfig) {
  const base = process.env[config.embeddingBaseUrlEnv];
  const key = process.env[config.embeddingApiKeyEnv];
  if (!base) throw new ModelNotPreparedError(`embedding server base URL is not set (environment variable ${config.embeddingBaseUrlEnv})`);
  if (!key) throw new ModelNotPreparedError(`embedding server API key is not set (environment variable ${config.embeddingApiKeyEnv})`);
  const root = base.replace(/\/+$/, "");
  return { url: `${root.endsWith("/v1") ? root : `${root}/v1`}/embeddings`, key };
}

async function openaiPost(config: DocifyConfig, texts: string[], signal?: AbortSignal): Promise<number[][]> {
  const { url, key } = openaiEndpoint(config);
  const timeout = AbortSignal.timeout(config.embeddingTimeoutSeconds * 1000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: config.embeddingModel, input: texts, encoding_format: "float" }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    if (timeout.aborted) throw new Error(`embedding server at ${url} did not answer within ${config.embeddingTimeoutSeconds} s`);
    throw new ModelNotPreparedError(`embedding server at ${url} is not reachable (${String(err).slice(0, 120)}); check ${config.embeddingBaseUrlEnv}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new ModelNotPreparedError(`embedding server at ${url} rejected the API key (HTTP ${res.status}); check ${config.embeddingApiKeyEnv}`);
  }
  // Error bodies can echo the key back, so it is masked before it reaches a log.
  const body = res.ok ? "" : (await res.text()).replaceAll(key, "<redacted>").slice(0, 200);
  if (res.status === 413 || (res.status === 400 && /context length|too long|too many tokens/i.test(body))) throw new PayloadTooLarge();
  if (!res.ok) throw new Error(`embedding server ${url} returned HTTP ${res.status} for model ${config.embeddingModel}: ${body}`);
  const data = ((await res.json()) as { data?: { index: number; embedding: number[] }[] }).data ?? [];
  if (data.length !== texts.length) throw new Error(`embedding server returned ${data.length} vectors for ${texts.length} inputs`);
  return [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

// One vector per text, in order. Splits batches and shortens single texts the server rejects.
async function embedSplitting(post: (texts: string[]) => Promise<number[][]>, texts: string[]): Promise<number[][]> {
  try {
    return await post(texts);
  } catch (err) {
    if (!(err instanceof PayloadTooLarge)) throw err;
    if (texts.length > 1) {
      const mid = Math.floor(texts.length / 2);
      return [...(await embedSplitting(post, texts.slice(0, mid))), ...(await embedSplitting(post, texts.slice(mid)))];
    }
    const text = texts[0]!;
    if (text.length < 500) throw new Error(`embedding server rejected a ${text.length}-character input as too large`);
    return embedSplitting(post, [text.slice(0, Math.floor(text.length / 2))]);
  }
}

function normalized(v: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(v);
  let sum = 0;
  for (const x of out) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < out.length; i++) out[i]! /= norm;
  return out;
}

// `signal` cancels a request already sent to an embedding server; the in-process model runs each batch to the end.
export async function embedTexts(config: DocifyConfig, texts: string[], prefix = "", signal?: AbortSignal): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  const check = (dim: number) => {
    if (dim !== config.embeddingDims) throw new Error(`model ${config.embeddingModel} returned ${dim} dims, expected ${config.embeddingDims}`);
  };
  if (config.embeddingProvider !== "transformers") {
    // A remote server pays a round trip per request, so it gets bigger batches.
    const size = config.embeddingProvider === "openai" ? 64 : 16;
    const post = config.embeddingProvider === "openai" ? (t: string[]) => openaiPost(config, t, signal) : (t: string[]) => ollamaPost(config, t, signal);
    for (let i = 0; i < texts.length; i += size) {
      const batch = texts.slice(i, i + size).map((t) => (prefix + t).slice(0, SERVER_MAX_CHARS));
      for (const v of await embedSplitting(post, batch)) {
        check(v.length);
        out.push(normalized(v));
      }
    }
    return out;
  }
  const extractor = await loadEmbedder(config);
  for (let i = 0; i < texts.length; i += 16) {
    const batch = texts.slice(i, i + 16).map((t) => prefix + t);
    const tensor = await extractor(batch, { pooling: "mean", normalize: true });
    const [n, dim] = tensor.dims as [number, number];
    check(dim);
    const data = tensor.data as Float32Array;
    for (let j = 0; j < n; j++) out.push(data.slice(j * dim, (j + 1) * dim));
  }
  return out;
}

export function embedQuery(config: DocifyConfig, query: string) {
  return embedTexts(config, [query], config.embeddingQueryPrefix).then((v) => v[0]!);
}

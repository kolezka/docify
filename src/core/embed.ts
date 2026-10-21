import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import type { DocifyConfig } from "./config.ts";

export class ModelNotPreparedError extends Error {}

const loaded = new Map<string, Promise<FeatureExtractionPipeline>>();

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

export async function embedTexts(config: DocifyConfig, texts: string[], prefix = ""): Promise<Float32Array[]> {
  const extractor = await loadEmbedder(config);
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 16) {
    const batch = texts.slice(i, i + 16).map((t) => prefix + t);
    const tensor = await extractor(batch, { pooling: "mean", normalize: true });
    const [n, dim] = tensor.dims as [number, number];
    if (dim !== config.embeddingDims) throw new Error(`model ${config.embeddingModel} returned ${dim} dims, expected ${config.embeddingDims}`);
    const data = tensor.data as Float32Array;
    for (let j = 0; j < n; j++) out.push(data.slice(j * dim, (j + 1) * dim));
  }
  return out;
}

export function embedQuery(config: DocifyConfig, query: string) {
  return embedTexts(config, [query], config.embeddingQueryPrefix).then((v) => v[0]!);
}

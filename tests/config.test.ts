import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, DEFAULT_GRAPH, describeConfig, docifyHome, loadConfig, saveConfig, validateConfigPatch } from "../src/core/config.ts";
import { tempDir } from "./helpers.ts";

test("the store defaults to ~/.config/docify, and a store left in ~/.cache/docify is used until it is moved", () => {
  const user = tempDir("docify-user-");
  const current = join(user, ".config", "docify");
  const legacy = join(user, ".cache", "docify");
  expect(docifyHome({}, user)).toBe(current);
  mkdirSync(legacy, { recursive: true });
  expect(docifyHome({}, user)).toBe(legacy);
  mkdirSync(current, { recursive: true });
  expect(docifyHome({}, user)).toBe(current);
  expect(docifyHome({ DOCIFY_HOME: "/srv/docify" }, user)).toBe("/srv/docify");
});

const fileOf = (home: string) => JSON.parse(readFileSync(join(home, "config.json"), "utf8"));

function rejects(fn: () => unknown, field: string, pattern: RegExp) {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  expect((caught as ConfigError).field).toBe(field);
  expect((caught as ConfigError).message).toMatch(pattern);
}

test("paths that run or load code cannot be changed through the settings API", () => {
  rejects(() => validateConfigPatch({ graphifyBin: "/tmp/evil" }), "graphifyBin", /cannot be changed from the web UI.*DOCIFY_GRAPHIFY_BIN/);
  rejects(() => validateConfigPatch({ modelsDir: "/tmp/models" }), "modelsDir", /DOCIFY_MODELS_DIR/);
  rejects(() => validateConfigPatch({ home: "/tmp/other" }), "home", /DOCIFY_HOME/);
  rejects(() => validateConfigPatch({ graph: { backend: "openai", model: "m", bin: "/x" } }), "graph.bin", /unknown graph setting/);
  rejects(() => validateConfigPatch({ lexicalWeigth: 0.5 }), "lexicalWeigth", /unknown setting/);
});

test("wrong types and out-of-range values are errors, never coerced or dropped", () => {
  rejects(() => validateConfigPatch({ lexicalWeight: "0.5" }), "lexicalWeight", /must be a number/);
  rejects(() => validateConfigPatch({ strongVectorSim: 1.2 }), "strongVectorSim", /between 0 and 1/);
  rejects(() => validateConfigPatch({ embeddingDims: 10.5 }), "embeddingDims", /whole number/);
  rejects(() => validateConfigPatch({ keepGenerations: 0 }), "keepGenerations", /between 1 and 100/);
  rejects(() => validateConfigPatch({ embeddingProvider: "cohere" }), "embeddingProvider", /transformers, ollama or openai/);
  rejects(() => validateConfigPatch({ embeddingApiKeyEnv: "sk-live-123 456" }), "embeddingApiKeyEnv", /environment variable name/);
  rejects(() => validateConfigPatch({ embeddingModel: "--help" }), "embeddingModel", /model name/);
  rejects(() => validateConfigPatch({ embeddingModel: "org/../../etc" }), "embeddingModel", /\.\./);
  rejects(() => validateConfigPatch({ embeddingUrl: "file:///etc/passwd" }), "embeddingUrl", /http or https/);
  rejects(() => validateConfigPatch({ graph: { maxConcurrency: 0 } }), "graph.maxConcurrency", /between 1 and 64/);
  rejects(() => validateConfigPatch({ graph: { mode: "fast" } }), "graph.mode", /standard or deep/);
  rejects(() => validateConfigPatch({ graph: { tokenBudget: 0 } }), "graph.tokenBudget", /between/);
  rejects(() => validateConfigPatch({ graph: { apiTimeoutSeconds: -1 } }), "graph.apiTimeoutSeconds", /between/);
  rejects(() => validateConfigPatch({ graph: { maxWorkers: 1.5 } }), "graph.maxWorkers", /whole number/);
  rejects(() => validateConfigPatch({ graph: { maxOutputTokens: 0 } }), "graph.maxOutputTokens", /between/);
  rejects(() => validateConfigPatch({ graph: { temperature: 2.5 } }), "graph.temperature", /between 0 and 2/);
  rejects(() => validateConfigPatch({ graph: { temperature: "none" } }), "graph.temperature", /must be a number/);
  rejects(() => validateConfigPatch({ graph: { maxRetries: -1 } }), "graph.maxRetries", /between 0 and 100/);
  rejects(() => validateConfigPatch({ graph: { maxRetryDepth: 11 } }), "graph.maxRetryDepth", /between 0 and 10/);
  rejects(() => validateConfigPatch({ graph: { disableThinking: "yes" } }), "graph.disableThinking", /true or false/);
  expect(validateConfigPatch({ lexicalWeight: 0.5, embeddingUrl: "http://gpu:11434/", graph: null })).toEqual({ lexicalWeight: 0.5, embeddingUrl: "http://gpu:11434", graph: null });
});

test("saving writes only the changed keys and keeps keys the UI does not know", () => {
  const home = tempDir();
  writeFileSync(join(home, "config.json"), JSON.stringify({ futureKey: { a: 1 }, graphifyBin: "/opt/graphify", embeddingModel: "bge-m3" }));
  const next = saveConfig(home, { lexicalWeight: 0.5 }, {});
  expect(fileOf(home)).toEqual({ futureKey: { a: 1 }, graphifyBin: "/opt/graphify", embeddingModel: "bge-m3", lexicalWeight: 0.5 });
  expect(next.lexicalWeight).toBe(0.5);
  expect(loadConfig(home).lexicalWeight).toBe(0.5);
});

test("a partial graph change is merged over the default provider, not written as a partial object", () => {
  const home = tempDir();
  saveConfig(home, { graph: { model: "other/model" } }, {});
  expect(fileOf(home).graph).toEqual({ ...DEFAULT_GRAPH, model: "other/model" });
  expect(loadConfig(home).graph).toEqual({ ...DEFAULT_GRAPH, model: "other/model" });

  saveConfig(home, { graph: null }, {});
  expect(loadConfig(home).graph).toBeNull();
  saveConfig(home, { graph: { maxConcurrency: 2 } }, {});
  expect(loadConfig(home).graph).toEqual({ ...DEFAULT_GRAPH, maxConcurrency: 2 });
});

test("graph extraction settings round-trip and workers can return to automatic", () => {
  const home = tempDir();
  saveConfig(home, { graph: { mode: "deep", tokenBudget: 12345, apiTimeoutSeconds: 30, maxWorkers: 2 } }, {});
  expect(loadConfig(home).graph).toMatchObject({ mode: "deep", tokenBudget: 12345, apiTimeoutSeconds: 30, maxWorkers: 2 });
  saveConfig(home, { graph: { maxWorkers: null } }, {});
  expect(loadConfig(home).graph?.maxWorkers).toBeNull();
});

test("graph request settings round-trip, keep zero and can return to the Graphify default", () => {
  const home = tempDir();
  saveConfig(home, { graph: { maxOutputTokens: 32000, temperature: 0, maxRetries: 0, maxRetryDepth: 0, disableThinking: true } }, {});
  expect(loadConfig(home).graph).toMatchObject({ maxOutputTokens: 32000, temperature: 0, maxRetries: 0, maxRetryDepth: 0, disableThinking: true });
  saveConfig(home, { graph: { maxOutputTokens: null, temperature: null, disableThinking: false } }, {});
  expect(loadConfig(home).graph).toMatchObject({ maxOutputTokens: null, temperature: null, maxRetries: 0, disableThinking: false });
});

test("cross-field rules use the merged values", () => {
  const home = tempDir();
  writeFileSync(join(home, "config.json"), JSON.stringify({ strongVectorSim: 0.58 }));
  rejects(() => saveConfig(home, { weakVectorSim: 0.6 }, {}), "weakVectorSim", /must not be above strongVectorSim/);
  expect(fileOf(home)).toEqual({ strongVectorSim: 0.58 });
  writeFileSync(join(home, "config.json"), JSON.stringify({ graph: { model: "only-a-model" } }));
  rejects(() => saveConfig(home, { lexicalWeight: 0.5 }, {}), "graph", /needs a backend and a model/);
});

test("a malformed config.json is an error for readers and is never overwritten", () => {
  for (const body of ["{ not json", "[1, 2]", '"text"']) {
    const home = tempDir();
    writeFileSync(join(home, "config.json"), body);
    expect(() => loadConfig(home)).toThrow(ConfigError);
    expect(() => describeConfig({ ...loadConfigSafe(home), home })).toThrow(ConfigError);
    expect(() => saveConfig(home, { lexicalWeight: 0.5 }, {})).toThrow(ConfigError);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(body);
  }
  // Positive control: a missing file is an empty config, not an error.
  const missing = tempDir();
  expect(loadConfig(missing).embeddingProvider).toBe("transformers");
  expect(describeConfig(loadConfig(missing)).inFile).toEqual([]);
});

// describeConfig needs a config object even when the file is broken; build one from defaults.
function loadConfigSafe(home: string) {
  try {
    return loadConfig(home);
  } catch {
    return loadConfig(tempDir());
  }
}

test("the description never exposes credential values and names where each path comes from", () => {
  const home = tempDir();
  writeFileSync(join(home, "config.json"), JSON.stringify({ embeddingApiKeyEnv: "MY_KEY", graphifyBin: "/opt/graphify" }));
  const env = { MY_KEY: "sk-secret-value", LITELLM_API_KEY: "sk-other-secret", LITELLM_BASE_URL: "https://llm.example", DOCIFY_MODELS_DIR: "/models", DOCIFY_HOME: home };
  const config = { ...loadConfig(home), modelsDir: "/models" };
  const d = describeConfig(config, env);
  const text = JSON.stringify(d);
  expect(text).not.toContain("sk-secret-value");
  expect(text).not.toContain("sk-other-secret");
  expect(text).not.toContain("https://llm.example");
  expect(d.environment.find((e) => e.name === "MY_KEY")).toEqual({ name: "MY_KEY", purpose: "embedding API key", set: true, value: null });
  expect(d.environment.find((e) => e.name === "LITELLM_API_KEY")).toMatchObject({ purpose: "graph API key", set: true, value: null });
  expect(d.environment.find((e) => e.name === "DOCIFY_HOME")).toMatchObject({ set: true, value: home });
  expect(d.paths.graphifyBin).toEqual({ value: "/opt/graphify", source: "config.json", variable: "DOCIFY_GRAPHIFY_BIN" });
  expect(d.paths.modelsDir).toEqual({ value: "/models", source: "environment", variable: "DOCIFY_MODELS_DIR" });
  expect(d.inFile.sort()).toEqual(["embeddingApiKeyEnv", "graphifyBin"]);
  expect(d.values.embeddingApiKeyEnv).toBe("MY_KEY");
  expect(d.defaults.embeddingApiKeyEnv).toBe("LITELLM_API_KEY");
});

test("crawl limits have validated persisted global defaults", () => {
  const home = tempDir();
  expect(loadConfig(home)).toMatchObject({ maxPages: 50, maxDepth: 2, maxTotalBytes: 50_000_000 });
  saveConfig(home, { maxPages: 123, maxDepth: 0, maxTotalBytes: 100_000_000 });
  expect(loadConfig(home)).toMatchObject({ maxPages: 123, maxDepth: 0, maxTotalBytes: 100_000_000 });
  expect(describeConfig(loadConfig(home)).values.maxTotalBytes).toBe(100_000_000);
  for (const value of [0, -1, 1.5, "3", 1_000_000_001]) expect(() => validateConfigPatch({ maxTotalBytes: value })).toThrow();
  for (const value of [0, -1, 1.5, "3", 100001]) expect(() => validateConfigPatch({ maxPages: value })).toThrow();
  for (const value of [-1, 1.5, "3", 1001]) expect(() => validateConfigPatch({ maxDepth: value })).toThrow();
});

test("config.example.json passes the strict settings check and spells out the whole graph object", () => {
  const example = JSON.parse(readFileSync(join(import.meta.dir, "..", "config.example.json"), "utf8"));
  expect(validateConfigPatch(example)).toEqual(example);
  // A partial graph in config.json replaces the defaults, so the example must list every key.
  expect(Object.keys(example.graph).sort()).toEqual(Object.keys(DEFAULT_GRAPH).sort());
  const home = tempDir();
  writeFileSync(join(home, "config.json"), JSON.stringify(example));
  expect(loadConfig(home)).toMatchObject(example);
});

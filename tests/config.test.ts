import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, DEFAULT_GRAPH, describeConfig, loadConfig, saveConfig, validateConfigPatch } from "../src/core/config.ts";
import { tempDir } from "./helpers.ts";

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

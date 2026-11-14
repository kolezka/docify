import { expect, test } from "bun:test";
import { DEFAULT_GRAPH, validateConfigPatch } from "../src/core/config.ts";
import { GRAPH_KEYS, graphChanges, graphErrors, graphForm } from "../src/web/lib/graph-settings.ts";

const saved = { ...DEFAULT_GRAPH, maxWorkers: 2, maxOutputTokens: 32000, temperature: 0.2 };

test("the settings form knows every graph key the store has", () => {
  expect<string[]>([...GRAPH_KEYS].sort()).toEqual(Object.keys(DEFAULT_GRAPH).sort());
});

test("the default graph form has no errors and nothing to save", () => {
  const form = graphForm(DEFAULT_GRAPH, null);
  expect(graphErrors(form)).toEqual({});
  expect(graphChanges(form, graphForm(DEFAULT_GRAPH, null))).toEqual({});
});

// Svelte binds an emptied number input to null. A blank optional field must be accepted and saved as null.
test("an emptied optional field is valid and is saved as null", () => {
  const before = graphForm(DEFAULT_GRAPH, saved);
  const form = { ...before, maxWorkers: null, maxOutputTokens: null, temperature: null };
  expect(graphErrors(form)).toEqual({});
  const changes = graphChanges(form, before);
  expect(changes).toEqual({ maxWorkers: null, maxOutputTokens: null, temperature: null });
  expect(validateConfigPatch({ graph: changes })).toEqual({ graph: changes });
});

test("an optional field that was already blank is not reported as changed", () => {
  const before = graphForm(DEFAULT_GRAPH, null);
  expect(graphChanges({ ...before, maxWorkers: undefined, maxOutputTokens: null }, before)).toEqual({});
});

test("zero is a value: it is kept for temperature and both retry settings", () => {
  const before = graphForm(DEFAULT_GRAPH, null);
  const form = { ...before, temperature: 0, maxRetries: 0, maxRetryDepth: 0 };
  expect(graphErrors(form)).toEqual({});
  expect(graphChanges(form, before)).toEqual({ temperature: 0, maxRetries: 0, maxRetryDepth: 0 });
});

test("required and out-of-range graph numbers are reported at their field", () => {
  const form = { ...graphForm(DEFAULT_GRAPH, null), tokenBudget: null, maxConcurrency: 0, maxWorkers: 1.5, maxOutputTokens: 0, temperature: 3, maxRetries: null, maxRetryDepth: 11 };
  expect(Object.keys(graphErrors(form)).sort()).toEqual(
    ["graph.maxConcurrency", "graph.maxOutputTokens", "graph.maxRetries", "graph.maxRetryDepth", "graph.maxWorkers", "graph.temperature", "graph.tokenBudget"],
  );
});

test("turning the graph on sends every set value and leaves blank ones out", () => {
  const changes = graphChanges(graphForm(DEFAULT_GRAPH, null), null);
  expect(changes).toMatchObject({ backend: "openai", maxRetries: 6, maxRetryDepth: 3, disableThinking: false });
  for (const key of ["maxWorkers", "maxOutputTokens", "temperature"]) expect(changes).not.toHaveProperty(key);
});

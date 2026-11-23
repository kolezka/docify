import type { GraphProviderConfig } from "../../core/config.ts";
import { OLLAMA_DURATION } from "../../core/ollama-duration.ts";

export const GRAPH_KEYS = [
  "backend",
  "model",
  "baseUrlEnv",
  "baseUrlSuffix",
  "apiKeyEnv",
  "maxConcurrency",
  "timeoutSeconds",
  "mode",
  "tokenBudget",
  "apiTimeoutSeconds",
  "maxWorkers",
  "maxOutputTokens",
  "temperature",
  "maxRetries",
  "maxRetryDepth",
  "disableThinking",
  "allowPartial",
  "timing",
  "debug",
  "noBackup",
  "parallelLocal",
  "ollamaNumCtx",
  "ollamaKeepAlive",
  "maxGraphMb",
] as const;
export type GraphKey = (typeof GRAPH_KEYS)[number];

// Svelte binds an emptied number input to null, so every number here can be null while editing.
export type GraphForm = {
  backend: string;
  model: string;
  baseUrlEnv?: string;
  baseUrlSuffix?: string;
  apiKeyEnv?: string;
  mode?: "standard" | "deep";
  maxConcurrency?: number | null;
  timeoutSeconds?: number | null;
  tokenBudget?: number | null;
  apiTimeoutSeconds?: number | null;
  maxWorkers?: number | null;
  maxOutputTokens?: number | null;
  temperature?: number | null;
  maxRetries?: number | null;
  maxRetryDepth?: number | null;
  disableThinking?: boolean;
  allowPartial?: boolean;
  timing?: boolean;
  debug?: boolean;
  noBackup?: boolean;
  parallelLocal?: boolean;
  ollamaNumCtx?: number | null;
  ollamaKeepAlive?: string | null;
  maxGraphMb?: number | null;
};

export const GRAPH_SWITCHES = ["disableThinking", "allowPartial", "timing", "debug", "noBackup", "parallelLocal"] as const;
export type GraphSwitch = (typeof GRAPH_SWITCHES)[number];

export function graphForm(defaults: GraphProviderConfig | null, saved: GraphProviderConfig | null): GraphForm {
  const merged = { ...(defaults ?? { backend: "", model: "" }), ...(saved ?? {}) };
  const form: GraphForm = { ...merged };
  for (const key of GRAPH_SWITCHES) form[key] = merged[key] ?? false;
  return form;
}

const whole = (v: unknown, min: number, max = Infinity) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

// Keyed like the server's field names ("graph.maxWorkers"), so both kinds of error land on the same row.
export function graphErrors(g: GraphForm): Record<string, string> {
  const e: Record<string, string> = {};
  for (const key of ["tokenBudget", "apiTimeoutSeconds", "maxConcurrency", "timeoutSeconds"] as const) {
    if (!whole(g[key], 1)) e[`graph.${key}`] = "enter a positive whole number";
  }
  // Blank is a choice here, not a mistake: it hands the value back to Graphify.
  if (g.maxWorkers != null && !whole(g.maxWorkers, 1)) e["graph.maxWorkers"] = "enter a positive whole number, or leave blank for automatic";
  if (g.maxOutputTokens != null && !whole(g.maxOutputTokens, 1)) e["graph.maxOutputTokens"] = "enter a positive whole number, or leave blank for the default";
  const t = g.temperature;
  if (t != null && (typeof t !== "number" || Number.isNaN(t) || t < 0 || t > 2)) e["graph.temperature"] = "enter a number from 0 to 2, or leave blank for the default";
  if (g.ollamaNumCtx != null && !whole(g.ollamaNumCtx, 1024, 1_048_576)) e["graph.ollamaNumCtx"] = "enter a whole number from 1024 to 1048576, or leave blank for automatic";
  const keep = g.ollamaKeepAlive?.trim();
  if (keep && !OLLAMA_DURATION.test(keep)) e["graph.ollamaKeepAlive"] = "enter a duration such as 30m, 1h30m, 300 or -1, or leave blank for the default";
  if (g.maxGraphMb != null && !whole(g.maxGraphMb, 1, 1_048_576)) e["graph.maxGraphMb"] = "enter a positive whole number, or leave blank for the default";
  for (const [key, max] of [["maxRetries", 100], ["maxRetryDepth", 10]] as const) {
    if (!whole(g[key], 0, max)) e[`graph.${key}`] = `enter a whole number from 0 to ${max}`;
  }
  return e;
}

// The graph part of a settings patch: only what differs from `before`. `before` is null when the
// graph was switched off, and then every set value is sent.
export function graphChanges(g: GraphForm, before: GraphForm | null): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const k of GRAPH_KEYS) {
    // An emptied text field binds to "", which means the same as unset.
    const raw = g[k];
    const value = raw === "" ? null : (raw ?? null);
    if (before === null) {
      if (value !== null) changed[k] = value;
    } else if (value !== (before[k] === "" ? null : (before[k] ?? null))) {
      changed[k] = value;
    }
  }
  return changed;
}

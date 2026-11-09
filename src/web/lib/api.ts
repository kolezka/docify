export type { SourceInfo, SearchResult, SearchHit, SearchStatus, ReadResult, Mode } from "../../core/search.ts";
export type { GraphView, GraphViewNode } from "../../core/graph-view.ts";
export type { ConfigDescription, EditableConfig, EnvEntry, PathSetting } from "../../core/config.ts";

export interface PinsView {
  project: string;
  file: string | null;
  pins: Record<string, string>;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly field: string | null = null,
  ) {
    super(message);
  }
}

// The access token arrives in the URL fragment; keep it for this tab and drop it from the address bar.
function readToken(): string {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("token");
  try {
    if (fromHash) sessionStorage.setItem("docify-token", fromHash);
    if (fromHash) history.replaceState(null, "", location.pathname);
    return sessionStorage.getItem("docify-token") ?? fromHash ?? "";
  } catch {
    return fromHash ?? "";
  }
}

let token = readToken();
// A restarted server prints a new link; pasting it into this tab changes only the fragment.
addEventListener("hashchange", () => {
  if (new URLSearchParams(location.hash.slice(1)).has("token")) token = readToken();
});

export async function api<T>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const headers: Record<string, string> = { "x-docify-token": token };
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, {
    method: init?.method ?? "GET",
    signal: init?.signal,
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.code ?? String(res.status), data?.error ?? res.statusText, data?.field ?? null);
  return data as T;
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

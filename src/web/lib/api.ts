export type { SourceInfo, SearchResult, SearchHit, SearchStatus, ReadResult, Mode } from "../../core/search.ts";
export type { GraphView, GraphViewNode } from "../../core/graph-view.ts";
export type { ConfigDescription, EditableConfig, EnvEntry, PathSetting } from "../../core/config.ts";
export type { ImportResult } from "../../core/backup.ts";
import type { ImportResult } from "../../core/backup.ts";

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

// The whole store as a .tar.gz, saved through a temporary link.
export async function downloadBackup(): Promise<string> {
  const res = await fetch("/api/export", { headers: { "x-docify-token": token } });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(data?.code ?? String(res.status), data?.error ?? res.statusText);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "docify-backup.tar.gz";
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

export async function uploadBackup(file: File, opts: { force: boolean; keepConfig: boolean }): Promise<ImportResult> {
  const q = new URLSearchParams({ force: opts.force ? "1" : "0", keepConfig: opts.keepConfig ? "1" : "0" });
  const res = await fetch(`/api/import?${q}`, {
    method: "POST",
    headers: { "x-docify-token": token, "content-type": "application/octet-stream" },
    body: file,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.code ?? String(res.status), data?.error ?? res.statusText);
  return data as ImportResult;
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

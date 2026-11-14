import { ago } from "./format.ts";
import { searchStatusLabel } from "./ui.ts";

export interface KeyInfo {
  id: number;
  name: string;
  // How the key starts; the rest is shown once, when the key is made.
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface QueryInfo {
  id: number;
  at: string;
  via: "web" | "mcp";
  keyName: string | null;
  query: string;
  scope: string | null;
  status: string;
  hits: number;
}

// The command that adds this server to Claude Code. Other agents need only the address and the header.
export function connectCommand(origin: string, token: string): string {
  return `claude mcp add --transport http docify ${origin}/mcp --header "Authorization: Bearer ${token}"`;
}

export function keyDetail(key: KeyInfo, now = Date.now()): string {
  return [`${key.prefix}…`, `Created ${ago(key.createdAt, now)}`, key.lastUsedAt ? `Last used ${ago(key.lastUsedAt, now)}` : "Not used yet"].join(" · ");
}

// Where a search looked, how it ended, where it came from and when.
export function queryDetail(q: QueryInfo, now = Date.now()): string {
  const outcome = q.hits > 0 ? `${searchStatusLabel(q.status)}, ${q.hits} ${q.hits === 1 ? "passage" : "passages"}` : searchStatusLabel(q.status);
  const from = q.via === "web" ? "This site" : q.keyName ? `Key ${q.keyName}` : "MCP";
  return [q.scope ?? "All sources", outcome, from, ago(q.at, now)].join(" · ");
}

import { createHash, timingSafeEqual } from "node:crypto";
import { jsonError, type Guard } from "./guard.ts";

export interface BearerClient {
  name: string;
  token: string;
}

const MIN_TOKEN_LENGTH = 16;

// "name:token,name:token". Malformed input throws so a typo never starts an open server.
export function parseBearerClients(value: string | undefined): BearerClient[] {
  const entries = (value ?? "").split(/[\s,]+/).filter(Boolean);
  const clients = entries.map((entry) => {
    const at = entry.indexOf(":");
    const name = at > 0 ? entry.slice(0, at) : "";
    const token = at > 0 ? entry.slice(at + 1) : "";
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`DOCIFY_MCP_TOKENS: expected name:token, got an entry without a valid name`);
    if (token.length < MIN_TOKEN_LENGTH) throw new Error(`DOCIFY_MCP_TOKENS: the token for ${name} must be at least ${MIN_TOKEN_LENGTH} characters`);
    return { name, token };
  });
  const names = new Set(clients.map((c) => c.name));
  const tokens = new Set(clients.map((c) => c.token));
  if (names.size !== clients.length) throw new Error("DOCIFY_MCP_TOKENS: client names must be unique");
  if (tokens.size !== clients.length) throw new Error("DOCIFY_MCP_TOKENS: every client needs its own token");
  return clients;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

// Compares fixed-size digests against every client, so timing reveals neither length nor which client matched.
export function bearerAuth(clients: BearerClient[]): Guard {
  const known = clients.map((c) => ({ name: c.name, digest: digest(c.token) }));
  const unauthorized = () => jsonError(401, "unauthorized", "missing or wrong bearer token", { "www-authenticate": 'Bearer realm="docify"' });
  return (req, ctx) => {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
    if (!match) return unauthorized();
    const given = digest(match[1]!);
    let client: string | undefined;
    for (const k of known) if (timingSafeEqual(given, k.digest)) client = k.name;
    if (!client) return unauthorized();
    ctx.client = client;
    return null;
  };
}

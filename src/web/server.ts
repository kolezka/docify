import { homedir } from "node:os";
import { delimiter, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { Docify } from "../core/docify.ts";
import { uiAssets } from "./bundle.ts";
import { LOOPBACK_HOSTS, hostAllowed, hostGuard, originAllowed, parseAllowedHosts, splitList } from "../http/host.ts";
import { bearerAuth, parseBearerClients, type BearerClient } from "../http/auth.ts";
import { RateLimiter, parseRate, rateLimit, type RateLimit } from "../http/rate-limit.ts";
import { chain } from "../http/guard.ts";
import { clientIp } from "../http/client-ip.ts";
import { mcpHttpHandler } from "../mcp/http.ts";
import { DOCS_INIT, DOCS_PAGE } from "./openapi.ts";
import { IMPORT_MAX_BYTES, createApi, openApiSpec, withinSourceRoots } from "./api.ts";
import { VERSION } from "../version.ts";

export { IMPORT_MAX_BYTES, withinSourceRoots };

// Documentation excerpts are untrusted. The page renders them as text; this policy is the second line.
const PAGE_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

// Local sources are readable through the API, so they must stay inside DOCIFY_SOURCE_ROOTS
// (path list, default: the home directory).
export function parseSourceRoots(value = process.env.DOCIFY_SOURCE_ROOTS): string[] {
  const parts = (value ?? "").split(delimiter).map((s) => s.trim()).filter(Boolean);
  return (parts.length ? parts : [homedir()]).map((p) => p.replace(/^~(?=$|\/)/, homedir()));
}

export interface StartServerOptions {
  docify?: Docify;
  quiet?: boolean;
  token?: string;
  host?: string;
  allowedHosts?: string[];
  project?: string;
  // MCP over HTTP at /mcp; without clients the route does not exist. Defaults come from env.
  mcpClients?: BearerClient[];
  mcpClientRate?: RateLimit;
  mcpIpRate?: RateLimit;
  trustProxy?: boolean;
  now?: () => number;
}

const MCP_MAX_BODY_BYTES = 1024 * 1024;

function mcpSettings(opts: StartServerOptions) {
  const env = process.env;
  return {
    clients: opts.mcpClients ?? parseBearerClients(env.DOCIFY_MCP_TOKENS),
    clientRate: opts.mcpClientRate ?? parseRate(env.DOCIFY_MCP_RATE || "60/min", "DOCIFY_MCP_RATE"),
    ipRate: opts.mcpIpRate ?? parseRate(env.DOCIFY_MCP_IP_RATE || "120/min", "DOCIFY_MCP_IP_RATE"),
    trustProxy: opts.trustProxy ?? env.DOCIFY_TRUST_PROXY === "1",
  };
}

export async function startServer(port: number, opts: StartServerOptions = {}) {
  const docify = opts.docify ?? new Docify();
  // Queries never recover, so clean up what dead writers left once here, like prepare does.
  docify.recoverInterrupted();
  // The directory whose .docify.json pins apply, as for `docify search` run there.
  const project = resolve(opts.project ?? process.cwd());
  const sourceRoots = parseSourceRoots();
  const host = opts.host ?? process.env.DOCIFY_HOST ?? "127.0.0.1";
  let boundPort = port;
  // The token is optional. Without one, /api is open to anyone who reaches the port; Host and
  // Origin checks still apply. The UI reads it from the URL fragment, so it is never logged.
  const envToken = process.env.DOCIFY_WEB_TOKEN?.trim() || undefined;
  const token: string | null = opts.token ?? envToken ?? null;
  if (token !== null && token.length < 16) throw new Error("the web access token must be at least 16 characters (DOCIFY_WEB_TOKEN)");
  const tokenFromEnv = !opts.token && !!envToken;
  const configuredHosts = opts.allowedHosts?.length ? splitList(opts.allowedHosts.join(",")) : parseAllowedHosts();
  // Binding beyond loopback without an allowlist: keep working behind any reverse proxy,
  // but say so, because the Host check then only protects against nothing.
  const allowAnyHost = configuredHosts.length === 0 && !LOOPBACK_HOSTS.has(host);
  const allowedHosts = new Set(configuredHosts);
  const tokenOk = (given: string | null) =>
    token === null || (!!given && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token)));

  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const fail = (err: unknown) => {
    console.error(err);
    return json({ error: String(err instanceof Error ? err.message : err), code: "internal" }, 500);
  };

  // DNS rebinding and cross-site requests: only a known Host, JSON bodies only.
  // Store backups upload as raw bytes. That type also needs a CORS preflight, like JSON does.
  const guard = (req: Request, bodyType = "application/json"): Response | null => {
    const hostHeader = req.headers.get("host") ?? "";
    if (!allowAnyHost && !hostAllowed(hostHeader, allowedHosts)) return json({ error: "forbidden host", code: "forbidden" }, 403);
    if (!tokenOk(req.headers.get("x-docify-token"))) return json({ error: "missing or wrong access token; open the URL printed by docify serve", code: "unauthorized" }, 401);
    if (req.method !== "GET") {
      if (!(req.headers.get("content-type") ?? "").startsWith(bodyType)) return json({ error: `${bodyType} body required`, code: "unsupported" }, 415);
      const origin = req.headers.get("origin");
      if (origin && !originAllowed(origin, hostHeader)) return json({ error: "forbidden origin", code: "forbidden" }, 403);
    }
    return null;
  };

  // The API docs carry no data, so they need only a known Host, not the token.
  const swaggerFile = (name: string) => Bun.file(Bun.resolveSync(`swagger-ui-dist/${name}`, import.meta.dir));
  const docs = (body: () => BodyInit, type: string, extra: Record<string, string> = {}) => (req: Request) => {
    if (!allowAnyHost && !hostAllowed(req.headers.get("host") ?? "", allowedHosts)) return json({ error: "forbidden host", code: "forbidden" }, 403);
    return new Response(body(), { headers: { "content-type": type, "x-content-type-options": "nosniff", ...extra } });
  };

  // The IP limit runs before auth so guessing tokens is slow; the client limit runs after it.
  const mcp = mcpSettings(opts);
  const mcpPipeline = mcp.clients.length
    ? chain(
        [
          hostGuard(allowedHosts, allowAnyHost),
          rateLimit(new RateLimiter(mcp.ipRate, opts.now), (ctx) => `ip:${ctx.ip}`),
          bearerAuth(mcp.clients),
          rateLimit(new RateLimiter(mcp.clientRate, opts.now), (ctx) => ctx.client && `client:${ctx.client}`),
        ],
        mcpHttpHandler(docify, { project, maxBodyBytes: MCP_MAX_BODY_BYTES }),
      )
    : null;
  const mcpRoute = async (req: Request, srv: { requestIP(req: Request): { address: string } | null }) => {
    if (!mcpPipeline) return new Response("not found", { status: 404 });
    try {
      return await mcpPipeline(req, { ip: clientIp(req, srv.requestIP(req)?.address, mcp.trustProxy) });
    } catch (err) {
      return fail(err);
    }
  };

  const server = Bun.serve({
    hostname: host,
    port,
    development: false,
    maxRequestBodySize: IMPORT_MAX_BYTES,
    routes: {
      "/healthz": { GET: () => json({ ok: true, version: VERSION }) },
      "/mcp": mcpRoute,
      "/api/docs": { GET: docs(() => DOCS_PAGE, "text/html; charset=utf-8", { ...PAGE_HEADERS, "cache-control": "no-store" }) },
      "/api/docs/openapi.json": { GET: docs(() => JSON.stringify(openApiSpec()), "application/json") },
      "/api/docs/init.js": { GET: docs(() => DOCS_INIT, "text/javascript; charset=utf-8") },
      "/api/docs/swagger-ui.css": { GET: docs(() => swaggerFile("swagger-ui.css"), "text/css; charset=utf-8") },
      "/api/docs/swagger-ui-bundle.js": { GET: docs(() => swaggerFile("swagger-ui-bundle.js"), "text/javascript; charset=utf-8") },
    },
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path.startsWith("/api/")) return api.fetch(req);
      if (req.method !== "GET") return new Response("not found", { status: 404 });
      let assets;
      try {
        assets = await uiAssets();
      } catch (err) {
        console.error(err);
        return new Response(`Docify could not build its web UI:\n${err instanceof Error ? err.message : err}`, { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      const asset = assets.get(path);
      if (!asset) return new Response("not found", { status: 404 });
      const headers: Record<string, string> = { "content-type": asset.type, "x-content-type-options": "nosniff" };
      return new Response(asset.body, { headers: path === "/" ? { ...headers, ...PAGE_HEADERS, "cache-control": "no-store" } : headers });
    },
  });
  const api = createApi({ docify, project, sourceRoots, guard, noTimeout: (req) => server.timeout(req, 0) });
  boundPort = server.port!;
  for (const loopback of LOOPBACK_HOSTS) allowedHosts.add(`${loopback}:${boundPort}`);
  if (!opts.quiet) {
    const where = `${host}:${boundPort}`;
    const warning = allowAnyHost ? " DOCIFY_ALLOWED_HOSTS is unset, so any Host is accepted; set it to your public domain." : "";
    const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${boundPort}/`;
    if (tokenFromEnv) console.log(`Docify UI listening on ${where}; the access token comes from DOCIFY_WEB_TOKEN.${warning}`);
    else if (token === null) console.log(`Docify UI on ${url}; no access token is set (DOCIFY_WEB_TOKEN), so anyone who can reach this port can use it.${warning}`);
    else console.log(`Docify UI on ${url}#token=${token}${warning}`);
    if (mcpPipeline) {
      const names = mcp.clients.map((c) => c.name).join(", ");
      console.log(`MCP over HTTP on /mcp for ${names}; ${mcp.clientRate.limit} requests per ${mcp.clientRate.windowMs / 1000} s per client, ${mcp.ipRate.limit} per ${mcp.ipRate.windowMs / 1000} s per IP.`);
    }
  }
  return Object.assign(server, { token });
}

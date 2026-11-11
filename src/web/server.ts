import { homedir } from "node:os";
import { delimiter, join, resolve, sep } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { Docify, DocifyError } from "../core/docify.ts";
import { ConfigError, describeConfig } from "../core/config.ts";
import { read, search, sources, type Mode } from "../core/search.ts";
import { graphView } from "../core/graph-view.ts";
import { exportStore, importStore } from "../core/backup.ts";
import { uiAssets } from "./bundle.ts";
import { LogReadError } from "../core/logs.ts";
import { LOOPBACK_HOSTS, hostAllowed, hostGuard, originAllowed, parseAllowedHosts, splitList } from "../http/host.ts";
import { bearerAuth, parseBearerClients, type BearerClient } from "../http/auth.ts";
import { RateLimiter, parseRate, rateLimit, type RateLimit } from "../http/rate-limit.ts";
import { chain } from "../http/guard.ts";
import { clientIp } from "../http/client-ip.ts";
import { mcpHttpHandler } from "../mcp/http.ts";
import { DOCS_INIT, DOCS_PAGE, openApiSpec } from "./openapi.ts";
import { VERSION } from "../version.ts";

const STATUS_BY_CODE: Record<string, number> = { invalid_input: 400, exists: 409, busy: 409, source_unknown: 404 };

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

export function withinSourceRoots(realPath: string, roots: string[]): boolean {
  return roots.some((root) => {
    try {
      const realRoot = realpathSync(root);
      return realPath === realRoot || realPath.startsWith(realRoot + sep);
    } catch {
      return false;
    }
  });
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
// A store backup is uploaded whole; a real store is around 100 MB before compression.
export const IMPORT_MAX_BYTES = 1024 * 1024 * 1024;

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
  const running = new Map<string, AbortController>();
  const sourceRoots = parseSourceRoots();
  const host = opts.host ?? process.env.DOCIFY_HOST ?? "127.0.0.1";
  let boundPort = port;
  // Loopback is shared by every local user, so each server start gets a secret that is shown
  // only in the URL fragment (never sent to the server or logged) and required on /api.
  // A hosted deployment sets DOCIFY_WEB_TOKEN, which keeps the URL stable across restarts.
  const envToken = process.env.DOCIFY_WEB_TOKEN?.trim();
  const token = opts.token ?? envToken ?? Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
  if (token.length < 16) throw new Error("the web access token must be at least 16 characters (DOCIFY_WEB_TOKEN)");
  const tokenFromEnv = !opts.token && !!envToken;
  const configuredHosts = opts.allowedHosts?.length ? splitList(opts.allowedHosts.join(",")) : parseAllowedHosts();
  // Binding beyond loopback without an allowlist: keep working behind any reverse proxy,
  // but say so, because the Host check then only protects against nothing.
  const allowAnyHost = configuredHosts.length === 0 && !LOOPBACK_HOSTS.has(host);
  const allowedHosts = new Set(configuredHosts);
  const tokenOk = (given: string | null) => !!given && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));

  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const fail = (err: unknown) => {
    if (err instanceof LogReadError) return json({ error: err.message, code: "logs_unavailable" }, 500);
    if (err instanceof ConfigError) return json({ error: err.message, code: "invalid_input", field: err.field ?? null }, 400);
    if (err instanceof DocifyError) return json({ error: err.message, code: err.code }, STATUS_BY_CODE[err.code] ?? 400);
    docify.logs.append("docify", err instanceof Error ? err.message : String(err), "system", "error");
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

  // Set while an import swaps the store files; the database is closed for that moment.
  let importing = false;
  const api =
    (handler: (req: Request & { params: Record<string, string> }) => Promise<Response> | Response, bodyType?: string) =>
    async (req: Request & { params: Record<string, string> }) => {
      const blocked = guard(req, bodyType);
      if (blocked) return blocked;
      if (importing) return json({ error: "a store import is running; try again in a moment", code: "busy" }, 503);
      try {
        return await handler(req);
      } catch (err) {
        return fail(err);
      }
    };

  const body = async (req: Request) => {
    try {
      return (await req.json()) as Record<string, unknown>;
    } catch {
      throw new DocifyError("invalid_input", "invalid JSON body");
    }
  };
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const crawlProvider = (value: unknown, allowNull: boolean): "builtin" | "crawl4ai" | "browserless" | null => {
    if (value === null && allowNull) return null;
    if (value === "builtin" || value === "crawl4ai" || value === "browserless") return value;
    throw new DocifyError("invalid_input", "invalid crawlProvider");
  };
  const pinsView = () => ({ project, file: Docify.pinFile(project), pins: Docify.readPins(project) });

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
      "/api/logs": {
        GET: api((req) => {
          const params = new URL(req.url).searchParams;
          const integer = (key: string, fallback: number, min: number, max: number) => {
            const raw = params.get(key);
            if (raw === null) return fallback;
            const value = Number(raw);
            if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new DocifyError("invalid_input", `invalid ${key}`);
            return value;
          };
          return json(docify.logs.read(integer("after", 0, 0, Number.MAX_SAFE_INTEGER), integer("limit", 1000, 1, 1000)));
        }),
      },
      "/api/sources": {
        GET: api(() => json(sources(docify))),
        POST: api(async (req) => {
          const b = await body(req);
          const kind = b.kind === "url" ? "url" : "local";
          const locator = str(b.locator);
          const library = str(b.library);
          if (!locator || !library) throw new DocifyError("invalid_input", "library and locator are required");
          const provider = b.crawlProvider === undefined ? undefined : crawlProvider(b.crawlProvider, false)!;
          if (kind === "local") {
            if (provider !== undefined) throw new DocifyError("invalid_input", "crawlProvider is only valid for URL sources");
            // The UI may only register paths inside DOCIFY_SOURCE_ROOTS.
            let real: string;
            try {
              real = realpathSync(resolve(locator.replace(/^~(?=$|\/)/, homedir())));
            } catch {
              throw new DocifyError("invalid_input", `path does not exist: ${locator}`);
            }
            if (!withinSourceRoots(real, sourceRoots)) {
              throw new DocifyError("invalid_input", `local sources must be inside DOCIFY_SOURCE_ROOTS (${sourceRoots.join(delimiter)})`);
            }
            return json(docify.addSource({ library, version: str(b.version) ?? null, kind, locator: real }), 201);
          }
          return json(docify.addSource({ library, version: str(b.version) ?? null, kind, locator, crawlProvider: provider }), 201);
        }),
      },
      "/api/sources/:id": {
        PATCH: api(async (req) => {
          const b = await body(req);
          if (b.crawlProvider === undefined && b.crawl4ai === undefined) throw new DocifyError("invalid_input", "crawler settings are required");
          const provider = b.crawlProvider === undefined ? undefined : crawlProvider(b.crawlProvider, true);
          docify.updateSourceCrawler(decodeURIComponent(req.params.id!), provider, b.crawl4ai);
          return json({ ok: true });
        }),
        DELETE: api((req) => {
          if (running.has(req.params.id!)) throw new DocifyError("busy", "cancel the running preparation first");
          docify.removeSource(decodeURIComponent(req.params.id!));
          return json({ ok: true });
        }),
      },
      "/api/sources/:id/artifacts/:kind": {
        GET: api((req) => {
          const missing = () => json({ error: "artifact not found", code: "unavailable" }, 404);
          const id = decodeURIComponent(req.params.id!);
          const kind = req.params.kind;
          if (!/^[a-z0-9][a-z0-9._@-]{0,80}$/.test(id) || (kind !== "screenshot" && kind !== "pdf")) return missing();
          const source = docify.getSource(id);
          const generation = source?.active_generation;
          if (!generation || !Number.isSafeInteger(generation) || generation < 1) return missing();
          const filename = kind === "screenshot" ? "screenshot.png" : "page.pdf";
          let file: string;
          try {
            const root = realpathSync(join(docify.config.home, "snapshots"));
            file = join(root, id, String(generation), "artifacts", filename);
            if (realpathSync(file) !== file) return missing();
          } catch {
            return missing();
          }
          return new Response(Bun.file(file), { headers: {
            "content-type": kind === "screenshot" ? "image/png" : "application/pdf",
            "content-disposition": `attachment; filename="${filename}"`,
            "x-content-type-options": "nosniff",
            "cache-control": "no-store",
          } });
        }),
      },
      "/api/sources/:id/documents": {
        GET: api((req) => json(docify.db.transaction(() => {
          const source = docify.requireSource(decodeURIComponent(req.params.id!));
          const generation = source.active_generation ? docify.getGeneration(source.active_generation) : null;
          if (!generation || generation.status !== "active") return { source: source.id, generation: null, paths: [] };
          const rows = docify.db.query<{ path: string }, [number]>(
            "SELECT path FROM documents WHERE generation_id = ? ORDER BY path",
          ).all(generation.id);
          return { source: source.id, generation: generation.id, paths: rows.map((row) => row.path) };
        })())),
      },
      "/api/sources/:id/graph": { GET: api((req) => json(graphView(docify, decodeURIComponent(req.params.id!)))) },
      "/api/sources/:id/prepare": {
        POST: api(async (req) => {
          const id = decodeURIComponent(req.params.id!);
          docify.requireSource(id);
          if (running.has(id)) throw new DocifyError("busy", `${id} is already being prepared`);
          const b = await body(req);
          const controller = new AbortController();
          running.set(id, controller);
          docify
            .prepare(id, { graph: b.graph !== false, force: b.force === true, signal: controller.signal })
            .catch((err) => console.error(`prepare ${id} failed: ${err instanceof Error ? err.message : err}`))
            .finally(() => running.delete(id));
          return json({ started: id }, 202);
        }),
      },
      "/api/sources/:id/cancel": {
        POST: api((req) => {
          const c = running.get(decodeURIComponent(req.params.id!));
          if (!c) return json({ error: "nothing running", code: "not_running" }, 409);
          c.abort();
          return json({ cancelled: true });
        }),
      },
      "/api/search": {
        POST: api(async (req) => {
          const b = await body(req);
          const query = str(b.query);
          if (!query) throw new DocifyError("invalid_input", "query is required");
          const modes = ["combined", "lexical", "vector", "graph"];
          return json(
            await search(docify, {
              query,
              library: str(b.library),
              version: str(b.version),
              sources: Array.isArray(b.sources) ? b.sources.filter((s): s is string => typeof s === "string") : undefined,
              mode: modes.includes(String(b.mode)) ? (b.mode as Mode) : "combined",
              maxTokens: typeof b.maxTokens === "number" ? b.maxTokens : undefined,
              graphWeight: typeof b.graphWeight === "number" ? b.graphWeight : undefined,
              project,
            }),
          );
        }),
      },
      "/api/read/:id": { GET: api((req) => json(read(docify, req.params.id!))) },
      // Raw source is served only for stored passages, and only from the snapshot directory.
      "/api/raw/:id": {
        GET: api((req) => {
          const row = docify.db
            .query<{ raw_file: string }, [string]>("SELECT d.raw_file FROM passages p JOIN documents d ON d.id = p.document_id WHERE p.id = ?")
            .get(req.params.id!);
          if (!row) return json({ error: "unknown passage", code: "unavailable" }, 404);
          const root = realpathSync(join(docify.config.home, "snapshots"));
          const file = realpathSync(row.raw_file);
          if (!file.startsWith(root + sep)) return json({ error: "forbidden", code: "forbidden" }, 403);
          return new Response(Bun.file(file), { headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
        }),
      },
      "/api/config": {
        GET: api(() => json(describeConfig(docify.config))),
        PUT: api(async (req) => {
          const b = await body(req);
          if (running.size) throw new DocifyError("busy", `cannot change settings while preparing ${[...running.keys()].join(", ")}; wait or cancel first`);
          docify.saveConfig(b);
          return json(describeConfig(docify.config));
        }),
      },
      "/api/export": {
        GET: api(async () => {
          const { bytes, manifest } = await exportStore(docify);
          const name = `docify-backup-${manifest.createdAt.slice(0, 19).replace(/[:T]/g, "-")}.tar.gz`;
          return new Response(bytes, { headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" } });
        }),
      },
      "/api/import": {
        POST: api(async (req) => {
          const size = Number(req.headers.get("content-length") ?? "0");
          if (size > IMPORT_MAX_BYTES) throw new DocifyError("invalid_input", "the backup is larger than the upload limit; use docify import on the server");
          const data = new Uint8Array(await req.arrayBuffer());
          if (!data.length) throw new DocifyError("invalid_input", "empty upload");
          const q = new URL(req.url).searchParams;
          // Like adding one, an imported local source must be inside DOCIFY_SOURCE_ROOTS.
          const checkLocalSource = (path: string) => {
            const real = existsSync(path) ? realpathSync(path) : resolve(path);
            if (!withinSourceRoots(real, sourceRoots)) throw new DocifyError("invalid_input", `the backup has a local source outside DOCIFY_SOURCE_ROOTS: ${path}`);
          };
          importing = true;
          try {
            const r = await importStore(docify, data, { force: q.get("force") === "1", keepConfig: q.get("keepConfig") === "1", checkLocalSource });
            return json(r);
          } finally {
            importing = false;
          }
        }, "application/octet-stream"),
      },
      "/api/pins": {
        GET: api(() => json(pinsView())),
        PUT: api(async (req) => {
          const b = await body(req);
          const library = str(b.library);
          if (!library) throw new DocifyError("invalid_input", "library is required");
          if (b.version !== null && b.version !== undefined && typeof b.version !== "string") throw new DocifyError("invalid_input", "version must be text or null");
          Docify.setPin(project, library, str(b.version) ?? null);
          return json(pinsView());
        }),
      },
    },
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (req.method !== "GET" || path.startsWith("/api/")) return new Response("not found", { status: 404 });
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
  boundPort = server.port!;
  for (const loopback of LOOPBACK_HOSTS) allowedHosts.add(`${loopback}:${boundPort}`);
  if (!opts.quiet) {
    const where = `${host}:${boundPort}`;
    const warning = allowAnyHost ? " DOCIFY_ALLOWED_HOSTS is unset, so any Host is accepted; set it to your public domain." : "";
    if (tokenFromEnv) console.log(`Docify UI listening on ${where}; the access token comes from DOCIFY_WEB_TOKEN.${warning}`);
    else console.log(`Docify UI on http://${host === "0.0.0.0" ? "localhost" : host}:${boundPort}/#token=${token}${warning}`);
    if (mcpPipeline) {
      const names = mcp.clients.map((c) => c.name).join(", ");
      console.log(`MCP over HTTP on /mcp for ${names}; ${mcp.clientRate.limit} requests per ${mcp.clientRate.windowMs / 1000} s per client, ${mcp.ipRate.limit} per ${mcp.ipRate.windowMs / 1000} s per IP.`);
    }
  }
  return Object.assign(server, { token });
}

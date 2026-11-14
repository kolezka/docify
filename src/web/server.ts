import { homedir } from "node:os";
import { delimiter, join, resolve, sep } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Docify, DocifyError, validateIgnorePatterns } from "../core/docify.ts";
import { ConfigError, describeConfig } from "../core/config.ts";
import { read, search, sources, type Mode } from "../core/search.ts";
import { graphView } from "../core/graph-view.ts";
import { summarizeSource } from "../core/summary.ts";
import { exportStore, importStore } from "../core/backup.ts";
import { uiAssets } from "./bundle.ts";
import { LogReadError } from "../core/logs.ts";
import { LOOPBACK_HOSTS, hostAllowed, hostGuard, originAllowed, parseAllowedHosts, splitList } from "../http/host.ts";
import { bearerAuth, parseBearerClients, type BearerClient } from "../http/auth.ts";
import { RateLimiter, parseRate, rateLimit, type RateLimit } from "../http/rate-limit.ts";
import { chain } from "../http/guard.ts";
import { clientIp } from "../http/client-ip.ts";
import { OAuthError, githubAuthorizeUrl, githubProfile, type GitHubOAuthConfig } from "../http/github-oauth.ts";
import { AccountStore, SESSION_TTL_MS, parseAdmins, type AdminList, type UserRow } from "../core/accounts.ts";
import { mcpHttpHandler } from "../mcp/http.ts";
import { DOCS_INIT, DOCS_PAGE, openApiSpec } from "./openapi.ts";
import { VERSION } from "../version.ts";

const STATUS_BY_CODE: Record<string, number> = {
  invalid_input: 400,
  exists: 409,
  busy: 409,
  source_unknown: 404,
  generation_changed: 409,
  summary_failed: 502,
  invalid_summary: 502,
  user_unknown: 404,
  accounts_off: 404,
  conflict: 409,
};

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

// GitHub sign-in. With it on, people have accounts and roles and the shared web token is not used.
export interface AccountsOptions {
  github: GitHubOAuthConfig;
  admins: AdminList;
  // The address people open, such as https://docs.example.com. Required off loopback. With https
  // the cookies are Secure and carry the __Host- prefix, and writes must come from this origin.
  publicUrl?: string;
}

function parsePublicUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("DOCIFY_PUBLIC_URL must be a URL such as https://docs.example.com");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("DOCIFY_PUBLIC_URL must be only a scheme and host, such as https://docs.example.com");
  }
  return url.origin;
}

// Called by `docify serve`, not by startServer: Bun loads .env in tests too, and a server
// started there with a token must not turn into an accounts server behind the test's back.
export function accountsFromEnv(env: Record<string, string | undefined> = process.env): AccountsOptions | null {
  const clientId = env.DOCIFY_GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.DOCIFY_GITHUB_CLIENT_SECRET?.trim();
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) throw new Error("set both DOCIFY_GITHUB_CLIENT_ID and DOCIFY_GITHUB_CLIENT_SECRET, or neither");
  const publicUrl = parsePublicUrl(env.DOCIFY_PUBLIC_URL);
  return {
    github: { clientId, clientSecret, redirectUri: publicUrl ? `${publicUrl}/auth/github/callback` : undefined },
    admins: parseAdmins(env.DOCIFY_ADMINS),
    publicUrl,
  };
}

type Access = "member" | "admin";
const SESSION_COOKIE = "docify_session";
const STATE_COOKIE = "docify_oauth_state";
const STATE_TTL_SEC = 600;

export interface StartServerOptions {
  docify?: Docify;
  quiet?: boolean;
  token?: string;
  accounts?: AccountsOptions | null;
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
  // Digests have one length, so odd input (non-ASCII, another length) compares instead of throwing.
  const digest = (text: string) => createHash("sha256").update(text).digest();
  const sameText = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));
  const tokenOk = (given: string | null) => token === null || (!!given && sameText(given, token));

  const accounts = opts.accounts ?? null;
  if (accounts && token !== null) throw new Error("DOCIFY_WEB_TOKEN cannot be used together with GitHub sign-in; accounts replace the shared token");
  // Without a named administrator nobody could approve the first account.
  if (accounts && !accounts.admins.logins.size && !accounts.admins.ids.size) throw new Error("DOCIFY_ADMINS must name at least one GitHub login when GitHub sign-in is on");
  // Behind a proxy the server cannot see the address people use, and without it the cookie
  // would not be Secure and GitHub would be sent to whatever callback the OAuth app has saved.
  if (accounts && !accounts.publicUrl && !LOOPBACK_HOSTS.has(host)) {
    throw new Error(`GitHub sign-in on ${host} needs DOCIFY_PUBLIC_URL, the https address people open (for example https://docs.example.com)`);
  }
  const store = accounts ? new AccountStore(docify.config.home, accounts.admins, opts.now) : null;
  for (const login of store?.demoted ?? []) docify.logs.append("accounts", `${login} is no longer named in DOCIFY_ADMINS: now a member, signed out`, "system", "warn");
  const secureCookies = !!accounts?.publicUrl?.startsWith("https://");
  // __Host- makes the browser refuse a copy set by a sibling subdomain or over plain http.
  const cookieName = (name: string) => (secureCookies ? `__Host-${name}` : name);
  // A name sent twice means someone planted a copy; which one a parser picks is not ours to trust.
  const cookieOf = (req: Request, name: string) => {
    const wanted = cookieName(name);
    const values = (req.headers.get("cookie") ?? "")
      .split(";")
      .map((pair) => pair.trim())
      .filter((pair) => pair.startsWith(`${wanted}=`))
      .map((pair) => pair.slice(wanted.length + 1));
    return values.length === 1 && values[0] ? values[0] : null;
  };
  // HttpOnly keeps the session away from page scripts; Lax still sends it on the redirect back from GitHub.
  const setCookie = (name: string, value: string, maxAgeSec: number, path = "/") =>
    `${cookieName(name)}=${value}; Path=${secureCookies ? "/" : path}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secureCookies ? "; Secure" : ""}`;
  // With a public address known, a write must come from exactly that origin: same scheme and
  // port, not only the same hostname. Loopback stays allowed for checks on the server itself.
  const originOk = (origin: string, hostHeader: string) => {
    if (!originAllowed(origin, hostHeader)) return false;
    if (!accounts?.publicUrl || origin === accounts.publicUrl) return true;
    try {
      return LOOPBACK_HOSTS.has(new URL(origin).hostname);
    } catch {
      return false;
    }
  };
  const actors = new WeakMap<Request, UserRow>();
  const userView = (u: UserRow, self?: UserRow) => ({
    id: u.id,
    login: u.login,
    name: u.name,
    role: u.role,
    status: u.status,
    createdAt: u.created_at,
    approvedAt: u.approved_at,
    lastLoginAt: u.last_login_at,
    named: store!.isNamedAdmin(u),
    self: self?.id === u.id,
  });

  // Answers depend on who asks, so nothing between the server and the browser may keep one.
  const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
  const fail = (err: unknown) => {
    if (err instanceof LogReadError) return json({ error: err.message, code: "logs_unavailable" }, 500);
    if (err instanceof ConfigError) return json({ error: err.message, code: "invalid_input", field: err.field ?? null }, 400);
    if (err instanceof DocifyError) return json({ error: err.message, code: err.code, ...(err.field ? { field: err.field } : {}) }, STATUS_BY_CODE[err.code] ?? 400);
    docify.logs.append("docify", err instanceof Error ? err.message : String(err), "system", "error");
    console.error(err);
    return json({ error: String(err instanceof Error ? err.message : err), code: "internal" }, 500);
  };

  // DNS rebinding and cross-site requests: only a known Host, JSON bodies only.
  // Store backups upload as raw bytes. That type also needs a CORS preflight, like JSON does.
  // With accounts the session cookie replaces the token. The cookie is sent by the browser on
  // its own, so the JSON content type and Origin checks below are what stop cross-site writes.
  const guard = (req: Request, bodyType = "application/json", access: Access | "open" = "admin"): Response | null => {
    const hostHeader = req.headers.get("host") ?? "";
    if (!allowAnyHost && !hostAllowed(hostHeader, allowedHosts)) return json({ error: "forbidden host", code: "forbidden" }, 403);
    // A link on another site carries the Lax cookie and no Origin. Browsers mark such a request,
    // and no page of ours makes one, so it stops here: an export or a search cannot be set off from outside.
    if (store && req.headers.get("sec-fetch-site") === "cross-site") return json({ error: "cross-site request refused", code: "forbidden" }, 403);
    if (access !== "open" && store) {
      const user = store.userForSession(cookieOf(req, SESSION_COOKIE));
      if (!user) return json({ error: "sign in to use Docify", code: "unauthorized" }, 401);
      if (user.status !== "active") return json({ error: user.status === "pending" ? "this account is waiting for an administrator's approval" : "this account is disabled", code: "forbidden" }, 403);
      if (access === "admin" && user.role !== "admin") return json({ error: "only administrators can do this", code: "forbidden" }, 403);
      actors.set(req, user);
    } else if (access !== "open" && !tokenOk(req.headers.get("x-docify-token"))) {
      return json({ error: "missing or wrong access token; open the URL printed by docify serve", code: "unauthorized" }, 401);
    }
    if (req.method !== "GET") {
      if (!(req.headers.get("content-type") ?? "").startsWith(bodyType)) return json({ error: `${bodyType} body required`, code: "unsupported" }, 415);
      const origin = req.headers.get("origin");
      if (origin && !originOk(origin, hostHeader)) return json({ error: "forbidden origin", code: "forbidden" }, 403);
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
  // Routes are for administrators unless they say otherwise, so a new route starts closed.
  // Without accounts the token is the only check and `access` does nothing.
  type ApiRequest = Request & { params: Record<string, string> };
  const api =
    (handler: (req: ApiRequest) => Promise<Response> | Response, route: { bodyType?: string; access?: Access | "open" } = {}) =>
    async (req: ApiRequest) => {
      const blocked = guard(req, route.bodyType, route.access);
      if (blocked) return blocked;
      if (importing) return json({ error: "a store import is running; try again in a moment", code: "busy" }, 503);
      try {
        return await handler(req);
      } catch (err) {
        return fail(err);
      }
    };
  const member = (handler: (req: ApiRequest) => Promise<Response> | Response) => api(handler, { access: "member" });
  const requireStore = () => {
    if (!store) throw new DocifyError("accounts_off", "accounts are not enabled on this server");
    return store;
  };
  const userId = (req: ApiRequest) => {
    if (!/^\d{1,15}$/.test(req.params.id ?? "")) throw new DocifyError("user_unknown", "unknown user");
    return Number(req.params.id);
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
  // A member may see what there is to search, not where it lives on the server or why a prepare failed.
  const isMember = (req: Request) => actors.get(req)?.role === "member";
  const memberSources = () =>
    sources(docify).map((s) => ({ ...s, locator: s.kind === "local" ? basename(s.locator) : s.locator, latest: s.latest && { ...s.latest, error: null } }));

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

  // Sign-in is reachable without a session, so it gets its own per-IP limit.
  const authLimiter = new RateLimiter(parseRate("30/min", "sign-in rate"), opts.now);
  const redirect = (location: string, cookies: string[]) => {
    const headers = new Headers({ location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
    for (const cookie of cookies) headers.append("set-cookie", cookie);
    return new Response(null, { status: 302, headers });
  };
  const authRoute =
    (handler: (req: Request, store: AccountStore, accounts: AccountsOptions) => Promise<Response> | Response) =>
    async (req: Request, srv: { requestIP(req: Request): { address: string } | null }) => {
      if (!store || !accounts) return new Response("not found", { status: 404 });
      if (!allowAnyHost && !hostAllowed(req.headers.get("host") ?? "", allowedHosts)) return json({ error: "forbidden host", code: "forbidden" }, 403);
      const taken = authLimiter.take(`ip:${clientIp(req, srv.requestIP(req)?.address, mcp.trustProxy)}`);
      if (!taken.ok) return Response.json({ error: "too many sign-in attempts; try again shortly", code: "rate_limited" }, { status: 429, headers: { "retry-after": String(taken.retryAfterSec) } });
      try {
        return await handler(req, store, accounts);
      } catch (err) {
        return fail(err);
      }
    };
  const signInStart = authRoute((_req, _store, accounts) => {
    // The state goes out in the link and in a cookie; the callback accepts the code only when
    // both match, so nobody can make a visitor finish a sign-in that someone else began.
    const state = randomBytes(24).toString("base64url");
    return redirect(githubAuthorizeUrl(accounts.github, state), [setCookie(STATE_COOKIE, state, STATE_TTL_SEC, "/auth")]);
  });
  const signInCallback = authRoute(async (req, store, accounts) => {
    const params = new URL(req.url).searchParams;
    const clearState = setCookie(STATE_COOKIE, "", 0, "/auth");
    // The page shows a message for the word after signin=; no detail from GitHub goes into the URL.
    const back = (result: string) => redirect(`/#signin=${result}`, [clearState]);
    const expected = cookieOf(req, STATE_COOKIE);
    const state = params.get("state");
    const code = params.get("code");
    // State first: what the link says about an error or a code counts only in the browser that began it.
    if (!expected || !state || !sameText(state, expected)) return back("expired");
    const refused = params.get("error");
    if (refused) return back(refused === "redirect_uri_mismatch" ? "setup" : "cancelled");
    if (!code) return back("expired");
    let profile;
    try {
      profile = await githubProfile(accounts.github, code);
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      docify.logs.append("accounts", `sign-in failed: ${err.message}`, "system", "warn");
      return back("failed");
    }
    const { user, session, created, loginTaken } = store.signIn(profile, cookieOf(req, SESSION_COOKIE));
    if (loginTaken) docify.logs.append("accounts", `${user.login} (GitHub id ${profile.id}) signed in with a login named in DOCIFY_ADMINS that belongs to another GitHub account; not made an administrator`, "system", "warn");
    if (created) docify.logs.append("accounts", user.status === "pending" ? `${user.login} signed up and is waiting for approval` : `${user.login} (GitHub id ${profile.id}) signed up as an administrator named in DOCIFY_ADMINS`);
    if (!session) return back("disabled");
    return redirect("/", [clearState, setCookie(SESSION_COOKIE, session, Math.floor(SESSION_TTL_MS / 1000))]);
  });

  const server = Bun.serve({
    hostname: host,
    port,
    development: false,
    maxRequestBodySize: IMPORT_MAX_BYTES,
    routes: {
      "/healthz": { GET: () => json({ ok: true, version: VERSION }) },
      "/mcp": mcpRoute,
      "/auth/github": { GET: signInStart },
      "/auth/github/callback": { GET: signInCallback },
      // Open on purpose: the page asks this first to learn whether to show the sign-in screen.
      "/api/session": {
        GET: api((req) => {
          const user = store?.userForSession(cookieOf(req, SESSION_COOKIE)) ?? null;
          return json({ accounts: !!store, user: user && { id: user.id, login: user.login, name: user.name, role: user.role, status: user.status } });
        }, { access: "open" }),
        DELETE: api((req) => {
          store?.signOut(cookieOf(req, SESSION_COOKIE));
          return Response.json({ ok: true }, { headers: { "set-cookie": setCookie(SESSION_COOKIE, "", 0), "cache-control": "no-store" } });
        }, { access: "open" }),
      },
      "/api/users": {
        GET: api((req) => json({ users: requireStore().listUsers().map((u) => userView(u, actors.get(req))) })),
      },
      "/api/users/:id": {
        PATCH: api(async (req) => {
          const accountStore = requireStore();
          const b = await body(req);
          const actor = actors.get(req);
          const user = accountStore.updateUser(userId(req), { role: b.role as never, status: b.status as never }, actor?.id ?? null);
          docify.logs.append("accounts", `${actor?.login ?? "?"} set ${user.login} to ${user.role}, ${user.status}`);
          return json(userView(user, actor));
        }),
        DELETE: api((req) => {
          const accountStore = requireStore();
          const actor = actors.get(req);
          const user = accountStore.removeUser(userId(req), actor?.id ?? null);
          docify.logs.append("accounts", `${actor?.login ?? "?"} removed ${user.login}`);
          return json({ ok: true });
        }),
      },
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
        GET: member((req) => json(isMember(req) ? memberSources() : sources(docify))),
        POST: api(async (req) => {
          const b = await body(req);
          const kind = b.kind === "url" ? "url" : "local";
          const locator = str(b.locator);
          const library = str(b.library);
          if (!locator || !library) throw new DocifyError("invalid_input", "library and locator are required");
          const provider = b.crawlProvider === undefined ? undefined : crawlProvider(b.crawlProvider, false)!;
          const ignore = b.ignore === undefined ? undefined : validateIgnorePatterns(b.ignore, "ignore");
          const graphIgnore = b.graphIgnore === undefined ? undefined : validateIgnorePatterns(b.graphIgnore, "graphIgnore");
          if (kind === "local") {
            if (provider !== undefined || b.crawl !== undefined) throw new DocifyError("invalid_input", "crawler settings are only valid for URL sources");
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
            return json(docify.addSource({ library, version: str(b.version) ?? null, kind, locator: real, ignore, graphIgnore }), 201);
          }
          if (b.crawl !== undefined) {
            const crawl = b.crawl;
            if (!crawl || typeof crawl !== "object" || Array.isArray(crawl) || Object.keys(crawl).some((key) => key !== "maxPages" && key !== "maxDepth")) throw new DocifyError("invalid_input", "crawl must contain only maxPages and maxDepth");
          }
          return json(docify.addSource({ library, version: str(b.version) ?? null, kind, locator, crawlProvider: provider, crawl: b.crawl as never, ignore, graphIgnore }), 201);
        }),
      },
      "/api/sources/:id": {
        PATCH: api(async (req) => {
          const b = await body(req);
          const crawler = b.crawlProvider !== undefined || b.crawl4ai !== undefined || b.crawl !== undefined;
          const ignoring = b.ignore !== undefined || b.graphIgnore !== undefined;
          if (!crawler && !ignoring) throw new DocifyError("invalid_input", "crawler settings or ignore patterns are required");
          const id = decodeURIComponent(req.params.id!);
          // Checked before anything is written, so a bad pattern cannot leave half of the request applied.
          for (const name of ["ignore", "graphIgnore"] as const) {
            if (b[name] !== undefined && b[name] !== null) validateIgnorePatterns(b[name], name);
          }
          if (crawler) docify.updateSourceCrawler(id, b.crawlProvider === undefined ? undefined : crawlProvider(b.crawlProvider, true), b.crawl4ai, b.crawl);
          if (ignoring) docify.updateSourceIgnore(id, { ignore: b.ignore, graphIgnore: b.graphIgnore });
          return json({ ok: true });
        }),
        DELETE: api((req) => {
          if (running.has(req.params.id!)) throw new DocifyError("busy", "cancel the running operation first");
          docify.removeSource(decodeURIComponent(req.params.id!));
          return json({ ok: true });
        }),
      },
      "/api/sources/:id/artifacts/:kind": {
        GET: member((req) => {
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
        GET: member((req) => json(docify.db.transaction(() => {
          const source = docify.requireSource(decodeURIComponent(req.params.id!));
          const generation = source.active_generation ? docify.getGeneration(source.active_generation) : null;
          if (!generation || generation.status !== "active") return { source: source.id, generation: null, paths: [] };
          const rows = docify.db.query<{ path: string }, [number]>(
            "SELECT path FROM documents WHERE generation_id = ? ORDER BY path",
          ).all(generation.id);
          return { source: source.id, generation: generation.id, paths: rows.map((row) => row.path) };
        })())),
      },
      "/api/sources/:id/graph": { GET: member((req) => json(graphView(docify, decodeURIComponent(req.params.id!)))) },
      "/api/sources/:id/summary": {
        POST: api(async (req) => {
          const id = decodeURIComponent(req.params.id!);
          docify.requireSource(id);
          const b = await body(req);
          if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).some((key) => key !== "force") || (b.force !== undefined && typeof b.force !== "boolean")) {
            throw new DocifyError("invalid_input", "summary body accepts only a boolean force");
          }
          if (running.has(id)) throw new DocifyError("busy", `${id} already has a running operation`);
          const controller = new AbortController();
          running.set(id, controller);
          server.timeout(req, 0);
          try {
            // A client that went away cannot cancel, so its request must not keep the source busy.
            return json(await summarizeSource(docify, id, { force: b.force === true, signal: AbortSignal.any([controller.signal, req.signal]) }));
          } finally {
            running.delete(id);
          }
        }),
      },
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
        POST: member(async (req) => {
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
      "/api/read/:id": { GET: member((req) => json(read(docify, req.params.id!))) },
      // Raw source is served only for stored passages, and only from the snapshot directory.
      "/api/raw/:id": {
        GET: member((req) => {
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
          if (running.size) throw new DocifyError("busy", `cannot change settings while ${[...running.keys()].join(", ")} has a running operation; wait or cancel first`);
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
          if (running.size) throw new DocifyError("busy", "wait for running source operations before importing");
          importing = true;
          try {
            const r = await importStore(docify, data, { force: q.get("force") === "1", keepConfig: q.get("keepConfig") === "1", checkLocalSource });
            return json(r);
          } finally {
            importing = false;
          }
        }, { bodyType: "application/octet-stream" }),
      },
      "/api/pins": {
        GET: member((req) => json(isMember(req) ? { ...pinsView(), project: null, file: null } : pinsView())),
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
      const hsts: Record<string, string> = secureCookies ? { "strict-transport-security": "max-age=15552000" } : {};
      return new Response(asset.body, { headers: path === "/" ? { ...headers, ...PAGE_HEADERS, ...hsts, "cache-control": "no-store" } : headers });
    },
  });
  boundPort = server.port!;
  for (const loopback of LOOPBACK_HOSTS) allowedHosts.add(`${loopback}:${boundPort}`);
  if (!opts.quiet) {
    const where = `${host}:${boundPort}`;
    const warning = allowAnyHost ? " DOCIFY_ALLOWED_HOSTS is unset, so any Host is accepted; set it to your public domain." : "";
    const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${boundPort}/`;
    if (store?.demoted.length) console.log(`No longer named in DOCIFY_ADMINS, now members and signed out: ${store.demoted.join(", ")}.`);
    if (accounts) {
      const named = [...accounts.admins.logins, ...[...accounts.admins.ids].map((id) => `id:${id}`)].join(", ");
      const cookieNote = secureCookies || LOOPBACK_HOSTS.has(host) ? "" : " DOCIFY_PUBLIC_URL is not https, so the session cookie also travels over plain http; use https outside a trusted network.";
      console.log(`Docify UI listening on ${where}; people sign in with GitHub, administrators: ${named}.${cookieNote}${warning}`);
    } else if (tokenFromEnv) console.log(`Docify UI listening on ${where}; the access token comes from DOCIFY_WEB_TOKEN.${warning}`);
    else if (token === null) console.log(`Docify UI on ${url}; no access token is set (DOCIFY_WEB_TOKEN), so anyone who can reach this port can use it.${warning}`);
    else console.log(`Docify UI on ${url}#token=${token}${warning}`);
    if (mcpPipeline) {
      const names = mcp.clients.map((c) => c.name).join(", ");
      console.log(`MCP over HTTP on /mcp for ${names}; ${mcp.clientRate.limit} requests per ${mcp.clientRate.windowMs / 1000} s per client, ${mcp.ipRate.limit} per ${mcp.ipRate.windowMs / 1000} s per IP.`);
    }
  }
  return Object.assign(server, { token, accounts: store });
}

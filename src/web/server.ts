import { homedir } from "node:os";
import { delimiter, resolve } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Docify, DocifyError } from "../core/docify.ts";
import { uiAssets } from "./bundle.ts";
import { LOOPBACK_HOSTS, hostAllowed, hostGuard, originAllowed, parseAllowedHosts, splitList } from "../http/host.ts";
import { bearerAuth, parseBearerClients, type BearerClient } from "../http/auth.ts";
import { RateLimiter, parseRate, rateLimit, type RateLimit } from "../http/rate-limit.ts";
import { chain } from "../http/guard.ts";
import { clientIp } from "../http/client-ip.ts";
import { OAuthError, githubAuthorizeUrl, githubProfile, type GitHubOAuthConfig } from "../http/github-oauth.ts";
import {
  AccountStore,
  SESSION_TTL_MS,
  parseAdmins,
  type AdminList,
  type KeyRow,
  type QueryRecord,
  type UserRow,
} from "../core/accounts.ts";
import { mcpHttpHandler } from "../mcp/http.ts";
import { DOCS_INIT, DOCS_PAGE } from "./openapi.ts";
import { memberScope, memberView, type Access, IMPORT_MAX_BYTES, createApi, openApiSpec, withinSourceRoots } from "./api.ts";
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
  const enabled = env.DOCIFY_ACCOUNTS_ENABLED?.trim();
  if (enabled === "false") return null;
  if (enabled && enabled !== "true") throw new Error("DOCIFY_ACCOUNTS_ENABLED must be true, false or unset");
  const clientId = env.DOCIFY_GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.DOCIFY_GITHUB_CLIENT_SECRET?.trim();
  if (enabled === "true" && (!clientId || !clientSecret)) throw new Error("DOCIFY_ACCOUNTS_ENABLED=true requires DOCIFY_GITHUB_CLIENT_ID and DOCIFY_GITHUB_CLIENT_SECRET");
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) throw new Error("set both DOCIFY_GITHUB_CLIENT_ID and DOCIFY_GITHUB_CLIENT_SECRET, or neither");
  const publicUrl = parsePublicUrl(env.DOCIFY_PUBLIC_URL);
  return {
    github: { clientId, clientSecret, redirectUri: publicUrl ? `${publicUrl}/auth/github/callback` : undefined },
    admins: parseAdmins(env.DOCIFY_ADMINS),
    publicUrl,
  };
}

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
  // MCP over HTTP at /mcp. The route exists with clients named here or with accounts, whose
  // people make their own keys. Defaults come from env.
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
  // Answers depend on who asks, so nothing between the server and the browser may keep one.
  const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
  const fail = (err: unknown) => {
    console.error(err);
    return json({ error: String(err instanceof Error ? err.message : err), code: "internal" }, 500);
  };

  // DNS rebinding and cross-site requests: only a known Host, JSON bodies only.
  // Store backups upload as raw bytes. That type also needs a CORS preflight, like JSON does.
  // With accounts the session cookie replaces the token. The cookie is sent by the browser on
  // its own, so the JSON content type and Origin checks below are what stop cross-site writes.
  const guard = (req: Request, bodyType = "application/json", access: Access = "admin"): Response | null => {
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

  // History is a convenience. A failed write is logged and must not fail the search it describes.
  const remember = (user: UserRow, record: QueryRecord) => {
    try {
      store?.recordQuery(user.id, record);
    } catch (err) {
      docify.logs.append("accounts", `could not record a query of ${user.login}: ${err instanceof Error ? err.message : err}`, "system", "warn");
    }
  };
  // The IP limit runs before auth so guessing tokens is slow; the client limit runs after it.
  const mcp = mcpSettings(opts);
  // Who sent an MCP request with a personal key. A shared token from DOCIFY_MCP_TOKENS has no person.
  const keyHolders = new WeakMap<Request, { user: UserRow; key: KeyRow }>();
  // All keys of one person share a client name, so a second key is not a second request allowance.
  // A shared client's name cannot contain a colon, so the two kinds never collide.
  const personalKey = (token: string, req: Request) => {
    const holder = store?.userForKey(token);
    if (!holder) return null;
    keyHolders.set(req, holder);
    return `user:${holder.user.id}`;
  };
  const mcpPipeline = mcp.clients.length || store
    ? chain(
        [
          hostGuard(allowedHosts, allowAnyHost),
          rateLimit(new RateLimiter(mcp.ipRate, opts.now), (ctx) => `ip:${ctx.ip}`),
          bearerAuth(mcp.clients, personalKey),
          rateLimit(new RateLimiter(mcp.clientRate, opts.now), (ctx) => ctx.client && `client:${ctx.client}`),
        ],
        mcpHttpHandler(docify, {
          project,
          maxBodyBytes: MCP_MAX_BODY_BYTES,
          hooks: (req) => {
            const holder = keyHolders.get(req);
            if (!holder) return undefined;
            return {
              onSearch: (entry) => remember(holder.user, { via: "mcp", keyName: holder.key.name, ...entry }),
              // The same rule as on the page: a member sees no server paths and no prepare errors.
              sources: holder.user.role === "member" ? memberView : undefined,
              scope: holder.user.role === "member" ? memberScope : undefined,
            };
          },
        }),
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
  const signInStart = authRoute((_req, accountStore, accounts) => {
    // The state goes out in the link and in a cookie; the callback accepts the code only when
    // both match, so nobody can make a visitor finish a sign-in that someone else began.
    const state = randomBytes(24).toString("base64url");
    // Scopes follow the access list: with no organization or email entry, only the public profile is read.
    return redirect(githubAuthorizeUrl(accounts.github, state, accountStore.accessNeeds()), [setCookie(STATE_COOKIE, state, STATE_TTL_SEC, "/auth")]);
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
      profile = await githubProfile(accounts.github, code, store.accessNeeds());
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      docify.logs.append("accounts", `sign-in failed: ${err.message}`, "system", "warn");
      return back("failed");
    }
    if (profile.unknownOrgs.length) {
      docify.logs.append("accounts", `GitHub would not say whether ${profile.login} is a member of ${profile.unknownOrgs.join(", ")}; the organization may have to approve this OAuth app`, "system", "warn");
    }
    if (profile.ungranted.length) docify.logs.append("accounts", `${profile.login} signed in without granting ${profile.ungranted.join(", ")}; the access list entries that need it were not checked`, "system", "warn");
    if (profile.emailsUnknown) docify.logs.append("accounts", `GitHub would not say which email addresses ${profile.login} has`, "system", "warn");
    let result;
    try {
      result = store.signIn(profile, cookieOf(req, SESSION_COOKIE));
    } catch (err) {
      if (!(err instanceof DocifyError) || err.code !== "not_invited") throw err;
      docify.logs.append("accounts", `${profile.login} (GitHub id ${profile.id}) tried to sign in and is not on the access list`);
      return back("uninvited");
    }
    const { user, session, created, loginTaken, admitted, suspended } = result;
    if (admitted) docify.logs.append("accounts", `${user.login} (GitHub id ${profile.id}) was let in by the access list: ${admitted.kind} ${admitted.value}`);
    if (suspended) docify.logs.append("accounts", `${user.login} no longer matches the access list and waits for approval again`);
    if (loginTaken) docify.logs.append("accounts", `${user.login} (GitHub id ${profile.id}) signed in with a login named in DOCIFY_ADMINS that belongs to another GitHub account; not made an administrator`, "system", "warn");
    if (created && !admitted) docify.logs.append("accounts", user.status === "pending" ? `${user.login} signed up and is waiting for approval` : `${user.login} (GitHub id ${profile.id}) signed up as an administrator named in DOCIFY_ADMINS`);
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
      const hsts: Record<string, string> = secureCookies ? { "strict-transport-security": "max-age=15552000" } : {};
      return new Response(asset.body, { headers: path === "/" ? { ...headers, ...PAGE_HEADERS, ...hsts, "cache-control": "no-store" } : headers });
    },
  });
  const api = createApi({
    docify, project, sourceRoots, guard, noTimeout: (req) => server.timeout(req, 0),
    accounts: {
      store, actor: (req) => actors.get(req), remember,
      session: (req) => store?.userForSession(cookieOf(req, SESSION_COOKIE)) ?? null,
      signOut: (req) => {
        store?.signOut(cookieOf(req, SESSION_COOKIE));
        return setCookie(SESSION_COOKIE, "", 0);
      },
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
      const names = [...mcp.clients.map((c) => c.name), ...(store ? ["personal keys made in the web UI"] : [])].join(", ");
      console.log(`MCP over HTTP on /mcp for ${names}; ${mcp.clientRate.limit} requests per ${mcp.clientRate.windowMs / 1000} s per client, ${mcp.ipRate.limit} per ${mcp.ipRate.windowMs / 1000} s per IP.`);
    }
  }
  return Object.assign(server, { token, accounts: store });
}

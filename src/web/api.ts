// The /api routes as a Hono app. Each route is declared with zod schemas, which validate the
// request and generate the OpenAPI document served at /api/docs/openapi.json.
import { homedir } from "node:os";
import { basename, delimiter, join, resolve, sep } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { OpenAPIHono, createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { Docify, DocifyError, effectiveGeneration, validateGroups, validateIgnorePatterns, validateTitle } from "../core/docify.ts";
import { ConfigError, describeConfig } from "../core/config.ts";
import { discoverSources, open, outline, read, scope, search, searchMany, sources, renderScope, type SourceInfo, type ScopeResult } from "../core/search.ts";
import { graphView } from "../core/graph-view.ts";
import { summarizeSource } from "../core/summary.ts";
import { exportStore, importStore } from "../core/backup.ts";
import { compressSnapshots } from "../core/compress-snapshots.ts";
import { readSnapshotFile } from "../core/snapshot-file.ts";
import { LogReadError } from "../core/logs.ts";
import { VERSION } from "../version.ts";
import { AccountStore, MAX_ACCESS_RULES, MAX_KEYS_PER_USER, MAX_ORG_RULES, MAX_QUERIES_PER_USER, type AccessRule, type KeyRow, type QueryRecord, type UserRow } from "../core/accounts.ts";
import { scopeText } from "../mcp/tools.ts";
import * as s from "./api-schemas.ts";

const STATUS_BY_CODE: Record<string, number> = { invalid_input: 400, exists: 409, busy: 409, source_unknown: 404, generation_changed: 409, summary_failed: 502, invalid_summary: 502, user_unknown: 404, key_unknown: 404, rule_unknown: 404, accounts_off: 404, conflict: 409, not_invited: 403 };
// A store backup is uploaded whole; a real store is around 100 MB before compression.
export const IMPORT_MAX_BYTES = 1024 * 1024 * 1024;

export type Access = "admin" | "member" | "open";
export const memberView = (list: SourceInfo[]): SourceInfo[] => list.map((source) => ({
  ...source, locator: source.kind === "local" ? basename(source.locator) : source.locator,
  latest: source.latest && { ...source.latest, error: null },
}));

export function memberScope(result: ScopeResult): ScopeResult {
  const view = { ...result, project: null, pins: result.pins && { ...result.pins, file: null } };
  return { ...view, text: renderScope(view) };
}

export interface ApiDeps {
  docify: Docify;
  project: string;
  sourceRoots: string[];
  // Host, token, content type and Origin; null lets the request through.
  guard: (req: Request, bodyType: string, access: Access) => Response | null;
  accounts?: {
    store: AccountStore | null;
    actor: (req: Request) => UserRow | undefined;
    session: (req: Request) => UserRow | null;
    signOut: (req: Request) => string;
    remember: (user: UserRow, record: QueryRecord) => void;
  };
  // Lifts the idle timeout for a request that waits on a slow provider.
  noTimeout: (req: Request) => void;
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

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

// zod failures answer like the core's own validation: invalid_input, and the body field when there is one.
function invalidInput(result: { success: boolean; error?: z.ZodError; target: string; data?: unknown }): Response | undefined {
  if (result.success) return;
  const issue = result.error!.issues[0]!;
  const top = issue.path[0];
  const field = result.target === "json" && typeof top === "string" ? top : undefined;
  if (field === "ignore" || field === "graphIgnore") {
    // The core's message names the bad pattern; the forms show it next to the field.
    try {
      validateIgnorePatterns((result.data as Record<string, unknown>)[field], field);
    } catch (err) {
      if (err instanceof DocifyError) return json({ error: err.message, code: "invalid_input", field }, 400);
    }
  }
  if (field === "title" || field === "groups") {
    try {
      const value = (result.data as Record<string, unknown>)[field];
      if (field === "title") validateTitle(value);
      else validateGroups(value);
    } catch (err) {
      if (err instanceof DocifyError) return json({ error: err.message, code: "invalid_input", field }, 400);
    }
  }
  const where = issue.path.length ? `${issue.path.join(".")}: ` : result.target === "json" ? "body: " : "";
  return json({ error: `${where}${issue.message}`, code: "invalid_input", ...(field ? { field } : {}) }, 400);
}

export function createApi(deps: ApiDeps) {
  const { docify, project, sourceRoots } = deps;
  const running = new Map<string, AbortController>();
  // Set while an import swaps the store files; the database is closed for that moment.
  let importing = false;

  const fail = (err: unknown): Response => {
    if (err instanceof HTTPException) {
      // Hono's own body checks: malformed JSON (400) and a wrong media type (415).
      if (err.status === 415) return json({ error: "application/json body required", code: "unsupported" }, 415);
      return json({ error: err.status === 400 ? "invalid JSON body" : err.message, code: err.status === 400 ? "invalid_input" : "internal" }, err.status);
    }
    if (err instanceof LogReadError) return json({ error: err.message, code: "logs_unavailable" }, 500);
    if (err instanceof ConfigError) return json({ error: err.message, code: "invalid_input", field: err.field ?? null }, 400);
    if (err instanceof DocifyError) return json({ error: err.message, code: err.code, ...(err.field ? { field: err.field } : {}) }, STATUS_BY_CODE[err.code] ?? 400);
    docify.logs.append("docify", err instanceof Error ? err.message : String(err), "system", "error");
    console.error(err);
    return json({ error: String(err instanceof Error ? err.message : err), code: "internal" }, 500);
  };

  const app = new OpenAPIHono({ defaultHook: invalidInput });
  app.onError((err) => fail(err));
  app.notFound((c) => deps.guard(c.req.raw, "application/json", "admin") ?? new Response("not found", { status: 404 }));

  // Guards run before routing and validation, so a refused request learns nothing about the input.
  const guards = (access: Access, requiresAccounts: boolean): MiddlewareHandler => async (c, next) => {
    const blocked = deps.guard(c.req.raw, c.req.path === "/api/import" ? "application/octet-stream" : "application/json", access);
    if (blocked) return blocked;
    if (importing) return json({ error: "a store import is running; try again in a moment", code: "busy" }, 503);
    if (requiresAccounts && !deps.accounts?.store) throw new DocifyError("accounts_off", "accounts are not enabled on this server");
    await next();
  };

  app.openAPIRegistry.registerComponent("securitySchemes", "docifyToken", { type: "apiKey", in: "header", name: "X-Docify-Token" });

  app.openAPIRegistry.registerComponent("securitySchemes", "docifySession", { type: "apiKey", in: "cookie", name: "docify_session" });

  // New routes are admin-only unless registered with member or publicRoute.
  const register = (access: Access, requiresAccounts = false) => <R extends RouteConfig>(route: R, handler: (c: Context) => Response | Promise<Response>) =>
    app.openapi(createRoute({ ...route, middleware: [guards(access, requiresAccounts)] }), handler as never);
  const add = register("admin"), member = register("member"), publicRoute = register("open");
  const accountAdmin = register("admin", true), accountMember = register("member", true);
  const isMember = (c: Context) => deps.accounts?.actor(c.req.raw)?.role === "member";
  const valid = <T extends z.ZodType>(c: Context, target: "json" | "query" | "param", _schema: T) => (c.req.valid as (t: string) => unknown)(target) as z.output<T>;
  const sourceId = (c: Context) => valid(c, "param", s.SourceIdParam).id;
  const busyGuard = (id: string, what = "a running operation") => {
    if (running.has(id)) throw new DocifyError("busy", `${id} already has ${what}`);
  };
  const pinsView = () => ({ project, file: Docify.pinFile(project), pins: Docify.readPins(project) });

  // ---- Accounts ----
  const store = deps.accounts?.store;
  const actorOf = (c: Context) => deps.accounts?.actor(c.req.raw);
  const ruleView = (r: AccessRule) => ({ id: r.id, kind: r.kind, value: r.value, createdAt: r.created_at, createdBy: r.created_by, people: r.people, bound: r.bound });
  const userView = (u: UserRow, self?: UserRow) => {
    const rule = u.rule_id === null ? null : store!.getRule(u.rule_id);
    return {
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
      // The access-list entry that let this person in; null when an administrator approved them.
      rule: rule && { kind: rule.kind, value: rule.value },
    };
  };

  const requireStore = () => {
    if (!store) throw new DocifyError("accounts_off", "accounts are not enabled on this server");
    return store;
  };
  const accountId = (c: Context, code: string, message: string) => {
    const { id } = valid(c, "param", s.AccountId);
    if (!/^\d{1,15}$/.test(id)) throw new DocifyError(code, message);
    return Number(id);
  };
  const me = (c: Context) => {
    const accountStore = requireStore();
    const user = actorOf(c);
    if (!user) throw new DocifyError("accounts_off", "accounts are not enabled on this server");
    return { accountStore, user };
  };
  const keyView = (k: KeyRow) => ({ id: k.id, name: k.name, prefix: k.prefix, createdAt: k.created_at, lastUsedAt: k.last_used_at });

  publicRoute(
    { method: "get", path: "/api/session", tags: ["Accounts"], summary: "Who is signed in", description: "Needs no token or session. `accounts` says whether GitHub sign-in is on; `user` is null when nobody is signed in. With accounts on, `asks` says what sign-in will ask GitHub for beyond the public profile, which depends on the access list.", security: [], responses: { 200: s.json(s.Session, "Who is signed in"), ...s.errors() } },
    (c) => {
      const user = deps.accounts?.session(c.req.raw) ?? null;
      const session = { accounts: !!store, user: user && { id: user.id, login: user.login, name: user.name, role: user.role, status: user.status } };
      if (!store) return json(session);
      // The sign-in page says what GitHub will be asked for before the person goes there.
      const needs = store.accessNeeds();
      return json({ ...session, asks: { orgs: needs.orgs.length > 0, emails: needs.emails } });
    },
  );
  publicRoute(
    { method: "delete", path: "/api/session", tags: ["Accounts"], summary: "Sign out", security: [], responses: { 200: s.json(s.Ok, "Sign out"), ...s.errors(409, 415) } },
    (c) => {
      if (!deps.accounts) return json({ ok: true });
      const expired = deps.accounts.signOut(c.req.raw);
      return Response.json({ ok: true }, { headers: { "set-cookie": expired, "cache-control": "no-store" } });
    },
  );
  accountAdmin(
    { method: "get", path: "/api/users", tags: ["Accounts"], summary: "List accounts", description: "Administrators only. Accounts waiting for approval come first. 404 when GitHub sign-in is off.", responses: { 200: s.json(z.object({ users: z.array(s.User) }), "List accounts"), ...s.errors(404) } },
    (c) => json({ users: requireStore().listUsers().map((u) => userView(u, actorOf(c))) }),
  );
  accountAdmin(
    { method: "patch", path: "/api/users/{id}", tags: ["Accounts"], summary: "Approve, disable or change the role of an account", description: "Administrators only. `status: active` approves a pending account or re-enables a disabled one; `disabled` also ends the person's sessions and MCP keys. Your own account and accounts named in DOCIFY_ADMINS are refused with 409.", request: { params: s.AccountId, body: s.jsonBody(s.UpdateUser) }, responses: { 200: s.json(s.User, "Approve, disable or change the role of an account"), ...s.errors(404, 400, 409, 415) } },
    (c) => {
      const accountStore = requireStore();
      const b = valid(c, "json", s.UpdateUser);
      const actor = actorOf(c);
      const user = accountStore.updateUser(accountId(c, "user_unknown", "unknown user"), { role: b.role, status: b.status }, actor?.id ?? null);
      docify.logs.append("accounts", `${actor?.login ?? "?"} set ${user.login} to ${user.role}, ${user.status}`);
      return json(userView(user, actor));
    },
  );
  accountAdmin(
    { method: "delete", path: "/api/users/{id}", tags: ["Accounts"], summary: "Remove an account", description: "Administrators only. If the person signs in again, the access list decides whether they get in, wait or are refused.", request: { params: s.AccountId }, responses: { 200: s.json(s.Ok, "Remove an account"), ...s.errors(404, 409, 415) } },
    (c) => {
      const accountStore = requireStore();
      const actor = actorOf(c);
      const user = accountStore.removeUser(accountId(c, "user_unknown", "unknown user"), actor?.id ?? null);
      docify.logs.append("accounts", `${actor?.login ?? "?"} removed ${user.login}`);
      return json({ ok: true });
    },
  );
  accountAdmin(
    { method: "get", path: "/api/access", tags: ["Accounts"], summary: "Read the access list", description: "Administrators only. `rules` are the entries; `outsiders` says what happens to a person who matches none: `pending` (waits for approval) or `refuse` (gets no account). 404 when GitHub sign-in is off.", responses: { 200: s.json(s.Outsiders.extend({ rules: z.array(s.AccessRule), maxOrgs: z.number(), maxRules: z.number() }), "Read the access list"), ...s.errors(404) } },
    (c) => {
      const accountStore = requireStore();
      return json({ outsiders: accountStore.outsiders, rules: accountStore.listRules().map(ruleView), maxOrgs: MAX_ORG_RULES, maxRules: MAX_ACCESS_RULES });
    },
  );
  accountAdmin(
    { method: "put", path: "/api/access", tags: ["Accounts"], summary: "Set the policy for outsiders", description: "Administrators only. Accounts that already exist are not changed.", request: { body: s.jsonBody(s.Outsiders) }, responses: { 200: s.json(s.Outsiders, "Set the policy for outsiders"), ...s.errors(404, 400, 409, 415) } },
    (c) => {
      const accountStore = requireStore();
      const outsiders = accountStore.setOutsiders(valid(c, "json", s.Outsiders).outsiders);
      docify.logs.append("accounts", `${actorOf(c)?.login ?? "?"} set people outside the access list to ${outsiders === "refuse" ? "be refused" : "wait for approval"}`);
      return json({ outsiders });
    },
  );
  accountAdmin(
    { method: "post", path: "/api/access/rules", tags: ["Accounts"], summary: "Add an access rule", description: "Administrators only. A person who matches gets in as a member at their next sign-in. An organization or email entry makes sign-in ask GitHub for the `read:org` or `user:email` scope. A refused value is reported with `field: value`.", request: { body: s.jsonBody(s.NewRule) }, responses: { 201: s.json(s.AccessRule, "Add an access rule"), ...s.errors(404, 400, 409, 415) } },
    (c) => {
      const accountStore = requireStore();
      const b = valid(c, "json", s.NewRule);
      const actor = actorOf(c);
      const rule = accountStore.addRule(b.kind, b.value, actor?.login ?? null);
      docify.logs.append("accounts", `${actor?.login ?? "?"} added ${rule.kind} ${rule.value} to the access list`);
      return json(ruleView(rule), 201);
    },
  );
  accountAdmin(
    { method: "delete", path: "/api/access/rules/{id}", tags: ["Accounts"], summary: "Remove an access rule", description: "Administrators only. The people it let in are signed out, lose their MCP keys and wait for approval; `suspended` lists their logins. Accounts approved by hand stay. An entry that lets the caller in is refused with 409.", request: { params: s.AccountId }, responses: { 200: s.json(s.Ok.extend({ suspended: z.array(z.string()) }), "Remove an access rule"), ...s.errors(404, 409, 415) } },
    (c) => {
      const accountStore = requireStore();
      const actor = actorOf(c);
      const { rule, suspended } = accountStore.removeRule(accountId(c, "rule_unknown", "unknown access rule"), actor?.id ?? null);
      docify.logs.append("accounts", `${actor?.login ?? "?"} removed ${rule.kind} ${rule.value} from the access list${suspended.length ? `; waiting again: ${suspended.join(", ")}` : ""}`);
      return json({ ok: true, suspended });
    },
  );
  accountMember(
    { method: "get", path: "/api/me/keys", tags: ["Accounts"], summary: "List your MCP keys", description: "Any approved account. Only the caller's own keys; the key itself is never returned here. 404 when GitHub sign-in is off.", responses: { 200: s.json(z.object({ keys: z.array(s.Key), max: z.number() }), "List your MCP keys"), ...s.errors(404) } },
    (c) => {
      const { accountStore, user } = me(c);
      return json({ keys: accountStore.listKeys(user.id).map(keyView), max: MAX_KEYS_PER_USER });
    },
  );
  accountMember(
    { method: "post", path: "/api/me/keys", tags: ["Accounts"], summary: "Create an MCP key (token shown once)", description: "Any approved account. `token` is the key for `/mcp` (`Authorization: Bearer <token>`); this is the only response that carries it, the server keeps its SHA-256 hash. Names are unique per person, at most ten keys.", request: { body: s.jsonBody(s.KeyName) }, responses: { 201: s.json(z.object({ key: s.Key, token: z.string() }), "Create an MCP key (token shown once)"), ...s.errors(404, 400, 409, 415) } },
    (c) => {
      const { accountStore, user } = me(c);
      const { key, token } = accountStore.createKey(user.id, valid(c, "json", s.KeyName).name);
      docify.logs.append("accounts", `${user.login} created the MCP key "${key.name}"`);
      // The only answer that ever carries the key.
      return json({ key: keyView(key), token }, 201);
    },
  );
  accountMember(
    { method: "delete", path: "/api/me/keys/{id}", tags: ["Accounts"], summary: "Revoke your MCP key", description: "The key stops working at once. Another person's key answers 404.", request: { params: s.AccountId }, responses: { 200: s.json(s.Ok, "Revoke your MCP key"), ...s.errors(404, 409, 415) } },
    (c) => {
      const { accountStore, user } = me(c);
      const key = accountStore.revokeKey(user.id, accountId(c, "key_unknown", "unknown key"));
      docify.logs.append("accounts", `${user.login} revoked the MCP key "${key.name}"`);
      return json({ ok: true });
    },
  );
  accountMember(
    { method: "get", path: "/api/me/queries", tags: ["Accounts"], summary: "Read your recent searches", description: "Any approved account. The caller's own searches from the page and through their keys, newest first: the query and its outcome, not the passages. The newest `kept` are stored.", request: { query: s.HistoryQuery }, responses: { 200: s.json(z.object({ queries: z.array(s.HistoryEntry), kept: z.number() }), "Read your recent searches"), ...s.errors(404, 400) } },
    (c) => {
      const { accountStore, user } = me(c);
      const queries = accountStore.listQueries(user.id, valid(c, "query", s.HistoryQuery).limit);
      return json({
        queries: queries.map((q) => ({ id: q.id, at: q.at, via: q.via, keyName: q.key_name, query: q.query, scope: q.scope, status: q.status, hits: q.hits })),
        kept: MAX_QUERIES_PER_USER,
      });
    },
  );
  accountMember(
    { method: "delete", path: "/api/me/queries", tags: ["Accounts"], summary: "Clear your search history", responses: { 200: s.json(s.Ok.extend({ removed: z.number() }), "Clear your search history"), ...s.errors(404, 409, 415) } },
    (c) => {
      const { accountStore, user } = me(c);
      return json({ ok: true, removed: accountStore.clearQueries(user.id) });
    },
  );

  // ---- Server ----
  add(
    { method: "get", path: "/api/status", tags: ["Server"], summary: "Server and store status", responses: { 200: s.json(s.ServerStatus, "Version, store, running operations and source counts by state"), ...s.errors() } },
    () => {
      const counts: Record<string, number> = {};
      for (const source of sources(docify)) counts[source.state] = (counts[source.state] ?? 0) + 1;
      return json({ version: VERSION, home: docify.config.home, project, importing, running: [...running.keys()], sources: counts });
    },
  );
  add(
    { method: "get", path: "/api/logs", tags: ["Server"], summary: "Read log lines", description: "Lines in sequence order; pass the returned cursor as `after` to poll for new ones.", request: { query: s.LogsQuery }, responses: { 200: s.json(s.LogPage, "Log lines after the cursor"), ...s.errors(400, 500) } },
    (c) => {
      const q = valid(c, "query", s.LogsQuery);
      return json(docify.logs.read(q.after ?? 0, q.limit ?? 1000));
    },
  );
  add(
    { method: "get", path: "/api/config", tags: ["Settings"], summary: "Read the settings", responses: { 200: s.json(s.ConfigView, "Values, defaults and which keys config.json sets"), ...s.errors() } },
    () => json(describeConfig(docify.config)),
  );
  add(
    {
      method: "put",
      path: "/api/config",
      tags: ["Settings"],
      summary: "Change settings",
      description: "Writes only the given known keys to config.json and applies them without a restart. `graphifyBin`, `modelsDir` and `home` are read-only. Refused while a source operation runs.",
      request: { body: s.jsonBody(s.ConfigPatch) },
      responses: { 200: s.json(s.ConfigView, "The settings after the change"), ...s.errors(400, 409, 415) },
    },
    (c) => {
      const patch = valid(c, "json", s.ConfigPatch);
      if (running.size) throw new DocifyError("busy", `cannot change settings while ${[...running.keys()].join(", ")} has a running operation; wait or cancel first`);
      docify.saveConfig(patch);
      return json(describeConfig(docify.config));
    },
  );
  member(
    { method: "get", path: "/api/pins", tags: ["Settings"], summary: "Read project pins", description: "The nearest `.docify.json` above the directory `docify serve` started in.", responses: { 200: s.json(s.Pins, "Pins"), ...s.errors(400) } },
    (c) => json(isMember(c) ? { ...pinsView(), project: null, file: null } : pinsView()),
  );
  add(
    { method: "put", path: "/api/pins", tags: ["Settings"], summary: "Set or remove a version pin", request: { body: s.jsonBody(s.PinBody) }, responses: { 200: s.json(s.Pins, "Pins after the change"), ...s.errors(400, 415) } },
    (c) => {
      const b = valid(c, "json", s.PinBody);
      Docify.setPin(project, b.library, str(b.version) ?? null);
      return json(pinsView());
    },
  );

  // ---- Sources ----
  member(
    { method: "get", path: "/api/groups", tags: ["Sources"], summary: "List source groups", description: "Pass a group name in `groups` to search or scope all its sources.", responses: { 200: s.json(s.Groups, "Groups"), ...s.errors() } },
    () => json(docify.listGroups()),
  );
  member(
    {
      method: "get",
      path: "/api/sources",
      tags: ["Sources"],
      summary: "List or find sources",
      description: "Every registered source with its state, settings, summary and generations. With `query`, only sources whose identity or saved summary matches, best first.",
      request: { query: s.SourcesQuery },
      responses: { 200: s.json(z.array(s.SourceInfo), "Sources"), ...s.errors(400) },
    },
    (c) => {
      const { query } = valid(c, "query", s.SourcesQuery);
      if (query !== undefined) return json(discoverSources(docify, query, isMember(c) ? memberView : undefined));
      const list = sources(docify);
      return json(isMember(c) ? memberView(list) : list);
    },
  );
  add(
    {
      method: "post",
      path: "/api/sources",
      tags: ["Sources"],
      summary: "Register a source",
      description: "Registers a local directory (inside `DOCIFY_SOURCE_ROOTS`, default the home directory) or a URL. Nothing is fetched until it is prepared.",
      request: { body: s.jsonBody(s.AddSourceBody) },
      responses: { 201: s.json(z.object({ id: z.string() }).passthrough(), "The new source row"), ...s.errors(400, 409, 415) },
    },
    (c) => {
      const b = valid(c, "json", s.AddSourceBody);
      const version = str(b.version) ?? null;
      const labels = { title: b.title === undefined ? undefined : validateTitle(b.title), groups: b.groups === undefined ? undefined : validateGroups(b.groups) };
      if (b.kind === "local") {
        if (b.crawlProvider !== undefined || b.crawl !== undefined) throw new DocifyError("invalid_input", "crawler settings are only valid for URL sources");
        // The API may only register paths inside DOCIFY_SOURCE_ROOTS.
        let real: string;
        try {
          real = realpathSync(resolve(b.locator.replace(/^~(?=$|\/)/, homedir())));
        } catch {
          throw new DocifyError("invalid_input", `path does not exist: ${b.locator}`);
        }
        if (!withinSourceRoots(real, sourceRoots)) throw new DocifyError("invalid_input", `local sources must be inside DOCIFY_SOURCE_ROOTS (${sourceRoots.join(delimiter)})`);
        return json(docify.addSource({ library: b.library, version, kind: "local", locator: real, ignore: b.ignore, graphIgnore: b.graphIgnore, ...labels }), 201);
      }
      return json(docify.addSource({ library: b.library, version, kind: b.kind, locator: b.locator, crawlProvider: b.crawlProvider, crawl: b.crawl as never, ignore: b.ignore, graphIgnore: b.graphIgnore, ...labels }), 201);
    },
  );
  member(
    { method: "get", path: "/api/sources/{id}", tags: ["Sources"], summary: "Read one source", request: { params: s.SourceIdParam }, responses: { 200: s.json(s.SourceInfo, "The source"), ...s.errors(404) } },
    (c) => {
      const id = sourceId(c);
      docify.requireSource(id);
      const source = sources(docify).find((source) => source.id === id)!;
      return json(isMember(c) ? memberView([source])[0] : source);
    },
  );
  add(
    {
      method: "patch",
      path: "/api/sources/{id}",
      tags: ["Sources"],
      summary: "Change title, groups, crawler settings or ignore patterns",
      description: "Every value is checked before anything is written, so a bad one leaves the whole request unapplied. Crawler settings and ignore patterns take effect on the next prepare; title and groups at once, also while the source prepares. The id never changes.",
      request: { params: s.SourceIdParam, body: s.jsonBody(s.PatchSourceBody) },
      responses: { 200: s.json(s.Ok, "Saved"), ...s.errors(400, 404, 415) },
    },
    (c) => {
      const id = sourceId(c);
      const b = valid(c, "json", s.PatchSourceBody);
      const crawler = b.crawlProvider !== undefined || b.crawl4ai !== undefined || b.crawl !== undefined;
      const ignoring = b.ignore !== undefined || b.graphIgnore !== undefined;
      const labelling = b.title !== undefined || b.groups !== undefined;
      if (!crawler && !ignoring && !labelling) throw new DocifyError("invalid_input", "crawler settings, ignore patterns, title or groups are required");
      // Checked before anything is written, so a bad value cannot leave half of the request applied.
      for (const name of ["ignore", "graphIgnore"] as const) {
        if (b[name] !== undefined && b[name] !== null) validateIgnorePatterns(b[name], name);
      }
      if (b.title !== undefined) validateTitle(b.title);
      if (b.groups !== undefined) validateGroups(b.groups);
      if (labelling) docify.updateSourceLabels(id, { title: b.title, groups: b.groups });
      if (crawler) docify.updateSourceCrawler(id, b.crawlProvider, b.crawl4ai, b.crawl);
      if (ignoring) docify.updateSourceIgnore(id, { ignore: b.ignore, graphIgnore: b.graphIgnore });
      return json({ ok: true });
    },
  );
  add(
    { method: "delete", path: "/api/sources/{id}", tags: ["Sources"], summary: "Remove a source", description: "Deletes the source, its generations and snapshots. Refused while it prepares or summarizes.", request: { params: s.SourceIdParam }, responses: { 200: s.json(s.Ok, "Removed"), ...s.errors(404, 409, 415) } },
    (c) => {
      const id = sourceId(c);
      busyGuard(id);
      docify.removeSource(id);
      return json({ ok: true });
    },
  );
  add(
    {
      method: "get",
      path: "/api/sources/{id}/generations",
      tags: ["Sources"],
      summary: "List generations",
      description: "Every kept generation, newest first. A staging generation whose writer died reads as failed, as after recovery.",
      request: { params: s.SourceIdParam },
      responses: { 200: s.json(z.object({ source: z.string(), activeGeneration: z.number().nullable(), generations: z.array(s.Generation) }), "Generations"), ...s.errors(404) },
    },
    (c) => {
      const id = sourceId(c);
      return json(
        docify.db.transaction(() => {
          const source = docify.requireSource(id);
          const generations = docify.generations(id).map((row) => {
            const gen = effectiveGeneration(row, source);
            let stats: Record<string, unknown> = {};
            try {
              stats = JSON.parse(gen.stats || "{}");
            } catch {}
            return {
              id: gen.id,
              status: gen.status,
              phase: gen.phase,
              progress: gen.progress,
              error: gen.error,
              startedAt: gen.started_at,
              finishedAt: gen.finished_at,
              downloadedAt: gen.downloaded_at,
              snapshotHash: gen.snapshot_hash,
              embeddingModel: gen.embedding_model,
              embeddingDims: gen.embedding_dims,
              graphStatus: gen.graph_status,
              stats,
            };
          });
          return { source: id, activeGeneration: source.active_generation ?? null, generations };
        })(),
      );
    },
  );
  member(
    {
      method: "get",
      path: "/api/sources/{id}/documents",
      tags: ["Sources"],
      summary: "List document paths",
      description: "Paths of the active generation's documents, sorted. Empty when the source is not prepared.",
      request: { params: s.SourceIdParam },
      responses: { 200: s.json(z.object({ source: z.string(), generation: z.number().nullable(), paths: z.array(z.string()) }), "Document paths"), ...s.errors(404) },
    },
    (c) => {
      const id = sourceId(c);
      return json(
        docify.db.transaction(() => {
          const source = docify.requireSource(id);
          const generation = source.active_generation ? docify.getGeneration(source.active_generation) : null;
          if (!generation || generation.status !== "active") return { source: source.id, generation: null, paths: [] };
          const rows = docify.db.query<{ path: string }, [number]>("SELECT path FROM documents WHERE generation_id = ? ORDER BY path").all(generation.id);
          return { source: source.id, generation: generation.id, paths: rows.map((row) => row.path) };
        })(),
      );
    },
  );
  member(
    { method: "get", path: "/api/sources/{id}/graph", tags: ["Sources"], summary: "Read the knowledge graph", request: { params: s.SourceIdParam }, responses: { 200: s.json(s.GraphView, "Graph of the active generation"), ...s.errors(404) } },
    (c) => json(graphView(docify, sourceId(c))),
  );
  member(
    {
      method: "get",
      path: "/api/sources/{id}/artifacts/{kind}",
      tags: ["Sources"],
      summary: "Download a page artifact",
      description: "The screenshot or PDF that Crawl4AI captured for a single-page source, from the active generation.",
      request: { params: s.ArtifactParams },
      responses: {
        200: { description: "The file", content: { "image/png": { schema: z.string().openapi({ format: "binary" }) }, "application/pdf": { schema: z.string().openapi({ format: "binary" }) } } },
        ...s.errors(404),
      },
    },
    (c) => {
      const missing = () => json({ error: "artifact not found", code: "unavailable" }, 404);
      const { id, kind } = valid(c, "param", s.ArtifactParams);
      if (!/^[a-z0-9][a-z0-9._@-]{0,80}$/.test(id) || (kind !== "screenshot" && kind !== "pdf")) return missing();
      const generation = docify.getSource(id)?.active_generation;
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
      return new Response(Bun.file(file), {
        headers: {
          "content-type": kind === "screenshot" ? "image/png" : "application/pdf",
          "content-disposition": `attachment; filename="${filename}"`,
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        },
      });
    },
  );

  // ---- Operations ----
  add(
    {
      method: "post",
      path: "/api/sources/{id}/prepare",
      tags: ["Operations"],
      summary: "Start preparing a source",
      description: "Runs in the background: download, normalize, index, embed and (optionally) build the graph, then activate. Follow it through the source's `latest` and `/api/logs`.",
      request: { params: s.SourceIdParam, body: s.jsonBody(s.PrepareBody) },
      responses: { 202: s.json(z.object({ started: z.string() }), "Started"), ...s.errors(400, 404, 409, 415) },
    },
    (c) => {
      const id = sourceId(c);
      const b = valid(c, "json", s.PrepareBody);
      docify.requireSource(id);
      if (running.has(id)) throw new DocifyError("busy", `${id} is already being prepared`);
      const controller = new AbortController();
      running.set(id, controller);
      docify
        .prepare(id, { graph: b.graph, graphOnly: b.graphOnly, force: b.force, signal: controller.signal })
        .catch((err) => console.error(`prepare ${id} failed: ${err instanceof Error ? err.message : err}`))
        .finally(() => running.delete(id));
      return json({ started: id }, 202);
    },
  );
  add(
    { method: "post", path: "/api/sources/{id}/cancel", tags: ["Operations"], summary: "Cancel a running prepare or summary", description: "The previous generation keeps serving.", request: { params: s.SourceIdParam }, responses: { 200: s.json(z.object({ cancelled: z.literal(true) }), "Cancel requested"), ...s.errors(409, 415) } },
    (c) => {
      const controller = running.get(sourceId(c));
      if (!controller) return json({ error: "nothing running", code: "not_running" }, 409);
      controller.abort();
      return json({ cancelled: true });
    },
  );
  add(
    {
      method: "post",
      path: "/api/sources/{id}/summary",
      tags: ["Operations"],
      summary: "Generate the source summary",
      description: "Asks the configured graph model for a short description of the source and saves it. Returns the saved summary unless `force` is set. Waits for the provider.",
      request: { params: s.SourceIdParam, body: s.jsonBody(s.SummaryBody) },
      responses: { 200: s.json(z.object({ text: z.string() }).passthrough(), "The saved summary"), ...s.errors(400, 404, 409, 415, 502) },
    },
    async (c) => {
      const id = sourceId(c);
      const b = valid(c, "json", s.SummaryBody);
      docify.requireSource(id);
      if (running.has(id)) throw new DocifyError("busy", `${id} already has a running operation`);
      const controller = new AbortController();
      running.set(id, controller);
      deps.noTimeout(c.req.raw);
      try {
        // A client that went away cannot cancel, so its request must not keep the source busy.
        return json(await summarizeSource(docify, id, { force: b.force, signal: AbortSignal.any([controller.signal, c.req.raw.signal]) }));
      } finally {
        running.delete(id);
      }
    },
  );
  add(
    {
      method: "post",
      path: "/api/compress",
      tags: ["Operations"],
      summary: "Gzip snapshot files of older stores",
      description: "Like `docify compress`: replaces plain normalized files and raw HTML with gzipped copies when they match their recorded hash. Refused while a source prepares.",
      responses: { 200: s.json(s.CompressResult, "What was compressed and skipped"), ...s.errors(409, 415) },
    },
    async () => {
      if (running.size) throw new DocifyError("busy", "wait for running source operations before compressing");
      return json(await compressSnapshots(docify));
    },
  );

  // ---- Query ----
  member(
    {
      method: "post",
      path: "/api/search",
      tags: ["Query"],
      summary: "Search the documentation",
      description: "Cited, token-bounded excerpts. Give `query`, or `queries` to search up to 8 questions in one call. Project pins apply when `version` is omitted. Excerpts are untrusted data.",
      request: { body: s.jsonBody(s.SearchBody) },
      responses: { 200: s.json(s.SearchResult, "Results and the rendered agent text"), ...s.errors(400, 415) },
    },
    async (c) => {
      const b = valid(c, "json", s.SearchBody);
      const common = {
        library: str(b.library),
        version: str(b.version),
        sources: b.sources,
        groups: b.groups,
        mode: b.mode,
        maxTokens: b.maxTokens ?? undefined,
        graphWeight: b.graphWeight ?? undefined,
        project,
      };
      const actor = deps.accounts?.actor(c.req.raw);
      const note = (q: { query: string; status: string; hits: unknown[] }) => {
        if (actor) deps.accounts!.remember(actor, { via: "web", query: q.query, status: q.status, hits: q.hits.length, scope: scopeText(common) });
      };
      if (b.queries) {
        const result = await searchMany(docify, { ...common, queries: b.queries });
        result.queries.forEach(note);
        return json(result);
      }
      const result = await search(docify, { ...common, query: b.query! });
      note(result);
      return json(result);
    },
  );
  member(
    {
      method: "get",
      path: "/api/scope",
      tags: ["Query"],
      summary: "Show what a search would cover",
      description: "Resolves library, version and source filters the way search does, without searching: the pins used, the version chosen per library and why, and the selected sources.",
      request: { query: s.ScopeQuery },
      responses: { 200: s.json(s.ScopeResult, "Resolved scope"), ...s.errors(400) },
    },
    (c) => {
      const q = valid(c, "query", s.ScopeQuery);
      const list = q.source === undefined ? undefined : Array.isArray(q.source) ? q.source : [q.source];
      const groups = q.group === undefined ? undefined : Array.isArray(q.group) ? q.group : [q.group];
      const result = scope(docify, { library: str(q.library), version: str(q.version), sources: list, groups, project });
      return json(isMember(c) ? memberScope(result) : result);
    },
  );
  member(
    {
      method: "get",
      path: "/api/sources/{id}/outline",
      tags: ["Query"],
      summary: "Outline a source",
      description: "Documents with their section headings and the passage id of each section.",
      request: { params: s.SourceIdParam, query: s.OutlineQuery },
      responses: { 200: s.json(s.OutlineResult, "Outline"), ...s.errors(400) },
    },
    (c) => {
      const q = valid(c, "query", s.OutlineQuery);
      return json(outline(docify, { source: sourceId(c), path: q.path, maxTokens: q.maxTokens }));
    },
  );
  member(
    {
      method: "get",
      path: "/api/sources/{id}/open",
      tags: ["Query"],
      summary: "Open a document or one section",
      description: "A whole document, or one section with its subsections, from the active generation.",
      request: { params: s.SourceIdParam, query: s.OpenQuery },
      responses: { 200: s.json(s.OpenResult, "Document text"), ...s.errors(400) },
    },
    (c) => {
      const q = valid(c, "query", s.OpenQuery);
      return json(open(docify, { source: sourceId(c), path: q.path, heading: q.heading, maxTokens: q.maxTokens }));
    },
  );
  member(
    {
      method: "get",
      path: "/api/read/{id}",
      tags: ["Query"],
      summary: "Read a passage with context",
      description: "An id from an older generation returns that snapshot marked `superseded`, then `unavailable` after cleanup.",
      request: { params: s.PassageIdParam, query: s.ReadQuery },
      responses: { 200: s.json(s.ReadResult, "Passage"), ...s.errors(400) },
    },
    (c) => json(read(docify, valid(c, "param", s.PassageIdParam).id, valid(c, "query", s.ReadQuery).maxTokens)),
  );
  member(
    {
      method: "get",
      path: "/api/raw/{id}",
      tags: ["Query"],
      summary: "Raw source of a passage's document",
      description: "The preserved source file, only when it still matches its recorded hash.",
      request: { params: s.PassageIdParam },
      responses: { 200: { description: "File content", content: { "text/plain": { schema: z.string() } } }, ...s.errors(404) },
    },
    (c) => {
      const row = docify.db
        .query<{ raw_file: string; raw_sha256: string }, [string]>("SELECT d.raw_file, d.raw_sha256 FROM passages p JOIN documents d ON d.id = p.document_id WHERE p.id = ?")
        .get(valid(c, "param", s.PassageIdParam).id);
      if (!row) return json({ error: "unknown passage", code: "unavailable" }, 404);
      const root = realpathSync(join(docify.config.home, "snapshots"));
      const file = realpathSync(row.raw_file);
      if (!file.startsWith(root + sep)) return json({ error: "forbidden", code: "forbidden" }, 403);
      // Stored gzipped or plain; either way only the content the database recorded is served.
      const content = readSnapshotFile(file, row.raw_sha256);
      if (!content) return json({ error: "the preserved source no longer matches its recorded hash", code: "unavailable" }, 404);
      return new Response(content, { headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
    },
  );

  // ---- Backup ----
  add(
    {
      method: "get",
      path: "/api/export",
      tags: ["Backup"],
      summary: "Download a store backup",
      description: "A gzipped tar of the database, config.json and snapshots, with a manifest of SHA-256 sums. Refused while a source prepares.",
      responses: { 200: { description: "Backup archive", content: { "application/gzip": { schema: z.string().openapi({ format: "binary" }) } } }, ...s.errors(409) },
    },
    async () => {
      const { bytes, manifest } = await exportStore(docify);
      const name = `docify-backup-${manifest.createdAt.slice(0, 19).replace(/[:T]/g, "-")}.tar.gz`;
      return new Response(bytes, { headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" } });
    },
  );
  add(
    {
      method: "post",
      path: "/api/import",
      tags: ["Backup"],
      summary: "Restore a store backup",
      description: "Send the archive as raw bytes (`application/octet-stream`). A store with sources is replaced only with `force=1`; it is moved aside first. Local sources must be inside `DOCIFY_SOURCE_ROOTS`.",
      request: { query: s.ImportQuery, body: { required: true, content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } } } },
      responses: { 200: s.json(s.ImportResult, "Imported"), ...s.errors(400, 409, 415) },
    },
    async (c) => {
      const req = c.req.raw;
      const size = Number(req.headers.get("content-length") ?? "0");
      if (size > IMPORT_MAX_BYTES) throw new DocifyError("invalid_input", "the backup is larger than the upload limit; use docify import on the server");
      const data = new Uint8Array(await req.arrayBuffer());
      if (!data.length) throw new DocifyError("invalid_input", "empty upload");
      const q = valid(c, "query", s.ImportQuery);
      // Like adding one, an imported local source must be inside DOCIFY_SOURCE_ROOTS.
      const checkLocalSource = (path: string) => {
        const real = existsSync(path) ? realpathSync(path) : resolve(path);
        if (!withinSourceRoots(real, sourceRoots)) throw new DocifyError("invalid_input", `the backup has a local source outside DOCIFY_SOURCE_ROOTS: ${path}`);
      };
      if (running.size) throw new DocifyError("busy", "wait for running source operations before importing");
      importing = true;
      try {
        return json(await importStore(docify, data, { force: q.force === "1", keepConfig: q.keepConfig === "1", checkLocalSource }));
      } finally {
        importing = false;
      }
    },
  );

  return app;
}

export type ApiApp = ReturnType<typeof createApi>;

// The spec does not depend on the store, so it is built once from a route table with no store behind it.
let cachedSpec: unknown;
export function openApiSpec(): { openapi: string; paths: Record<string, Record<string, unknown>> } & Record<string, unknown> {
  cachedSpec ??= createApi({ docify: null as never, project: "", sourceRoots: [], guard: () => null, noTimeout: () => {} }).getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "Docify web API",
      version: VERSION,
      description:
        "Controls Docify and reads everything it stores: sources, preparation, generations, search, settings, logs and backups. When `DOCIFY_WEB_TOKEN` is set, every call needs it, sent as `X-Docify-Token`; without it the API needs no token unless GitHub accounts are enabled. With accounts, use the session cookie (named `__Host-docify_session` over HTTPS). Members may search, read and manage their own keys and history; management routes require an administrator. Requests other than GET must send JSON, except `/api/import`, which takes the backup as raw bytes. Errors are `{ error, code, field? }`.",
    },
    servers: [{ url: "/" }],
    security: [{ docifyToken: [] }, { docifySession: [] }],
    tags: [
      { name: "Sources", description: "Register, configure, inspect and remove sources" },
      { name: "Operations", description: "Prepare, cancel, summarize and compress" },
      { name: "Query", description: "Search and read prepared documentation; never writes" },
      { name: "Settings", description: "config.json and project pins" },
      { name: "Backup", description: "Export and import the whole store" },
      { name: "Accounts", description: "Sessions, personal keys, search history and access administration" },
      { name: "Server", description: "Status and logs" },
    ],
  });
  return cachedSpec as never;
}

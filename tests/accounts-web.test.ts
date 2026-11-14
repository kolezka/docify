import { afterEach, expect, test } from "bun:test";
import { parseAdmins } from "../src/core/accounts.ts";
import { accountsFromEnv, startServer, type StartServerOptions } from "../src/web/server.ts";
import { newDocify, tempDir } from "./helpers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  asked.length = 0;
});

interface Person {
  id: number;
  login: string;
  name: string | null;
  // Organization name to membership state, or the HTTP status GitHub answers with.
  orgs?: Record<string, "active" | "pending" | number>;
  emails?: { email: string; verified: boolean }[];
  // What the person granted at GitHub; everything asked for unless set.
  scope?: string;
}
const PEOPLE: Record<string, Person> = {
  "code-boss": { id: 1, login: "boss", name: "The Boss" },
  "code-alice": { id: 101, login: "alice", name: null },
  // A display name with a right-to-left override and a bell character.
  "code-mallory": { id: 202, login: "mallory", name: "Mal\u202elory\u0007" },
  "code-carol": { id: 303, login: "carol", name: null, orgs: { acme: "active" } },
  "code-dave": { id: 404, login: "dave", name: null, emails: [{ email: "Dave@Example.com", verified: true }, { email: "ceo@example.com", verified: false }] },
  "code-erin": { id: 505, login: "erin", name: null, emails: [{ email: "erin@elsewhere.test", verified: true }] },
  // Invited to the organization but has not accepted.
  "code-pat": { id: 606, login: "pat", name: null, orgs: { acme: "pending" } },
  // The organization does not let this OAuth app read its membership.
  "code-frank": { id: 707, login: "frank", name: null, orgs: { acme: 403 } },
  // A member who took the organization scope out of the link.
  "code-gina": { id: 808, login: "gina", name: null, orgs: { acme: "active" }, scope: "" },
};
// Every request the server made to the stand-in, so a test can see what was asked.
const asked: string[] = [];

// Stands in for GitHub: a code is the access token of the person it belongs to.
const fakeGitHub = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("access_token")) {
    const { code, client_secret } = JSON.parse(String(init?.body));
    if (client_secret !== "s3cret-for-tests") return Response.json({ error: "incorrect_client_credentials" });
    return Response.json(PEOPLE[code] ? { access_token: code, token_type: "bearer", scope: PEOPLE[code].scope ?? "read:org,user:email" } : { error: "bad_verification_code" });
  }
  const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
  const person = PEOPLE[token];
  if (!person) return new Response("{}", { status: 401 });
  const path = new URL(url).pathname;
  asked.push(path);
  const org = /^\/user\/memberships\/orgs\/([^/]+)$/.exec(path)?.[1];
  if (org) {
    const state = person.orgs?.[org];
    if (typeof state === "number") return new Response("{}", { status: state });
    return state ? Response.json({ state, organization: { login: org } }) : new Response("{}", { status: 404 });
  }
  if (path === "/user/emails") return Response.json(person.emails ?? []);
  return Response.json({ id: person.id, login: person.login, name: person.name });
}) as typeof fetch;

async function setup(opts: { publicUrl?: string; admins?: string; allowedHosts?: string[]; mcpClients?: StartServerOptions["mcpClients"]; mcpClientRate?: StartServerOptions["mcpClientRate"] } = {}) {
  const d = newDocify(tempDir());
  const server = await startServer(0, {
    docify: d,
    quiet: true,
    // Pins are written under the project; without this they land in the repository.
    project: tempDir(),
    allowedHosts: opts.allowedHosts,
    // Never from .env: these tests decide themselves whether shared MCP tokens exist.
    mcpClients: opts.mcpClients ?? [],
    mcpClientRate: opts.mcpClientRate ?? { limit: 1000, windowMs: 60_000 },
    mcpIpRate: { limit: 1000, windowMs: 60_000 },
    accounts: { github: { clientId: "client-id", clientSecret: "s3cret-for-tests", fetch: fakeGitHub }, admins: parseAdmins(opts.admins ?? "boss"), publicUrl: opts.publicUrl },
  });
  cleanup.push(() => {
    server.stop(true);
    server.accounts?.close();
    d.close();
  });
  const base = `http://127.0.0.1:${server.port}`;
  const call = async (path: string, cookie = "", method = "GET", body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      redirect: "manual",
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, res, data: (await res.clone().json().catch(() => null)) as any };
  };
  // With an https public address the cookies carry the __Host- prefix.
  const cookiePair = (res: Response, name: string) =>
    res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`) || c.startsWith(`__Host-${name}=`))?.split(";")[0] ?? "";
  // Walks the sign-in the way a browser does and returns the session cookie, or the page it landed on.
  const signIn = async (code: string) => {
    const start = await call("/auth/github");
    const state = new URL(start.res.headers.get("location")!).searchParams.get("state")!;
    const back = await call(`/auth/github/callback?code=${code}&state=${state}`, cookiePair(start.res, "docify_oauth_state"));
    return { cookie: cookiePair(back.res, "docify_session"), location: back.res.headers.get("location"), res: back.res };
  };
  // One JSON-RPC call to /mcp, the way an agent's client sends it.
  const mcp = async (token: string | null, method = "tools/list", params: unknown = {}) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const data = (await res.json().catch(() => null)) as any;
    return { status: res.status, res, data, text: String(data?.result?.content?.[0]?.text ?? "") };
  };
  // The administrator and an approved member, both signed in.
  const people = async () => {
    const admin = (await signIn("code-boss")).cookie;
    const alice = (await signIn("code-alice")).cookie;
    const id = (await call("/api/users", admin)).data.users[0].id;
    await call(`/api/users/${id}`, admin, "PATCH", { status: "active" });
    return { admin, alice, aliceId: id as number };
  };
  return { base, call, signIn, cookiePair, server, d, mcp, people };
}

test("sign-in starts at GitHub with a state that is also set as a cookie", async () => {
  const { call } = await setup();
  const { status, res } = await call("/auth/github");
  expect(status).toBe(302);
  const to = new URL(res.headers.get("location")!);
  expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(to.searchParams.get("client_id")).toBe("client-id");
  // The secret never leaves the server, and no scope is asked for.
  expect(to.search).not.toContain("s3cret");
  expect(to.searchParams.has("scope")).toBe(false);
  const state = to.searchParams.get("state")!;
  expect(state.length).toBeGreaterThanOrEqual(32);
  const cookie = res.headers.getSetCookie()[0]!;
  expect(cookie).toStartWith(`docify_oauth_state=${state};`);
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Lax");
});

test("a named administrator signs in and gets an HttpOnly session; the page then knows who it is", async () => {
  const { call, signIn } = await setup();
  expect((await call("/api/session")).data).toEqual({ accounts: true, user: null, asks: { orgs: false, emails: false } });
  const { cookie, location, res } = await signIn("code-boss");
  expect(location).toBe("/");
  expect(cookie).toMatch(/^docify_session=[A-Za-z0-9_-]{43}$/);
  const set = res.headers.getSetCookie().find((c) => c.startsWith("docify_session="))!;
  expect(set).toContain("HttpOnly");
  expect(set).toContain("SameSite=Lax");
  expect(set).not.toContain("Secure");
  expect((await call("/api/session", cookie)).data).toEqual({ accounts: true, user: { id: 1, login: "boss", name: "The Boss", role: "admin", status: "active" }, asks: { orgs: false, emails: false } });
  expect((await call("/api/sources", cookie)).status).toBe(200);
  expect((await call("/api/config", cookie)).status).toBe(200);
});

test("with a public https address the cookies are Secure", async () => {
  const { signIn } = await setup({ publicUrl: "https://docs.example.com" });
  const { res, cookie } = await signIn("code-boss");
  // __Host- makes the browser refuse a copy set for a parent domain or over plain http.
  const set = res.headers.getSetCookie().find((c) => c.startsWith("__Host-docify_session="))!;
  expect(set).toContain("; Secure");
  expect(set).toContain("Path=/;");
  expect(set).not.toContain("Domain");
  expect(cookie).toStartWith("__Host-docify_session=");
});

test("the callback refuses a wrong, missing or replayed state, a bad code, and a cancelled sign-in", async () => {
  const { call, cookiePair } = await setup();
  const start = await call("/auth/github");
  const state = new URL(start.res.headers.get("location")!).searchParams.get("state")!;
  const stateCookie = cookiePair(start.res, "docify_oauth_state");
  const landed = async (path: string, cookie = "") => {
    const r = await call(path, cookie);
    expect(r.status).toBe(302);
    expect(cookiePair(r.res, "docify_session")).toBe("");
    return r.res.headers.get("location");
  };
  // A link built by someone else carries a state this browser has no cookie for.
  expect(await landed(`/auth/github/callback?code=code-boss&state=${state}`)).toBe("/#signin=expired");
  expect(await landed(`/auth/github/callback?code=code-boss&state=${"x".repeat(32)}`, stateCookie)).toBe("/#signin=expired");
  expect(await landed("/auth/github/callback?code=code-boss", stateCookie)).toBe("/#signin=expired");
  expect(await landed(`/auth/github/callback?code=stolen&state=${state}`, stateCookie)).toBe("/#signin=failed");
  expect(await landed(`/auth/github/callback?error=access_denied&state=${state}`, stateCookie)).toBe("/#signin=cancelled");
});

test("without a session every data route answers 401, and the token header opens nothing", async () => {
  const { base, call } = await setup();
  for (const path of ["/api/sources", "/api/config", "/api/logs", "/api/users", "/api/pins", "/api/export"]) {
    expect((await call(path)).status).toBe(401);
    expect((await call(path, "docify_session=" + "x".repeat(43))).status).toBe(401);
  }
  expect((await call("/api/search", "", "POST", { query: "x" })).data.code).toBe("unauthorized");
  const res = await fetch(`${base}/api/sources`, { headers: { "x-docify-token": "a".repeat(32) } });
  expect(res.status).toBe(401);
});

test("a new sign-up is pending and sees nothing until an administrator approves it", async () => {
  const { call, signIn } = await setup();
  const admin = (await signIn("code-boss")).cookie;
  const alice = (await signIn("code-alice")).cookie;
  expect((await call("/api/session", alice)).data.user).toMatchObject({ login: "alice", role: "member", status: "pending" });
  for (const path of ["/api/sources", "/api/pins", "/api/config", "/api/users"]) {
    const r = await call(path, alice);
    expect(r.status).toBe(403);
    expect(r.data.error).toContain("waiting for an administrator");
  }
  expect((await call("/api/search", alice, "POST", { query: "x" })).status).toBe(403);

  const list = (await call("/api/users", admin)).data.users;
  // Pending accounts come first, so the administrator sees what needs a decision.
  expect(list.map((u: any) => [u.login, u.status, u.named, u.self])).toEqual([["alice", "pending", false, false], ["boss", "active", true, true]]);
  const id = list[0].id;
  expect((await call(`/api/users/${id}`, admin, "PATCH", { status: "active" })).data).toMatchObject({ login: "alice", status: "active", role: "member" });
  expect((await call("/api/sources", alice)).status).toBe(200);
});

test("a member can search and read, and cannot manage sources, settings, backups, logs or users", async () => {
  const { call, signIn } = await setup();
  const admin = (await signIn("code-boss")).cookie;
  const alice = (await signIn("code-alice")).cookie;
  const id = (await call("/api/users", admin)).data.users[0].id;
  await call(`/api/users/${id}`, admin, "PATCH", { status: "active" });

  expect((await call("/api/sources", alice)).status).toBe(200);
  expect((await call("/api/pins", alice)).status).toBe(200);
  expect((await call("/api/search", alice, "POST", { query: "anything" })).status).toBe(200);
  expect((await call(`/api/read/p_${"0".repeat(20)}`, alice)).data.status).toBe("unavailable");

  const refused: [string, string, unknown?][] = [
    ["/api/sources", "POST", { library: "x", locator: "/tmp" }],
    ["/api/sources/x@1", "PATCH", { crawlProvider: null }],
    ["/api/sources/x@1", "PATCH", { ignore: ["^changelog/"] }],
    ["/api/sources/x@1/summary", "POST", {}],
    ["/api/sources/x@1", "DELETE", {}],
    ["/api/sources/x@1/prepare", "POST", {}],
    ["/api/sources/x@1/cancel", "POST", {}],
    ["/api/config", "GET"],
    ["/api/config", "PUT", { maxTokens: 10 }],
    ["/api/pins", "PUT", { library: "x", version: "1" }],
    ["/api/logs", "GET"],
    ["/api/export", "GET"],
    ["/api/users", "GET"],
    [`/api/users/${id}`, "PATCH", { role: "admin" }],
    [`/api/users/${id}`, "DELETE", {}],
    ["/api/access", "GET"],
    ["/api/access", "PUT", { outsiders: "refuse" }],
    ["/api/access/rules", "POST", { kind: "login", value: "alice" }],
    ["/api/access/rules/1", "DELETE", {}],
  ];
  for (const [path, method, body] of refused) {
    const r = await call(path, alice, method, body);
    expect([path, method, r.status, r.data?.error]).toEqual([path, method, 403, "only administrators can do this"]);
  }
  // A member cannot make themselves an administrator.
  expect((await call("/api/session", alice)).data.user.role).toBe("member");
});

test("disabling a member ends their session at once; signing in again is refused", async () => {
  const { call, signIn } = await setup();
  const admin = (await signIn("code-boss")).cookie;
  const alice = (await signIn("code-alice")).cookie;
  const id = (await call("/api/users", admin)).data.users[0].id;
  await call(`/api/users/${id}`, admin, "PATCH", { status: "active" });
  expect((await call("/api/sources", alice)).status).toBe(200);

  expect((await call(`/api/users/${id}`, admin, "PATCH", { status: "disabled" })).data.status).toBe("disabled");
  expect((await call("/api/sources", alice)).status).toBe(401);
  const again = await signIn("code-alice");
  expect(again.location).toBe("/#signin=disabled");
  expect(again.cookie).toBe("");
});

test("administrators cannot change themselves or a named administrator, and bad ids are 404", async () => {
  const { call, signIn } = await setup();
  const admin = (await signIn("code-boss")).cookie;
  const self = (await call("/api/users", admin)).data.users[0].id;
  expect((await call(`/api/users/${self}`, admin, "PATCH", { role: "member" })).status).toBe(409);
  expect((await call(`/api/users/${self}`, admin, "DELETE", {})).status).toBe(409);
  expect((await call("/api/users/999", admin, "PATCH", { status: "active" })).status).toBe(404);
  expect((await call("/api/users/abc", admin, "DELETE", {})).status).toBe(404);
  expect((await call(`/api/users/${self}`, admin, "PATCH", { role: "owner" })).status).toBe(400);
});

test("removing a member and signing out", async () => {
  const { call, signIn, cookiePair } = await setup();
  const admin = (await signIn("code-boss")).cookie;
  const alice = (await signIn("code-alice")).cookie;
  const id = (await call("/api/users", admin)).data.users[0].id;
  expect((await call(`/api/users/${id}`, admin, "DELETE", {})).data).toEqual({ ok: true });
  expect((await call("/api/session", alice)).data.user).toBeNull();
  expect((await call("/api/users", admin)).data.users.length).toBe(1);

  const out = await call("/api/session", admin, "DELETE", {});
  expect(out.status).toBe(200);
  expect(out.res.headers.getSetCookie()[0]).toContain("Max-Age=0");
  expect(cookiePair(out.res, "docify_session")).toBe("docify_session=");
  expect((await call("/api/sources", admin)).status).toBe(401);
});

// The cookie travels on its own, so a write from another site must be stopped some other way.
test("a cross-site write with a valid session is refused", async () => {
  const { base, call, signIn } = await setup();
  const admin = (await signIn("code-boss")).cookie;
  const id = (await call("/api/users", admin)).data.users[0].id;
  const foreign = await fetch(`${base}/api/users/${id}`, { method: "DELETE", headers: { cookie: admin, "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
  expect(foreign.status).toBe(403);
  // A plain form post needs no preflight; the JSON content type rule turns it away.
  const form = await fetch(`${base}/api/session`, { method: "DELETE", headers: { cookie: admin, "content-type": "text/plain" }, body: "{}" });
  expect(form.status).toBe(415);
  expect((await call("/api/session", admin)).data.user.login).toBe("boss");
});

test("sign-in attempts are limited per address", async () => {
  const { call } = await setup();
  let last = 0;
  for (let i = 0; i < 31; i++) last = (await call("/auth/github")).status;
  expect(last).toBe(429);
});

test("without accounts the server behaves as before: no sign-in routes, token access", async () => {
  const d = newDocify(tempDir());
  const server = await startServer(0, { docify: d, quiet: true, token: "a".repeat(32) });
  cleanup.push(() => {
    server.stop(true);
    d.close();
  });
  const base = `http://127.0.0.1:${server.port}`;
  expect(server.accounts).toBeNull();
  expect((await fetch(`${base}/auth/github`, { redirect: "manual" })).status).toBe(404);
  expect(await (await fetch(`${base}/api/session`)).json()).toEqual({ accounts: false, user: null });
  expect((await fetch(`${base}/api/sources`)).status).toBe(401);
  expect((await fetch(`${base}/api/sources`, { headers: { "x-docify-token": "a".repeat(32) } })).status).toBe(200);
  expect((await fetch(`${base}/api/users`, { headers: { "x-docify-token": "a".repeat(32) } })).status).toBe(404);
});

test("configuration mistakes stop the server at start", async () => {
  const d = newDocify(tempDir());
  cleanup.push(() => d.close());
  const github = { clientId: "client-id", clientSecret: "s3cret-for-tests", fetch: fakeGitHub };
  await expect(startServer(0, { docify: d, quiet: true, accounts: { github, admins: parseAdmins("") } })).rejects.toThrow("DOCIFY_ADMINS");
  await expect(startServer(0, { docify: d, quiet: true, token: "a".repeat(32), accounts: { github, admins: parseAdmins("boss") } })).rejects.toThrow("DOCIFY_WEB_TOKEN");
});

test("accountsFromEnv: off without the GitHub variables, strict when they are half set", () => {
  expect(accountsFromEnv({})).toBeNull();
  expect(accountsFromEnv({ DOCIFY_GITHUB_CLIENT_ID: " ", DOCIFY_ADMINS: "boss" })).toBeNull();
  expect(() => accountsFromEnv({ DOCIFY_GITHUB_CLIENT_ID: "id" })).toThrow("set both");
  expect(() => accountsFromEnv({ DOCIFY_GITHUB_CLIENT_SECRET: "secret" })).toThrow("set both");
  const on = accountsFromEnv({ DOCIFY_GITHUB_CLIENT_ID: "id", DOCIFY_GITHUB_CLIENT_SECRET: "secret", DOCIFY_ADMINS: "boss", DOCIFY_PUBLIC_URL: "https://docs.example.com/" })!;
  expect(on.publicUrl).toBe("https://docs.example.com");
  expect(on.github.redirectUri).toBe("https://docs.example.com/auth/github/callback");
  expect([...on.admins.logins]).toEqual(["boss"]);
  expect(accountsFromEnv({ DOCIFY_GITHUB_CLIENT_ID: "id", DOCIFY_GITHUB_CLIENT_SECRET: "secret" })!.github.redirectUri).toBeUndefined();
  for (const bad of ["docs.example.com", "ftp://docs.example.com", "https://docs.example.com/app", "https://user:pw@docs.example.com"]) {
    expect(() => accountsFromEnv({ DOCIFY_GITHUB_CLIENT_ID: "id", DOCIFY_GITHUB_CLIENT_SECRET: "secret", DOCIFY_PUBLIC_URL: bad })).toThrow("DOCIFY_PUBLIC_URL");
  }
});

// Findings of the security review, 2026-11-14.
test("the callback answers a malformed state with the sign-in page, not an error", async () => {
  const { call, d } = await setup();
  const r = await call(`/auth/github/callback?code=x&state=${encodeURIComponent("a".repeat(31) + "é")}`, `docify_oauth_state=${"a".repeat(32)}`);
  expect([r.status, r.res.headers.get("location")]).toEqual([302, "/#signin=expired"]);
  expect(d.logs.read(0, 1000).lines.filter((l) => l.level === "error")).toEqual([]);
  // GitHub's error is trusted only together with this browser's state.
  expect((await call("/auth/github/callback?error=access_denied")).res.headers.get("location")).toBe("/#signin=expired");
});

test("a cookie sent twice is refused, so a planted copy cannot win", async () => {
  const { call, signIn, cookiePair } = await setup();
  const start = await call("/auth/github");
  const real = cookiePair(start.res, "docify_oauth_state");
  const planted = "a".repeat(32);
  const r = await call(`/auth/github/callback?code=code-alice&state=${planted}`, `docify_oauth_state=${planted}; ${real}`);
  expect([r.res.headers.get("location"), cookiePair(r.res, "docify_session")]).toEqual(["/#signin=expired", ""]);
  const admin = (await signIn("code-boss")).cookie;
  expect((await call("/api/users", `docify_session=${"x".repeat(43)}; ${admin}`)).status).toBe(401);
  expect((await call("/api/users", admin)).status).toBe(200);
});

test("signing in again in the same browser ends the earlier session", async () => {
  const { call, signIn, cookiePair } = await setup();
  const first = (await signIn("code-boss")).cookie;
  const start = await call("/auth/github");
  const state = new URL(start.res.headers.get("location")!).searchParams.get("state")!;
  const back = await call(`/auth/github/callback?code=code-boss&state=${state}`, `${cookiePair(start.res, "docify_oauth_state")}; ${first}`);
  const second = cookiePair(back.res, "docify_session");
  expect(second).not.toBe(first);
  expect((await call("/api/users", first)).status).toBe(401);
  expect((await call("/api/users", second)).status).toBe(200);
});

// A link on another site carries the Lax cookie. Nothing under /api may answer it.
test("a request that the browser marks as cross-site is refused", async () => {
  const { base, call, signIn } = await setup();
  const admin = (await signIn("code-boss")).cookie;
  const from = (site: string) => fetch(`${base}/api/export`, { headers: { cookie: admin, "sec-fetch-site": site, "sec-fetch-mode": "navigate" } });
  const cross = await from("cross-site");
  expect(cross.status).toBe(403);
  expect((await cross.json()).code).toBe("forbidden");
  expect((await from("same-origin")).status).toBe(200);
  expect((await call("/api/export", admin)).status).toBe(200);
});

test("answers that depend on who asks are never cached", async () => {
  const { call, signIn } = await setup();
  const admin = (await signIn("code-boss")).cookie;
  for (const path of ["/api/session", "/api/users", "/api/sources"]) {
    expect([path, (await call(path, admin)).res.headers.get("cache-control")]).toEqual([path, "no-store"]);
  }
  expect((await call("/api/session")).res.headers.get("cache-control")).toBe("no-store");
});

test("a member sees sources without server paths", async () => {
  const { call, signIn, d } = await setup();
  const docs = tempDir();
  await Bun.write(`${docs}/a.md`, "# A\n\ntext\n");
  d.addSource({ library: "lib", version: "1", kind: "local", locator: docs });
  const admin = (await signIn("code-boss")).cookie;
  const alice = (await signIn("code-alice")).cookie;
  const id = (await call("/api/users", admin)).data.users[0].id;
  await call(`/api/users/${id}`, admin, "PATCH", { status: "active" });

  expect((await call("/api/sources", admin)).data[0].locator).toBe(docs);
  const seen = (await call("/api/sources", alice)).data[0];
  expect(seen.locator).toBe(docs.split("/").pop());
  expect(JSON.stringify(seen)).not.toContain(docs);
  const pins = (await call("/api/pins", alice)).data;
  expect([pins.project, pins.file]).toEqual([null, null]);
  expect(typeof (await call("/api/pins", admin)).data.project).toBe("string");
});

test("settings cannot name the server's own secrets as a credential variable", async () => {
  const { call, signIn } = await setup();
  const admin = (await signIn("code-boss")).cookie;
  for (const patch of [{ crawl4aiApiKeyEnv: "DOCIFY_GITHUB_CLIENT_SECRET" }, { embeddingApiKeyEnv: "DOCIFY_MCP_TOKENS" }, { embeddingBaseUrlEnv: "DOCIFY_WEB_TOKEN" }]) {
    const r = await call("/api/config", admin, "PUT", patch);
    expect([Object.keys(patch)[0], r.status, r.data.code]).toEqual([Object.keys(patch)[0], 400, "invalid_input"]);
  }
  expect((await call("/api/config", admin, "PUT", { embeddingApiKeyEnv: "MY_EMBEDDING_KEY" })).status).toBe(200);
});

test("control and direction characters are dropped from a display name", async () => {
  const { call, signIn } = await setup();
  const { cookie } = await signIn("code-mallory");
  expect((await call("/api/session", cookie)).data.user.name).toBe("Mallory");
});

test("off loopback, sign-in needs the public address", async () => {
  const d = newDocify(tempDir());
  cleanup.push(() => d.close());
  const github = { clientId: "client-id", clientSecret: "s3cret-for-tests", fetch: fakeGitHub };
  await expect(startServer(0, { docify: d, quiet: true, host: "0.0.0.0", accounts: { github, admins: parseAdmins("boss") } })).rejects.toThrow("DOCIFY_PUBLIC_URL");
});

// Hostname alone is not enough: the same name over plain http or on another port is another origin.
test("with a public address a write must come from exactly that origin", async () => {
  const { base, signIn, call } = await setup({ publicUrl: "https://docs.example.com", allowedHosts: ["docs.example.com"] });
  const admin = (await signIn("code-boss")).cookie;
  const write = (origin: string) =>
    fetch(`${base}/api/pins`, { method: "PUT", headers: { cookie: admin, host: "docs.example.com", origin, "content-type": "application/json" }, body: JSON.stringify({ library: "lib", version: "1" }) });
  expect((await write("http://docs.example.com")).status).toBe(403);
  expect((await write("https://docs.example.com:8443")).status).toBe(403);
  expect((await write("https://docs.example.com")).status).toBe(200);
  const page = await call("/");
  expect(page.res.headers.get("strict-transport-security")).toContain("max-age=");
});

// Use inside a company: each person makes their own MCP key and sees their own searches.
test("a member makes a personal MCP key, sees it once, and /mcp accepts it until it is revoked", async () => {
  const { call, mcp, people } = await setup();
  const { alice } = await people();
  expect((await call("/api/me/keys", alice)).data).toEqual({ keys: [], max: 10 });

  const made = await call("/api/me/keys", alice, "POST", { name: "laptop" });
  expect(made.status).toBe(201);
  const token: string = made.data.token;
  expect(token).toMatch(/^dcf_[A-Za-z0-9_-]{43}$/);
  expect(made.data.key).toMatchObject({ name: "laptop", prefix: token.slice(0, 8), lastUsedAt: null });
  expect((await call("/api/me/keys", alice, "POST", { name: "laptop" })).status).toBe(409);
  expect((await call("/api/me/keys", alice, "POST", {})).status).toBe(400);

  // No shared tokens are configured: /mcp exists because accounts are on.
  expect((await mcp(null)).status).toBe(401);
  expect((await mcp("dcf_" + "x".repeat(43))).status).toBe(401);
  const listed = await mcp(token);
  expect(listed.status).toBe(200);
  expect(listed.data.result.tools.map((t: any) => t.name)).toContain("docs_search");

  // The list never shows the key again, only how it starts and when it was used.
  const keys = (await call("/api/me/keys", alice)).data.keys;
  expect(keys.length).toBe(1);
  expect(keys[0].lastUsedAt).not.toBeNull();
  expect(JSON.stringify(keys)).not.toContain(token.slice(8));

  expect((await call(`/api/me/keys/${keys[0].id}`, alice, "DELETE", {})).data).toEqual({ ok: true });
  expect((await mcp(token)).status).toBe(401);
  expect((await call("/api/me/keys", alice)).data.keys).toEqual([]);
});

test("keys belong to their owner: nobody else lists or revokes them, and a waiting account gets none", async () => {
  const { base, call, signIn, mcp, people } = await setup();
  const { admin, alice, aliceId } = await people();
  const made = (await call("/api/me/keys", alice, "POST", { name: "laptop" })).data;

  expect((await call("/api/me/keys", admin)).data.keys).toEqual([]);
  expect((await call(`/api/me/keys/${made.key.id}`, admin, "DELETE", {})).status).toBe(404);
  expect((await call("/api/me/keys/abc", alice, "DELETE", {})).status).toBe(404);
  expect((await mcp(made.token)).status).toBe(200);

  expect((await call("/api/me/keys")).status).toBe(401);
  expect((await call("/api/me/keys", "", "POST", { name: "x" })).status).toBe(401);
  const waiting = (await signIn("code-mallory")).cookie;
  expect((await call("/api/me/keys", waiting, "POST", { name: "x" })).status).toBe(403);
  // The session cookie travels on its own; a page elsewhere cannot mint a key with it.
  const foreign = await fetch(`${base}/api/me/keys`, { method: "POST", headers: { cookie: alice, "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ name: "evil" }) });
  expect(foreign.status).toBe(403);

  // Disabling the person ends the key as well as the session.
  await call(`/api/users/${aliceId}`, admin, "PATCH", { status: "disabled" });
  expect((await mcp(made.token)).status).toBe(401);
});

test("searches from the page and through a personal key land in that person's history only", async () => {
  const shared = "s".repeat(32);
  const { call, mcp, people } = await setup({ mcpClients: [{ name: "ci", token: shared }] });
  const { admin, alice } = await people();
  const { token } = (await call("/api/me/keys", alice, "POST", { name: "laptop" })).data;
  expect((await call("/api/me/queries", alice)).data).toEqual({ queries: [], kept: 200 });

  expect((await call("/api/search", alice, "POST", { query: "how to serve", sources: ["bun@1.4.3"] })).status).toBe(200);
  expect((await mcp(token, "tools/call", { name: "docs_search", arguments: { query: "websocket upgrade", library: "bun" } })).data.result.isError).toBeFalsy();
  expect((await mcp(token, "tools/call", { name: "docs_search", arguments: { queries: ["first of two", "second of two"] } })).data.result.isError).toBeFalsy();
  // Reading and listing are not searches, and a shared token belongs to no person.
  await mcp(token, "tools/call", { name: "docs_sources", arguments: {} });
  expect((await mcp(shared, "tools/call", { name: "docs_search", arguments: { query: "from the shared token" } })).status).toBe(200);

  const mine = (await call("/api/me/queries", alice)).data.queries;
  expect(mine.map((q: any) => [q.query, q.via, q.keyName, q.scope])).toEqual([
    ["second of two", "mcp", "laptop", null],
    ["first of two", "mcp", "laptop", null],
    ["websocket upgrade", "mcp", "laptop", "bun"],
    ["how to serve", "web", null, "bun@1.4.3"],
  ]);
  for (const q of mine) {
    expect(typeof q.status).toBe("string");
    expect(typeof q.hits).toBe("number");
    expect(Date.parse(q.at)).toBeGreaterThan(0);
  }
  // An administrator has their own history and no way into anyone else's.
  expect((await call("/api/me/queries", admin)).data.queries).toEqual([]);
  expect((await call("/api/me/queries?limit=2", alice)).data.queries.length).toBe(2);
  expect((await call("/api/me/queries?limit=0", alice)).status).toBe(400);

  expect((await call("/api/me/queries", alice, "DELETE", {})).data).toEqual({ ok: true, removed: 4 });
  expect((await call("/api/me/queries", alice)).data.queries).toEqual([]);
});

test("through a member's key the source list carries no server paths", async () => {
  const { call, mcp, people, d } = await setup();
  const docs = tempDir();
  await Bun.write(`${docs}/a.md`, "# A\n\ntext\n");
  d.addSource({ library: "lib", version: "1", kind: "local", locator: docs });
  const { admin, alice } = await people();
  const memberKey = (await call("/api/me/keys", alice, "POST", { name: "laptop" })).data.token;
  const adminKey = (await call("/api/me/keys", admin, "POST", { name: "laptop" })).data.token;

  const seen = await mcp(memberKey, "tools/call", { name: "docs_sources", arguments: {} });
  expect(seen.text).toContain("lib@1");
  expect(seen.text).not.toContain(docs);
  expect((await mcp(adminKey, "tools/call", { name: "docs_sources", arguments: {} })).text).toContain(docs);
});

test("personal keys share one request limit per person", async () => {
  const { call, mcp, people } = await setup({ mcpClientRate: { limit: 2, windowMs: 60_000 } });
  const { admin, alice } = await people();
  const one = (await call("/api/me/keys", alice, "POST", { name: "one" })).data.token;
  const two = (await call("/api/me/keys", alice, "POST", { name: "two" })).data.token;
  const other = (await call("/api/me/keys", admin, "POST", { name: "one" })).data.token;
  expect((await mcp(one)).status).toBe(200);
  expect((await mcp(two)).status).toBe(200);
  // A second key is not a second allowance.
  expect((await mcp(one)).status).toBe(429);
  expect((await mcp(other)).status).toBe(200);
});

test("without accounts there are no personal keys or history", async () => {
  const d = newDocify(tempDir());
  const server = await startServer(0, { docify: d, quiet: true, token: "a".repeat(32), mcpClients: [] });
  cleanup.push(() => {
    server.stop(true);
    d.close();
  });
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { "x-docify-token": "a".repeat(32) };
  for (const path of ["/api/me/keys", "/api/me/queries"]) {
    const r = await fetch(base + path, { headers });
    expect([path, r.status, (await r.json()).code]).toEqual([path, 404, "accounts_off"]);
  }
  const rpc = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer dcf_${"x".repeat(43)}`, "content-type": "application/json" }, body: "{}" });
  expect(rpc.status).toBe(404);
});

// The access list: an administrator says who gets in, and GitHub is asked only for what the list needs.
test("an administrator edits the access list; bad entries are refused at their field", async () => {
  const { call, signIn } = await setup();
  const admin = (await signIn("code-boss")).cookie;
  expect((await call("/api/access", admin)).data).toEqual({ outsiders: "pending", rules: [], maxOrgs: 10, maxRules: 500 });

  const made = await call("/api/access/rules", admin, "POST", { kind: "org", value: "Acme" });
  expect(made.status).toBe(201);
  expect(made.data).toMatchObject({ kind: "org", value: "acme", createdBy: "boss", people: 0, bound: false });
  expect((await call("/api/access/rules", admin, "POST", { kind: "org", value: "acme" })).status).toBe(409);
  const bad = await call("/api/access/rules", admin, "POST", { kind: "email", value: "not an address" });
  expect([bad.status, bad.data.field]).toEqual([400, "value"]);
  expect((await call("/api/access/rules", admin, "POST", { kind: "team", value: "x" })).data.field).toBe("kind");

  expect((await call("/api/access", admin, "PUT", { outsiders: "refuse" })).data.outsiders).toBe("refuse");
  expect((await call("/api/access", admin, "PUT", { outsiders: "everyone" })).status).toBe(400);
  expect((await call("/api/access", admin)).data).toMatchObject({ outsiders: "refuse", rules: [{ kind: "org", value: "acme" }] });

  expect((await call("/api/access/rules/999", admin, "DELETE", {})).status).toBe(404);
  expect((await call("/api/access/rules/abc", admin, "DELETE", {})).status).toBe(404);
  expect((await call(`/api/access/rules/${made.data.id}`, admin, "DELETE", {})).data).toEqual({ ok: true, suspended: [] });
  expect((await call("/api/access", admin)).data.rules).toEqual([]);
});

test("sign-in asks GitHub only for what the access list needs, and the sign-in page is told", async () => {
  const { call, signIn } = await setup();
  const scope = async () => new URL((await call("/auth/github")).res.headers.get("location")!).searchParams.get("scope");
  expect(await scope()).toBeNull();
  const admin = (await signIn("code-boss")).cookie;
  // With an empty list nothing but the profile is read.
  expect(asked).toEqual(["/user"]);

  await call("/api/access/rules", admin, "POST", { kind: "login", value: "alice" });
  expect(await scope()).toBeNull();
  await call("/api/access/rules", admin, "POST", { kind: "org", value: "acme" });
  expect(await scope()).toBe("read:org");
  expect((await call("/api/session")).data.asks).toEqual({ orgs: true, emails: false });
  await call("/api/access/rules", admin, "POST", { kind: "email", value: "dave@example.com" });
  expect(await scope()).toBe("read:org user:email");
  expect((await call("/api/session")).data.asks).toEqual({ orgs: true, emails: true });
});

test("a member of a listed organization gets in at once; an invited one and a stranger wait", async () => {
  const { call, signIn } = await setup();
  const admin = (await signIn("code-boss")).cookie;
  await call("/api/access/rules", admin, "POST", { kind: "org", value: "acme" });

  const carol = (await signIn("code-carol")).cookie;
  expect((await call("/api/session", carol)).data.user).toMatchObject({ login: "carol", role: "member", status: "active" });
  expect((await call("/api/sources", carol)).status).toBe(200);
  const pat = (await signIn("code-pat")).cookie;
  expect((await call("/api/session", pat)).data.user.status).toBe("pending");
  const alice = (await signIn("code-alice")).cookie;
  expect((await call("/api/session", alice)).data.user.status).toBe("pending");

  const users = (await call("/api/users", admin)).data.users;
  expect(users.find((u: any) => u.login === "carol").rule).toEqual({ kind: "org", value: "acme" });
  expect(users.find((u: any) => u.login === "alice").rule).toBeNull();
  expect((await call("/api/access", admin)).data.rules[0].people).toBe(1);
  const lines = (await call("/api/logs", admin)).data.lines.map((l: any) => l.message ?? l.text ?? JSON.stringify(l)).join("\n");
  expect(lines).toContain("carol");
  expect(lines).toContain("acme");
});

test("a person who does not grant the scope is not let in by that entry, and GitHub is not asked", async () => {
  const { call, signIn } = await setup();
  const admin = (await signIn("code-boss")).cookie;
  await call("/api/access/rules", admin, "POST", { kind: "org", value: "acme" });
  asked.length = 0;
  const gina = (await signIn("code-gina")).cookie;
  expect((await call("/api/session", gina)).data.user.status).toBe("pending");
  expect(asked).toEqual(["/user"]);
  expect(JSON.stringify((await call("/api/logs", admin)).data.lines)).toContain("without granting read:org");
});

test("a verified email on the list lets its owner in; an unverified one does not, and no address is kept", async () => {
  const { call, signIn, server } = await setup();
  const admin = (await signIn("code-boss")).cookie;
  await call("/api/access/rules", admin, "POST", { kind: "email", value: "dave@example.com" });
  await call("/api/access/rules", admin, "POST", { kind: "email", value: "ceo@example.com" });
  const dave = (await signIn("code-dave")).cookie;
  expect((await call("/api/session", dave)).data.user.status).toBe("active");
  const users = (await call("/api/users", admin)).data.users;
  expect(users.find((u: any) => u.login === "dave").rule).toEqual({ kind: "email", value: "dave@example.com" });
  // The second address is on his GitHub account but not verified: it proves nothing.
  expect((await call("/api/access", admin)).data.rules.map((r: any) => [r.value, r.people])).toEqual([["dave@example.com", 1], ["ceo@example.com", 0]]);
  const erin = (await signIn("code-erin")).cookie;
  expect((await call("/api/session", erin)).data.user.status).toBe("pending");
  // What GitHub said about a person's addresses is used for the match and dropped.
  expect(JSON.stringify(users) + JSON.stringify(server.accounts!.listUsers())).not.toContain("elsewhere.test");
});

test("with outsiders refused a stranger gets no account and is told why", async () => {
  const { call, signIn } = await setup();
  const admin = (await signIn("code-boss")).cookie;
  await call("/api/access/rules", admin, "POST", { kind: "org", value: "acme" });
  await call("/api/access", admin, "PUT", { outsiders: "refuse" });
  const alice = await signIn("code-alice");
  expect([alice.location, alice.cookie]).toEqual(["/#signin=uninvited", ""]);
  expect((await call("/api/users", admin)).data.users.map((u: any) => u.login)).toEqual(["boss"]);
  expect((await signIn("code-carol")).location).toBe("/");
});

test("removing an entry signs out the people it let in and ends their keys", async () => {
  const { call, signIn, mcp } = await setup();
  const admin = (await signIn("code-boss")).cookie;
  const rule = (await call("/api/access/rules", admin, "POST", { kind: "org", value: "acme" })).data;
  const carol = (await signIn("code-carol")).cookie;
  const key = (await call("/api/me/keys", carol, "POST", { name: "laptop" })).data.token;
  expect((await mcp(key)).status).toBe(200);

  expect((await call(`/api/access/rules/${rule.id}`, admin, "DELETE", {})).data).toEqual({ ok: true, suspended: ["carol"] });
  expect((await call("/api/sources", carol)).status).toBe(401);
  expect((await mcp(key)).status).toBe(401);
  expect((await call("/api/users", admin)).data.users.find((u: any) => u.login === "carol").status).toBe("pending");
});

test("when GitHub will not say whether someone is a member, nobody loses access over it", async () => {
  const { call, signIn, server } = await setup();
  const admin = (await signIn("code-boss")).cookie;
  await call("/api/access/rules", admin, "POST", { kind: "org", value: "acme" });
  // Frank was let in while the organization still answered.
  PEOPLE["code-frank"]!.orgs = { acme: "active" };
  cleanup.push(() => (PEOPLE["code-frank"]!.orgs = { acme: 403 }));
  expect((await signIn("code-frank")).location).toBe("/");
  PEOPLE["code-frank"]!.orgs = { acme: 403 };
  const again = (await signIn("code-frank")).cookie;
  expect((await call("/api/session", again)).data.user.status).toBe("active");
  const lines = JSON.stringify((await call("/api/logs", admin)).data.lines);
  expect(lines).toContain("would not say");
  // A real "no" does end it.
  PEOPLE["code-frank"]!.orgs = {};
  const last = (await signIn("code-frank")).cookie;
  expect((await call("/api/session", last)).data.user.status).toBe("pending");
  expect(server.accounts!.listUsers().find((u) => u.login === "frank")!.rule_id).toBeNull();
});

test("without accounts there is no access list", async () => {
  const d = newDocify(tempDir());
  const server = await startServer(0, { docify: d, quiet: true, token: "a".repeat(32), mcpClients: [] });
  cleanup.push(() => {
    server.stop(true);
    d.close();
  });
  const r = await fetch(`http://127.0.0.1:${server.port}/api/access`, { headers: { "x-docify-token": "a".repeat(32) } });
  expect([r.status, (await r.json()).code]).toEqual([404, "accounts_off"]);
});

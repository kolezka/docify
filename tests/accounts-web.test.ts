import { afterEach, expect, test } from "bun:test";
import { parseAdmins } from "../src/core/accounts.ts";
import { accountsFromEnv, startServer } from "../src/web/server.ts";
import { newDocify, tempDir } from "./helpers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const PEOPLE: Record<string, { id: number; login: string; name: string | null }> = {
  "code-boss": { id: 1, login: "boss", name: "The Boss" },
  "code-alice": { id: 101, login: "alice", name: null },
};

// Stands in for GitHub: a code is the access token of the person it belongs to.
const fakeGitHub = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("access_token")) {
    const { code, client_secret } = JSON.parse(String(init?.body));
    if (client_secret !== "s3cret-for-tests") return Response.json({ error: "incorrect_client_credentials" });
    return Response.json(PEOPLE[code] ? { access_token: code } : { error: "bad_verification_code" });
  }
  const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
  return PEOPLE[token] ? Response.json(PEOPLE[token]) : new Response("{}", { status: 401 });
}) as typeof fetch;

async function setup(opts: { publicUrl?: string; admins?: string } = {}) {
  const d = newDocify(tempDir());
  const server = await startServer(0, {
    docify: d,
    quiet: true,
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
  const cookiePair = (res: Response, name: string) =>
    res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(";")[0] ?? "";
  // Walks the sign-in the way a browser does and returns the session cookie, or the page it landed on.
  const signIn = async (code: string) => {
    const start = await call("/auth/github");
    const state = new URL(start.res.headers.get("location")!).searchParams.get("state")!;
    const back = await call(`/auth/github/callback?code=${code}&state=${state}`, cookiePair(start.res, "docify_oauth_state"));
    return { cookie: cookiePair(back.res, "docify_session"), location: back.res.headers.get("location"), res: back.res };
  };
  return { base, call, signIn, cookiePair, server, d };
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
  expect((await call("/api/session")).data).toEqual({ accounts: true, user: null });
  const { cookie, location, res } = await signIn("code-boss");
  expect(location).toBe("/");
  expect(cookie).toMatch(/^docify_session=[A-Za-z0-9_-]{43}$/);
  const set = res.headers.getSetCookie().find((c) => c.startsWith("docify_session="))!;
  expect(set).toContain("HttpOnly");
  expect(set).toContain("SameSite=Lax");
  expect(set).not.toContain("Secure");
  expect((await call("/api/session", cookie)).data).toEqual({ accounts: true, user: { id: 1, login: "boss", name: "The Boss", role: "admin", status: "active" } });
  expect((await call("/api/sources", cookie)).status).toBe(200);
  expect((await call("/api/config", cookie)).status).toBe(200);
});

test("with a public https address the cookies are Secure", async () => {
  const { signIn } = await setup({ publicUrl: "https://docs.example.com" });
  const { res } = await signIn("code-boss");
  expect(res.headers.getSetCookie().find((c) => c.startsWith("docify_session="))).toContain("; Secure");
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

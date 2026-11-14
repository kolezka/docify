import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNTS_FILE, AccountStore, SESSION_TTL_MS, parseAdmins } from "../src/core/accounts.ts";
import { exportStore, importStore } from "../src/core/backup.ts";
import { newDocify, tempDir } from "./helpers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function open(admins = "boss", now?: () => number, home = tempDir()) {
  const store = new AccountStore(home, parseAdmins(admins), now);
  cleanup.push(() => store.close());
  return { store, home };
}

const alice = { id: 101, login: "alice", name: "Alice" };
const boss = { id: 1, login: "Boss", name: null };

test("DOCIFY_ADMINS takes logins and ids, and refuses anything else", () => {
  const admins = parseAdmins("Alice, bob\nid:42");
  expect([...admins.logins]).toEqual(["alice", "bob"]);
  expect([...admins.ids]).toEqual([42]);
  expect(parseAdmins(undefined).logins.size).toBe(0);
  expect(() => parseAdmins("not a login!")).toThrow("DOCIFY_ADMINS");
  expect(() => parseAdmins("id:abc")).toThrow("DOCIFY_ADMINS");
});

test("a new sign-up waits as a pending member; a named administrator is active at once", () => {
  const { store } = open();
  const first = store.signIn(alice);
  expect(first.created).toBe(true);
  expect(first.user).toMatchObject({ login: "alice", role: "member", status: "pending", approved_at: null });
  // Arriving first gives nothing: only DOCIFY_ADMINS makes an administrator.
  expect(store.listUsers().filter((u) => u.role === "admin")).toEqual([]);

  const admin = store.signIn(boss);
  expect(admin.user).toMatchObject({ login: "Boss", role: "admin", status: "active" });
  expect(admin.user.approved_at).not.toBeNull();
  expect(store.signIn(alice).created).toBe(false);
  expect(store.listUsers().length).toBe(2);
});

test("an administrator can be named by GitHub id, which survives a rename", () => {
  const { store } = open("id:7");
  expect(store.signIn({ id: 7, login: "old-name", name: null }).user.role).toBe("admin");
  expect(store.signIn({ id: 7, login: "new-name", name: null }).user).toMatchObject({ login: "new-name", role: "admin" });
  // Someone else taking the old login gets nothing.
  expect(store.signIn({ id: 8, login: "old-name", name: null }).user).toMatchObject({ role: "member", status: "pending" });
});

test("the session token is stored only as a hash and stops working when it expires", () => {
  let now = Date.parse("2026-11-14T12:00:00Z");
  const { store, home } = open("boss", () => now);
  const { session } = store.signIn(boss);
  expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(store.userForSession(session)?.login).toBe("Boss");
  expect(store.userForSession("x".repeat(43))).toBeNull();
  expect(store.userForSession(null)).toBeNull();

  const raw = new Database(join(home, ACCOUNTS_FILE), { readonly: true });
  const rows = raw.query<{ token_hash: string }, []>("SELECT token_hash FROM sessions").all();
  raw.close();
  expect(rows.length).toBe(1);
  expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(rows[0]!.token_hash).not.toContain(session!);

  now += SESSION_TTL_MS + 1;
  expect(store.userForSession(session)).toBeNull();
});

test("signing out ends that session only", () => {
  const { store } = open();
  const a = store.signIn(boss).session;
  const b = store.signIn(boss).session;
  store.signOut(a);
  expect(store.userForSession(a)).toBeNull();
  expect(store.userForSession(b)?.login).toBe("Boss");
});

test("approval, roles and disabling; disabling ends the person's sessions", () => {
  const { store } = open();
  const admin = store.signIn(boss).user;
  const { user, session } = store.signIn(alice);
  expect(store.updateUser(user.id, { status: "active" }, admin.id)).toMatchObject({ status: "active", role: "member" });
  expect(store.getUser(user.id)!.approved_at).not.toBeNull();
  expect(store.updateUser(user.id, { role: "admin" }, admin.id).role).toBe("admin");
  expect(store.updateUser(user.id, { role: "member" }, admin.id).role).toBe("member");

  expect(store.updateUser(user.id, { status: "disabled" }, admin.id).status).toBe("disabled");
  expect(store.userForSession(session)).toBeNull();
  // A disabled account can still be recognised at sign-in but gets no session.
  expect(store.signIn(alice)).toMatchObject({ session: null, created: false });
});

test("an administrator cannot change their own account, and a named one cannot be demoted, disabled or removed", () => {
  const { store } = open();
  const admin = store.signIn(boss).user;
  const other = store.signIn(alice).user;
  store.updateUser(other.id, { status: "active", role: "admin" }, admin.id);

  expect(() => store.updateUser(admin.id, { role: "member" }, admin.id)).toThrow("your own account");
  expect(() => store.removeUser(admin.id, admin.id)).toThrow("your own account");
  // Another administrator cannot lock the named one out either.
  expect(() => store.updateUser(admin.id, { role: "member" }, other.id)).toThrow("DOCIFY_ADMINS");
  expect(() => store.updateUser(admin.id, { status: "disabled" }, other.id)).toThrow("DOCIFY_ADMINS");
  expect(() => store.removeUser(admin.id, other.id)).toThrow("DOCIFY_ADMINS");
  expect(store.getUser(admin.id)).toMatchObject({ role: "admin", status: "active" });
});

test("bad input and unknown users are refused", () => {
  const { store } = open();
  const admin = store.signIn(boss).user;
  const user = store.signIn(alice).user;
  expect(() => store.updateUser(user.id, {}, admin.id)).toThrow("role or status");
  expect(() => store.updateUser(user.id, { role: "owner" as never }, admin.id)).toThrow("role must be");
  expect(() => store.updateUser(user.id, { status: "pending" as never }, admin.id)).toThrow("status must be");
  expect(() => store.updateUser(9999, { status: "active" }, admin.id)).toThrow("unknown user");
  expect(() => store.removeUser(9999, admin.id)).toThrow("unknown user");
});

test("a removed person can sign up again and waits for approval again", () => {
  const { store } = open();
  const admin = store.signIn(boss).user;
  const { user, session } = store.signIn(alice);
  store.updateUser(user.id, { status: "active" }, admin.id);
  expect(store.removeUser(user.id, admin.id).login).toBe("alice");
  expect(store.userForSession(session)).toBeNull();
  expect(store.signIn(alice)).toMatchObject({ created: true, user: { status: "pending", role: "member" } });
});

test("a named administrator who was disabled before being named is restored at sign-in", () => {
  const home = tempDir();
  const before = new AccountStore(home, parseAdmins("boss"));
  const admin = before.signIn(boss).user;
  const user = before.signIn(alice).user;
  before.updateUser(user.id, { status: "disabled" }, admin.id);
  before.close();

  const { store } = open("boss, alice", undefined, home);
  expect(store.signIn(alice)).toMatchObject({ user: { role: "admin", status: "active" } });
  expect(store.signIn(alice).session).not.toBeNull();
});

// The reason accounts have their own file: a backup must not carry the user list, and
// importing one must not replace the people who can sign in here.
test("store backups hold no accounts, and an import leaves accounts in place", async () => {
  const home = tempDir();
  const d = newDocify(home);
  cleanup.push(() => d.close());
  const { store } = open("boss", undefined, home);
  const { session } = store.signIn(boss);

  const { bytes } = await exportStore(d);
  const names = [...(await new Bun.Archive(bytes).files()).keys()];
  expect(names.length).toBeGreaterThan(1);
  expect(names.filter((name) => name.includes("accounts"))).toEqual([]);

  await importStore(d, bytes, { force: true, keepConfig: false });
  expect(store.userForSession(session)?.login).toBe("Boss");
  expect(store.listUsers().length).toBe(1);
});

// A GitHub login can be renamed away and registered again by someone else, so a login in
// DOCIFY_ADMINS is tied to the first GitHub id that signs in with it.
test("a login named in DOCIFY_ADMINS belongs to the first GitHub account that used it", () => {
  const { store } = open("boss");
  const pending = store.signIn({ id: 2, login: "alice", name: null }).user;
  expect(store.signIn({ id: 1, login: "boss", name: null })).toMatchObject({ user: { role: "admin", status: "active" }, loginTaken: false });

  // Someone else now holds the login: a new account, and an existing one that was renamed.
  expect(store.signIn({ id: 999, login: "boss", name: null })).toMatchObject({ user: { role: "member", status: "pending" }, created: true, loginTaken: true });
  expect(store.signIn({ id: 2, login: "BOSS", name: null })).toMatchObject({ user: { id: pending.id, role: "member", status: "pending" }, loginTaken: true });
  // The real administrator keeps the role under a new login.
  expect(store.signIn({ id: 1, login: "big-boss", name: null }).user).toMatchObject({ role: "admin", status: "active" });
  expect(store.listUsers().filter((u) => store.isNamedAdmin(u)).map((u) => u.github_id)).toEqual([1]);
});

test("a login taken out of DOCIFY_ADMINS loses the role and its sessions at the next start", () => {
  const home = tempDir();
  const before = new AccountStore(home, parseAdmins("boss, carol"));
  const admin = before.signIn(boss).user;
  const carol = before.signIn({ id: 3, login: "carol", name: null });
  expect(carol.user.role).toBe("admin");
  // Made an administrator in the panel, not by the variable: that one stays.
  const panel = before.signIn(alice).user;
  before.updateUser(panel.id, { status: "active", role: "admin" }, admin.id);
  expect(before.demoted).toEqual([]);
  before.close();

  const { store } = open("boss", undefined, home);
  expect(store.demoted).toEqual(["carol"]);
  expect(store.getUser(carol.user.id)).toMatchObject({ role: "member", status: "active" });
  expect(store.userForSession(carol.session)).toBeNull();
  expect(store.getUser(panel.id)!.role).toBe("admin");
  expect(store.getUser(admin.id)!.role).toBe("admin");
  expect(store.signIn({ id: 3, login: "carol", name: null }).user.role).toBe("member");
});

test("a sign-in ends the session the browser already had, and a person keeps at most ten", () => {
  const { store, home } = open();
  const first = store.signIn(boss).session;
  const second = store.signIn(boss, first).session;
  expect(store.userForSession(first)).toBeNull();
  expect(store.userForSession(second)?.login).toBe("Boss");
  for (let i = 0; i < 12; i++) store.signIn(boss);
  expect(store.userForSession(second)).toBeNull();
  const raw = new Database(join(home, ACCOUNTS_FILE), { readonly: true });
  expect(raw.query<{ n: number }, []>("SELECT count(*) AS n FROM sessions").get()!.n).toBe(10);
  raw.close();
});

test("the accounts file is readable by its owner only", () => {
  const { store, home } = open();
  store.signIn(boss);
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = join(home, ACCOUNTS_FILE + suffix);
    if (existsSync(file)) expect([suffix, statSync(file).mode & 0o777]).toEqual([suffix, 0o600]);
  }
  expect(statSync(join(home, ACCOUNTS_FILE)).mode & 0o777).toBe(0o600);
});

test("an accounts file from before the named-admin fix still opens", () => {
  const home = tempDir();
  // The users table as the first build created it: no by_env column, no named_logins table.
  const old = new Database(join(home, ACCOUNTS_FILE), { create: true });
  old.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  old.run("INSERT INTO meta (key, value) VALUES ('schema_version', '1')");
  old.run(
    "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, github_id INTEGER NOT NULL UNIQUE, login TEXT NOT NULL, name TEXT, role TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, approved_at TEXT, last_login_at TEXT)",
  );
  old.run("INSERT INTO users (github_id, login, role, status, created_at) VALUES (101, 'alice', 'member', 'active', '2026-11-14T00:00:00.000Z')");
  old.close();

  const { store } = open("boss", undefined, home);
  expect(store.listUsers().map((u) => u.login)).toEqual(["alice"]);
  expect(store.signIn(boss).user.role).toBe("admin");
  expect(store.signIn(alice).user.status).toBe("active");
});

// Personal MCP keys and the query history, added for use inside a company.
test("a person creates an MCP key; the file keeps only its hash and the key finds its owner", () => {
  const { store, home } = open();
  const user = store.signIn(boss).user;
  const { key, token } = store.createKey(user.id, "  laptop\u0007 ");
  expect(token).toMatch(/^dcf_[A-Za-z0-9_-]{43}$/);
  expect(key).toMatchObject({ name: "laptop", prefix: token.slice(0, 8), last_used_at: null });
  expect(store.listKeys(user.id).map((k) => k.name)).toEqual(["laptop"]);
  expect(JSON.stringify(store.listKeys(user.id))).not.toContain(token.slice(8));

  const found = store.userForKey(token);
  expect([found?.user.login, found?.key.name]).toEqual(["Boss", "laptop"]);
  expect(store.listKeys(user.id)[0]!.last_used_at).not.toBeNull();
  expect(store.userForKey(token.slice(0, -1) + "x")).toBeNull();
  expect(store.userForKey("x".repeat(47))).toBeNull();

  const raw = new Database(join(home, ACCOUNTS_FILE), { readonly: true });
  const dump = JSON.stringify(raw.query("SELECT * FROM mcp_keys").all());
  raw.close();
  expect(dump).not.toContain(token);
  expect(dump).not.toContain(token.slice(8));
});

test("a key needs a name, names are unique per person, and ten keys is the limit", () => {
  const { store } = open();
  const a = store.signIn(boss).user;
  const b = store.signIn({ id: 7, login: "other", name: null }).user;
  store.updateUser(b.id, { status: "active" }, a.id);
  expect(() => store.createKey(a.id, "")).toThrow("name");
  expect(() => store.createKey(a.id, 5)).toThrow("name");
  expect(() => store.createKey(a.id, "x".repeat(61))).toThrow("60");
  store.createKey(a.id, "laptop");
  expect(() => store.createKey(a.id, "Laptop")).toThrow("already");
  // Another person may use the same name.
  expect(store.createKey(b.id, "laptop").key.name).toBe("laptop");
  for (let i = 2; i <= 10; i++) store.createKey(a.id, `key ${i}`);
  expect(() => store.createKey(a.id, "one too many")).toThrow("10");
  expect(store.listKeys(a.id).length).toBe(10);
});

test("a key ends when it is revoked or its owner is disabled or removed; a waiting account gets none", () => {
  const { store } = open();
  const admin = store.signIn(boss).user;
  const member = store.signIn(alice).user;
  expect(() => store.createKey(member.id, "early")).toThrow("approved");
  store.updateUser(member.id, { status: "active" }, admin.id);

  const first = store.createKey(member.id, "first");
  const second = store.createKey(member.id, "second");
  // Only the owner can revoke a key.
  expect(() => store.revokeKey(admin.id, first.key.id)).toThrow("unknown key");
  store.revokeKey(member.id, first.key.id);
  expect(store.userForKey(first.token)).toBeNull();
  expect(store.userForKey(second.token)?.user.login).toBe("alice");

  store.updateUser(member.id, { status: "disabled" }, admin.id);
  expect(store.userForKey(second.token)).toBeNull();
  // Enabling the account again does not bring old keys back.
  store.updateUser(member.id, { status: "active" }, admin.id);
  expect(store.userForKey(second.token)).toBeNull();
  expect(store.listKeys(member.id)).toEqual([]);

  const third = store.createKey(member.id, "third");
  store.removeUser(member.id, admin.id);
  expect(store.userForKey(third.token)).toBeNull();
});

test("queries are kept per person, newest first, and the oldest fall off", () => {
  let now = Date.parse("2026-11-14T12:00:00Z");
  const { store } = open("boss", () => now);
  const a = store.signIn(boss).user;
  const b = store.signIn({ id: 7, login: "other", name: null }).user;
  store.recordQuery(a.id, { via: "web", query: "first", status: "ok", hits: 3, scope: "bun@1.4.3" });
  now += 1000;
  store.recordQuery(a.id, { via: "mcp", keyName: "laptop", query: "q".repeat(600), status: "no_match", hits: 0 });
  store.recordQuery(b.id, { via: "web", query: "private", status: "ok", hits: 1 });

  const mine = store.listQueries(a.id);
  expect(mine.map((q) => [q.via, q.key_name, q.status, q.hits, q.scope])).toEqual([["mcp", "laptop", "no_match", 0, null], ["web", null, "ok", 3, "bun@1.4.3"]]);
  expect(mine[0]!.query.length).toBe(500);
  expect(mine[1]).toMatchObject({ query: "first", at: "2026-11-14T12:00:00.000Z" });
  expect(store.listQueries(b.id).map((q) => q.query)).toEqual(["private"]);

  for (let i = 0; i < 205; i++) store.recordQuery(a.id, { via: "web", query: `q${i}`, status: "ok", hits: 1 });
  const all = store.listQueries(a.id, 1000);
  expect(all.length).toBe(200);
  expect(all[0]!.query).toBe("q204");
  expect(store.listQueries(a.id).length).toBe(50);

  expect(store.clearQueries(a.id)).toBe(200);
  expect(store.listQueries(a.id)).toEqual([]);
  expect(store.listQueries(b.id).length).toBe(1);
  // History goes with the account.
  store.removeUser(b.id, a.id);
  const again = store.signIn({ id: 7, login: "other", name: null }).user;
  expect(store.listQueries(again.id)).toEqual([]);
});

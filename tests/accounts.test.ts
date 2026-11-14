import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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

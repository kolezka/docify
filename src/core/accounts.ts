import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DocifyError } from "./docify.ts";

// Accounts and sessions have their own file. A store backup copies docify.sqlite whole and an
// import replaces it, so users kept there would leak into backups and vanish on import.
export const ACCOUNTS_FILE = "accounts.sqlite";
export const ACCOUNTS_SCHEMA_VERSION = 1;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_SESSIONS_PER_USER = 10;
// A personal MCP key starts with this, so a pasted key is recognisable and a secret scanner can find it.
export const MCP_KEY_PREFIX = "dcf_";
export const MAX_KEYS_PER_USER = 10;
export const MAX_QUERIES_PER_USER = 200;
const QUERY_MAX_CHARS = 500;
const KEY_NAME_MAX_CHARS = 60;
// last_used_at is for people, not for audit: one write a minute per key is enough.
const KEY_USE_STEP_MS = 60_000;

export type Role = "admin" | "member";
export type UserStatus = "pending" | "active" | "disabled";

export interface UserRow {
  id: number;
  github_id: number;
  login: string;
  name: string | null;
  role: Role;
  status: UserStatus;
  created_at: string;
  approved_at: string | null;
  last_login_at: string | null;
}

// A key as its owner sees it. The key itself is shown once, when it is made.
export interface KeyRow {
  id: number;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
}

export interface QueryRow {
  id: number;
  at: string;
  via: "web" | "mcp";
  key_name: string | null;
  query: string;
  scope: string | null;
  status: string;
  hits: number;
}

export interface QueryRecord {
  via: "web" | "mcp";
  keyName?: string | null;
  query: string;
  scope?: string | null;
  status: string;
  hits: number;
}

export interface GitHubIdentity {
  id: number;
  login: string;
  name: string | null;
}

export interface AdminList {
  logins: Set<string>;
  ids: Set<number>;
}

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

// "alice, bob, id:583231". A login is easy to type, but GitHub frees it on a rename, so the
// store ties each named login to the first GitHub id that signs in with it (named_logins).
export function parseAdmins(value: string | undefined, name = "DOCIFY_ADMINS"): AdminList {
  const admins: AdminList = { logins: new Set(), ids: new Set() };
  for (const entry of (value ?? "").split(/[\s,]+/).filter(Boolean)) {
    const id = /^id:(\d{1,15})$/.exec(entry);
    if (id) admins.ids.add(Number(id[1]));
    else if (LOGIN_RE.test(entry)) admins.logins.add(entry.toLowerCase());
    else throw new Error(`${name}: expected GitHub logins or id:<number>, separated by commas`);
  }
  return admins;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  created_at TEXT NOT NULL,
  approved_at TEXT,
  last_login_at TEXT,
  -- 1 while the admin role comes from DOCIFY_ADMINS, so leaving the variable takes it away.
  by_env INTEGER NOT NULL DEFAULT 0
);
-- Which GitHub account a login in DOCIFY_ADMINS means: the first one that signed in with it.
CREATE TABLE IF NOT EXISTS named_logins (login TEXT PRIMARY KEY, github_id INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
-- Personal MCP keys. Like sessions, only the hash is kept.
CREATE TABLE IF NOT EXISTS mcp_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS mcp_keys_user ON mcp_keys(user_id);
-- What each person searched for, for that person only. Here and not in docify.sqlite: queries never write to the store.
CREATE TABLE IF NOT EXISTS queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('web', 'mcp')),
  key_name TEXT,
  query TEXT NOT NULL,
  scope TEXT,
  status TEXT NOT NULL,
  hits INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS queries_user ON queries(user_id, id);
`;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export interface UserPatch {
  role?: Role;
  status?: "active" | "disabled";
}

const USER_COLUMNS = "id, github_id, login, name, role, status, created_at, approved_at, last_login_at";
const KEY_COLUMNS = "id, name, prefix, created_at, last_used_at";

export class AccountStore {
  private db: Database;
  // Logins that lost the administrator role at this start because DOCIFY_ADMINS no longer names them.
  readonly demoted: string[] = [];

  constructor(
    home: string,
    readonly admins: AdminList,
    private now: () => number = Date.now,
  ) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const file = join(home, ACCOUNTS_FILE);
    this.db = new Database(file, { create: true });
    // Owner only, like logs.sqlite: the file names everyone who can sign in.
    chmodSync(file, 0o600);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 10000");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(SCHEMA);
    this.db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)", [String(ACCOUNTS_SCHEMA_VERSION)]);
    const row = this.db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (row?.value !== String(ACCOUNTS_SCHEMA_VERSION)) {
      this.db.close();
      throw new Error(`Docify accounts schema ${row?.value} does not match this build (${ACCOUNTS_SCHEMA_VERSION}). Run a newer Docify or move ${join(home, ACCOUNTS_FILE)} aside.`);
    }
    // A file made before by_env existed keeps its old users table; CREATE TABLE IF NOT EXISTS skips it.
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(users)").all();
    if (!columns.some((column) => column.name === "by_env")) this.db.run("ALTER TABLE users ADD COLUMN by_env INTEGER NOT NULL DEFAULT 0");
    for (const suffix of ["-wal", "-shm"]) if (existsSync(file + suffix)) chmodSync(file + suffix, 0o600);
    this.db.run("DELETE FROM sessions WHERE expires_at <= ?", [this.iso()]);
    this.reconcile();
  }

  // DOCIFY_ADMINS is read at start. A login that left it no longer means anyone, and whoever
  // was an administrator only because of it becomes a member and is signed out.
  private reconcile() {
    this.db.transaction(() => {
      for (const { login } of this.db.query<{ login: string }, []>("SELECT login FROM named_logins").all()) {
        if (!this.admins.logins.has(login)) this.db.run("DELETE FROM named_logins WHERE login = ?", [login]);
      }
      for (const user of this.db.query<UserRow, []>(`SELECT ${USER_COLUMNS} FROM users WHERE by_env = 1`).all()) {
        if (this.isNamedAdmin(user)) continue;
        this.db.run("UPDATE users SET role = 'member', by_env = 0 WHERE id = ?", [user.id]);
        this.db.run("DELETE FROM sessions WHERE user_id = ?", [user.id]);
        this.demoted.push(user.login);
      }
    })();
  }

  close() {
    this.db.close();
  }

  private iso(offsetMs = 0): string {
    return new Date(this.now() + offsetMs).toISOString();
  }

  // Named in DOCIFY_ADMINS, by id or by a login tied to this GitHub id: always an active admin,
  // and the panel cannot change that. The current login alone proves nothing.
  isNamedAdmin(user: Pick<UserRow, "github_id">): boolean {
    if (this.admins.ids.has(user.github_id)) return true;
    return this.db
      .query<{ login: string }, [number]>("SELECT login FROM named_logins WHERE github_id = ?")
      .all(user.github_id)
      .some((row) => this.admins.logins.has(row.login));
  }

  getUser(id: number): UserRow | null {
    return this.db.query<UserRow, [number]>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id);
  }

  listUsers(): UserRow[] {
    return this.db.query<UserRow, []>(`SELECT ${USER_COLUMNS} FROM users ORDER BY status = 'pending' DESC, login COLLATE NOCASE`).all();
  }

  // First sign-in creates the account. It waits as pending unless DOCIFY_ADMINS names it.
  // A disabled account gets no session. `previous` is the session the browser already had; it ends.
  // `loginTaken` reports a named login that already belongs to another GitHub account.
  signIn(profile: GitHubIdentity, previous?: string | null): { user: UserRow; session: string | null; created: boolean; loginTaken: boolean } {
    const now = this.iso();
    const login = profile.login.toLowerCase();
    return this.db.transaction(() => {
      let loginTaken = false;
      if (this.admins.logins.has(login)) {
        const bound = this.db.query<{ github_id: number }, [string]>("SELECT github_id FROM named_logins WHERE login = ?").get(login);
        if (!bound) this.db.run("INSERT INTO named_logins (login, github_id) VALUES (?, ?)", [login, profile.id]);
        else loginTaken = bound.github_id !== profile.id;
      }
      const named = this.isNamedAdmin({ github_id: profile.id });
      const byGitHub = () => this.db.query<UserRow, [number]>(`SELECT ${USER_COLUMNS} FROM users WHERE github_id = ?`).get(profile.id);
      const created = !byGitHub();
      if (created) {
        this.db.run(
          "INSERT INTO users (github_id, login, name, role, status, created_at, approved_at, last_login_at, by_env) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [profile.id, profile.login, profile.name, named ? "admin" : "member", named ? "active" : "pending", now, named ? now : null, now, named ? 1 : 0],
        );
      } else {
        this.db.run("UPDATE users SET login = ?, name = ?, last_login_at = ? WHERE github_id = ?", [profile.login, profile.name, now, profile.id]);
        if (named) this.db.run("UPDATE users SET role = 'admin', status = 'active', by_env = 1, approved_at = COALESCE(approved_at, ?) WHERE github_id = ?", [now, profile.id]);
      }
      this.db.run("DELETE FROM sessions WHERE expires_at <= ?", [now]);
      if (previous) this.db.run("DELETE FROM sessions WHERE token_hash = ?", [hashToken(previous)]);
      const user = byGitHub()!;
      if (user.status === "disabled") return { user, session: null, created, loginTaken };
      const session = randomBytes(32).toString("base64url");
      // Only the hash is stored, so a copy of this file holds no usable session.
      this.db.run("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [hashToken(session), user.id, now, this.iso(SESSION_TTL_MS)]);
      // Sign-ins cannot pile sessions up without limit; the oldest go first.
      this.db.run("DELETE FROM sessions WHERE user_id = ? AND rowid NOT IN (SELECT rowid FROM sessions WHERE user_id = ? ORDER BY rowid DESC LIMIT ?)", [user.id, user.id, MAX_SESSIONS_PER_USER]);
      return { user, session, created, loginTaken };
    })();
  }

  userForSession(session: string | null | undefined): UserRow | null {
    if (!session) return null;
    return this.db
      .query<UserRow, [string, string]>(`SELECT ${USER_COLUMNS.replace(/(\w+)/g, "u.$1")} FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`)
      .get(hashToken(session), this.iso());
  }

  signOut(session: string | null | undefined) {
    if (session) this.db.run("DELETE FROM sessions WHERE token_hash = ?", [hashToken(session)]);
  }

  private editable(id: number, actorId: number | null): UserRow {
    const user = this.getUser(id);
    if (!user) throw new DocifyError("user_unknown", "unknown user");
    if (actorId === id) throw new DocifyError("conflict", "you cannot change your own account");
    return user;
  }

  updateUser(id: number, patch: UserPatch, actorId: number | null): UserRow {
    if (patch.role === undefined && patch.status === undefined) throw new DocifyError("invalid_input", "role or status is required");
    if (patch.role !== undefined && patch.role !== "admin" && patch.role !== "member") throw new DocifyError("invalid_input", "role must be admin or member");
    if (patch.status !== undefined && patch.status !== "active" && patch.status !== "disabled") throw new DocifyError("invalid_input", "status must be active or disabled");
    return this.db.transaction(() => {
      const user = this.editable(id, actorId);
      if (this.isNamedAdmin(user) && (patch.role === "member" || patch.status === "disabled")) {
        throw new DocifyError("conflict", `${user.login} is named in DOCIFY_ADMINS; change that variable first`);
      }
      if (patch.role !== undefined) this.db.run("UPDATE users SET role = ?, by_env = 0 WHERE id = ?", [patch.role, id]);
      if (patch.status === "active") this.db.run("UPDATE users SET status = 'active', approved_at = COALESCE(approved_at, ?) WHERE id = ?", [this.iso(), id]);
      if (patch.status === "disabled") {
        this.db.run("UPDATE users SET status = 'disabled' WHERE id = ?", [id]);
        this.db.run("DELETE FROM sessions WHERE user_id = ?", [id]);
        // Keys go too, so enabling the account later does not bring back a key nobody remembers.
        this.db.run("DELETE FROM mcp_keys WHERE user_id = ?", [id]);
      }
      return this.getUser(id)!;
    })();
  }

  // The person can sign up again afterwards and waits for approval like anyone new.
  removeUser(id: number, actorId: number | null): UserRow {
    return this.db.transaction(() => {
      const user = this.editable(id, actorId);
      if (this.isNamedAdmin(user)) throw new DocifyError("conflict", `${user.login} is named in DOCIFY_ADMINS; change that variable first`);
      this.db.run("DELETE FROM users WHERE id = ?", [id]);
      return user;
    })();
  }

  listKeys(userId: number): KeyRow[] {
    return this.db.query<KeyRow, [number]>(`SELECT ${KEY_COLUMNS} FROM mcp_keys WHERE user_id = ? ORDER BY id DESC`).all(userId);
  }

  // The key is returned once and never again: the file keeps its hash and its first characters.
  createKey(userId: number, name: unknown): { key: KeyRow; token: string } {
    const label = typeof name === "string" ? name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim() : "";
    if (!label) throw new DocifyError("invalid_input", "a key needs a name, such as the computer it is for");
    if (label.length > KEY_NAME_MAX_CHARS) throw new DocifyError("invalid_input", `a key name has at most ${KEY_NAME_MAX_CHARS} characters`);
    return this.db.transaction(() => {
      if (this.getUser(userId)?.status !== "active") throw new DocifyError("conflict", "only an approved account can have keys");
      const keys = this.listKeys(userId);
      if (keys.some((k) => k.name.toLowerCase() === label.toLowerCase())) throw new DocifyError("exists", `you already have a key named ${label}`);
      if (keys.length >= MAX_KEYS_PER_USER) throw new DocifyError("conflict", `you can have at most ${MAX_KEYS_PER_USER} keys; revoke one first`);
      const token = MCP_KEY_PREFIX + randomBytes(32).toString("base64url");
      const { lastInsertRowid } = this.db.run("INSERT INTO mcp_keys (user_id, name, prefix, token_hash, created_at) VALUES (?, ?, ?, ?, ?)", [
        userId,
        label,
        token.slice(0, MCP_KEY_PREFIX.length + 4),
        hashToken(token),
        this.iso(),
      ]);
      const key = this.db.query<KeyRow, [number]>(`SELECT ${KEY_COLUMNS} FROM mcp_keys WHERE id = ?`).get(Number(lastInsertRowid))!;
      return { key, token };
    })();
  }

  // Only the owner: an unknown id and someone else's key read the same.
  revokeKey(userId: number, keyId: number): KeyRow {
    return this.db.transaction(() => {
      const key = this.db.query<KeyRow, [number, number]>(`SELECT ${KEY_COLUMNS} FROM mcp_keys WHERE id = ? AND user_id = ?`).get(keyId, userId);
      if (!key) throw new DocifyError("key_unknown", "unknown key");
      this.db.run("DELETE FROM mcp_keys WHERE id = ?", [keyId]);
      return key;
    })();
  }

  // Who a bearer token belongs to. The lookup is by hash, so nothing here compares secrets byte by byte.
  userForKey(token: string | null | undefined): { user: UserRow; key: KeyRow } | null {
    if (!token?.startsWith(MCP_KEY_PREFIX)) return null;
    const key = this.db
      .query<KeyRow & { user_id: number }, [string]>(`SELECT ${KEY_COLUMNS}, user_id FROM mcp_keys WHERE token_hash = ?`)
      .get(hashToken(token));
    if (!key) return null;
    const user = this.getUser(key.user_id);
    if (user?.status !== "active") return null;
    const now = this.iso();
    this.db.run("UPDATE mcp_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)", [now, key.id, this.iso(-KEY_USE_STEP_MS)]);
    const { user_id: _owner, ...row } = key;
    return { user, key: { ...row, last_used_at: row.last_used_at ?? now } };
  }

  // The words of a search, not its results. Each person keeps the newest MAX_QUERIES_PER_USER.
  recordQuery(userId: number, record: QueryRecord) {
    this.db.transaction(() => {
      this.db.run("INSERT INTO queries (user_id, at, via, key_name, query, scope, status, hits) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
        userId,
        this.iso(),
        record.via,
        record.keyName ?? null,
        record.query.slice(0, QUERY_MAX_CHARS),
        record.scope?.slice(0, QUERY_MAX_CHARS) || null,
        record.status,
        record.hits,
      ]);
      this.db.run("DELETE FROM queries WHERE user_id = ? AND id NOT IN (SELECT id FROM queries WHERE user_id = ? ORDER BY id DESC LIMIT ?)", [userId, userId, MAX_QUERIES_PER_USER]);
    })();
  }

  listQueries(userId: number, limit = 50): QueryRow[] {
    const count = Math.min(Math.max(Math.trunc(limit) || 1, 1), MAX_QUERIES_PER_USER);
    return this.db
      .query<QueryRow, [number, number]>("SELECT id, at, via, key_name, query, scope, status, hits FROM queries WHERE user_id = ? ORDER BY id DESC LIMIT ?")
      .all(userId, count);
  }

  clearQueries(userId: number): number {
    return this.db.run("DELETE FROM queries WHERE user_id = ?", [userId]).changes;
  }
}

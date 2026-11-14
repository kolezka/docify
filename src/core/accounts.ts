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
// Each organization on the access list costs one GitHub request per sign-in.
export const MAX_ORG_RULES = 10;
export const MAX_ACCESS_RULES = 500;
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
  // The access rule that let this person in; null when an administrator approved them by hand.
  rule_id: number | null;
}

export type RuleKind = "org" | "login" | "email";
// What happens to someone no rule names: they wait for approval, or they get no account at all.
export type Outsiders = "pending" | "refuse";

export interface AccessRule {
  id: number;
  kind: RuleKind;
  value: string;
  created_at: string;
  created_by: string | null;
  // How many accounts this rule let in.
  people: number;
  // A login rule is tied to the first GitHub account that used it.
  bound: boolean;
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
  // Asked from GitHub only when a rule needs them, used for this sign-in and not stored.
  orgs?: string[];
  emails?: string[];
  // What GitHub gave no answer about. Someone a rule already let in keeps their place then.
  unknownOrgs?: string[];
  emailsUnknown?: boolean;
}

export interface AdminList {
  logins: Set<string>;
  ids: Set<number>;
}

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RULE_KINDS: Record<RuleKind, string> = { org: "GitHub organization", login: "GitHub login", email: "email address" };

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
  by_env INTEGER NOT NULL DEFAULT 0,
  rule_id INTEGER
);
-- Who gets in without waiting: members of a GitHub organization, a GitHub login, a verified email address.
CREATE TABLE IF NOT EXISTS access_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('org', 'login', 'email')),
  value TEXT NOT NULL,
  -- For a login: the GitHub account it means, set by the first sign-in with it.
  github_id INTEGER,
  created_at TEXT NOT NULL,
  created_by TEXT,
  UNIQUE (kind, value)
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

const USER_COLUMNS = "id, github_id, login, name, role, status, created_at, approved_at, last_login_at, rule_id";
const RULE_COLUMNS =
  "r.id, r.kind, r.value, r.created_at, r.created_by, (SELECT COUNT(*) FROM users u WHERE u.rule_id = r.id) AS people, r.github_id IS NOT NULL AS bound";
type RuleRecord = Omit<AccessRule, "bound"> & { bound: number };
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
    if (!columns.some((column) => column.name === "rule_id")) this.db.run("ALTER TABLE users ADD COLUMN rule_id INTEGER");
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

  // The first rule on the access list that names this person. A login rule is tied to the first
  // GitHub account that signs in with it, because GitHub hands a freed login to whoever asks.
  private matchRule(profile: GitHubIdentity): AccessRule | null {
    const login = profile.login.toLowerCase();
    const orgs = new Set((profile.orgs ?? []).map((org) => org.toLowerCase()));
    const emails = new Set((profile.emails ?? []).map((email) => email.toLowerCase()));
    const rules = this.db.query<AccessRule & { github_id: number | null }, []>("SELECT id, kind, value, github_id, created_at, created_by FROM access_rules ORDER BY id").all();
    for (const rule of rules) {
      let matches = false;
      if (rule.kind === "org") matches = orgs.has(rule.value);
      else if (rule.kind === "email") matches = emails.has(rule.value);
      else if (rule.github_id === profile.id) matches = true;
      else if (rule.github_id === null && rule.value === login) {
        this.db.run("UPDATE access_rules SET github_id = ? WHERE id = ?", [profile.id, rule.id]);
        matches = true;
      }
      if (matches) return this.getRule(rule.id);
    }
    return null;
  }

  // Back to waiting: no session, no keys, no administrator role.
  private suspend(userId: number) {
    this.db.run("UPDATE users SET status = 'pending', role = 'member', by_env = 0, rule_id = NULL WHERE id = ?", [userId]);
    this.db.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
    this.db.run("DELETE FROM mcp_keys WHERE user_id = ?", [userId]);
  }

  // First sign-in creates the account. DOCIFY_ADMINS makes it an administrator, a rule on the access
  // list lets it in as a member, and otherwise it waits as pending or, with outsiders refused, is not made.
  // A disabled account gets no session. `previous` is the session the browser already had; it ends.
  // `loginTaken` reports a named login that already belongs to another GitHub account.
  // `admitted` is the rule that let the person in at this sign-in; `suspended` says a rule let them
  // in before and none does now, so they wait again.
  signIn(
    profile: GitHubIdentity,
    previous?: string | null,
  ): { user: UserRow; session: string | null; created: boolean; loginTaken: boolean; admitted: AccessRule | null; suspended: boolean } {
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
      const before = byGitHub();
      const created = !before;
      const rule = named ? null : this.matchRule(profile);
      let admitted: AccessRule | null = null;
      let suspended = false;
      if (!before) {
        if (!named && !rule && this.outsiders === "refuse") throw new DocifyError("not_invited", `${profile.login} is not on the access list of this server`);
        const open = named || !!rule;
        this.db.run(
          "INSERT INTO users (github_id, login, name, role, status, created_at, approved_at, last_login_at, by_env, rule_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [profile.id, profile.login, profile.name, named ? "admin" : "member", open ? "active" : "pending", now, open ? now : null, now, named ? 1 : 0, rule?.id ?? null],
        );
        admitted = rule;
      } else {
        this.db.run("UPDATE users SET login = ?, name = ?, last_login_at = ? WHERE github_id = ?", [profile.login, profile.name, now, profile.id]);
        if (named) {
          this.db.run("UPDATE users SET role = 'admin', status = 'active', by_env = 1, approved_at = COALESCE(approved_at, ?) WHERE github_id = ?", [now, profile.id]);
        } else if (before.status === "pending" && rule) {
          this.db.run("UPDATE users SET status = 'active', approved_at = COALESCE(approved_at, ?), rule_id = ? WHERE id = ?", [now, rule.id, before.id]);
          admitted = rule;
        } else if (before.status === "active" && before.rule_id !== null) {
          // Let in by a rule: it has to hold at every sign-in, so leaving the organization ends access.
          const held = this.getRule(before.rule_id);
          const unanswered = (held?.kind === "org" && !!profile.unknownOrgs?.includes(held.value)) || (held?.kind === "email" && !!profile.emailsUnknown);
          if (rule) this.db.run("UPDATE users SET rule_id = ? WHERE id = ?", [rule.id, before.id]);
          else if (!unanswered) {
            this.suspend(before.id);
            suspended = true;
          }
        }
      }
      this.db.run("DELETE FROM sessions WHERE expires_at <= ?", [now]);
      if (previous) this.db.run("DELETE FROM sessions WHERE token_hash = ?", [hashToken(previous)]);
      const user = byGitHub()!;
      if (user.status === "disabled") return { user, session: null, created, loginTaken, admitted, suspended };
      const session = randomBytes(32).toString("base64url");
      // Only the hash is stored, so a copy of this file holds no usable session.
      this.db.run("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [hashToken(session), user.id, now, this.iso(SESSION_TTL_MS)]);
      // Sign-ins cannot pile sessions up without limit; the oldest go first.
      this.db.run("DELETE FROM sessions WHERE user_id = ? AND rowid NOT IN (SELECT rowid FROM sessions WHERE user_id = ? ORDER BY rowid DESC LIMIT ?)", [user.id, user.id, MAX_SESSIONS_PER_USER]);
      return { user, session, created, loginTaken, admitted, suspended };
    })();
  }

  get outsiders(): Outsiders {
    return this.db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'outsiders'").get()?.value === "refuse" ? "refuse" : "pending";
  }

  setOutsiders(value: unknown): Outsiders {
    if (value !== "pending" && value !== "refuse") throw new DocifyError("invalid_input", "outsiders must be pending or refuse", "outsiders");
    this.db.run("INSERT INTO meta (key, value) VALUES ('outsiders', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [value]);
    return value;
  }

  getRule(id: number): AccessRule | null {
    const row = this.db.query<RuleRecord, [number]>(`SELECT ${RULE_COLUMNS} FROM access_rules r WHERE r.id = ?`).get(id);
    return row && { ...row, bound: !!row.bound };
  }

  listRules(): AccessRule[] {
    return this.db
      .query<RuleRecord, []>(`SELECT ${RULE_COLUMNS} FROM access_rules r ORDER BY r.id`)
      .all()
      .map((row) => ({ ...row, bound: !!row.bound }));
  }

  // What a sign-in has to ask GitHub for, beyond the public profile.
  accessNeeds(): { orgs: string[]; emails: boolean } {
    const rules = this.db.query<{ kind: RuleKind; value: string }, []>("SELECT kind, value FROM access_rules WHERE kind IN ('org', 'email') ORDER BY id").all();
    return { orgs: rules.filter((rule) => rule.kind === "org").map((rule) => rule.value), emails: rules.some((rule) => rule.kind === "email") };
  }

  // Values are kept in lower case: GitHub logins, organization names and the addresses we compare are case-insensitive.
  addRule(kind: unknown, value: unknown, createdBy: string | null): AccessRule {
    if (kind !== "org" && kind !== "login" && kind !== "email") throw new DocifyError("invalid_input", "kind must be org, login or email", "kind");
    const text = typeof value === "string" ? value.trim().toLowerCase() : "";
    const valid = kind === "email" ? text.length <= 254 && EMAIL_RE.test(text) : LOGIN_RE.test(text);
    if (!valid) {
      const example = kind === "email" ? "an address such as name@example.com" : `a ${RULE_KINDS[kind]} such as ${kind === "org" ? "acme" : "octocat"}: letters, digits and hyphens`;
      throw new DocifyError("invalid_input", `enter ${example}`, "value");
    }
    return this.db.transaction(() => {
      const rules = this.listRules();
      if (rules.some((rule) => rule.kind === kind && rule.value === text)) throw new DocifyError("exists", `the access list already has ${text}`, "value");
      if (rules.length >= MAX_ACCESS_RULES) throw new DocifyError("conflict", `the access list holds at most ${MAX_ACCESS_RULES} entries`);
      if (kind === "org" && rules.filter((rule) => rule.kind === "org").length >= MAX_ORG_RULES) {
        throw new DocifyError("conflict", `the access list holds at most ${MAX_ORG_RULES} organizations`);
      }
      const { lastInsertRowid } = this.db.run("INSERT INTO access_rules (kind, value, created_at, created_by) VALUES (?, ?, ?, ?)", [kind, text, this.iso(), createdBy]);
      return this.getRule(Number(lastInsertRowid))!;
    })();
  }

  // The people this rule let in wait again and lose their sessions and keys. At their next sign-in
  // another rule may let them back in. Accounts approved by hand and named administrators stay.
  removeRule(id: number, actorId: number | null): { rule: AccessRule; suspended: string[] } {
    return this.db.transaction(() => {
      const rule = this.getRule(id);
      if (!rule) throw new DocifyError("rule_unknown", "unknown access rule");
      const actor = actorId === null ? null : this.getUser(actorId);
      if (actor?.rule_id === id && !this.isNamedAdmin(actor)) throw new DocifyError("conflict", "this entry lets you in; another administrator has to remove it");
      const suspended: string[] = [];
      for (const user of this.db.query<UserRow, [number]>(`SELECT ${USER_COLUMNS} FROM users WHERE rule_id = ?`).all(id)) {
        if (this.isNamedAdmin(user)) this.db.run("UPDATE users SET rule_id = NULL WHERE id = ?", [user.id]);
        else {
          this.suspend(user.id);
          suspended.push(user.login);
        }
      }
      this.db.run("DELETE FROM access_rules WHERE id = ?", [id]);
      return { rule, suspended };
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

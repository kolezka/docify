import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DocifyError } from "./docify.ts";

// Accounts and sessions have their own file. A store backup copies docify.sqlite whole and an
// import replaces it, so users kept there would leak into backups and vanish on import.
export const ACCOUNTS_FILE = "accounts.sqlite";
export const ACCOUNTS_SCHEMA_VERSION = 1;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

// "alice, bob, id:583231". A login is easy to type; an id survives a GitHub rename, and a
// renamed admin's old login can be taken by someone else.
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
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
`;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export interface UserPatch {
  role?: Role;
  status?: "active" | "disabled";
}

export class AccountStore {
  private db: Database;

  constructor(
    home: string,
    readonly admins: AdminList,
    private now: () => number = Date.now,
  ) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.db = new Database(join(home, ACCOUNTS_FILE), { create: true });
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
    this.db.run("DELETE FROM sessions WHERE expires_at <= ?", [this.iso()]);
  }

  close() {
    this.db.close();
  }

  private iso(offsetMs = 0): string {
    return new Date(this.now() + offsetMs).toISOString();
  }

  // Named in DOCIFY_ADMINS: always an active admin, and the panel cannot change that.
  isNamedAdmin(user: Pick<UserRow, "github_id" | "login">): boolean {
    return this.admins.ids.has(user.github_id) || this.admins.logins.has(user.login.toLowerCase());
  }

  getUser(id: number): UserRow | null {
    return this.db.query<UserRow, [number]>("SELECT * FROM users WHERE id = ?").get(id);
  }

  listUsers(): UserRow[] {
    return this.db.query<UserRow, []>("SELECT * FROM users ORDER BY status = 'pending' DESC, login COLLATE NOCASE").all();
  }

  // First sign-in creates the account. It waits as pending unless DOCIFY_ADMINS names it.
  // A disabled account gets no session.
  signIn(profile: GitHubIdentity): { user: UserRow; session: string | null; created: boolean } {
    const now = this.iso();
    const named = this.isNamedAdmin({ github_id: profile.id, login: profile.login });
    return this.db.transaction(() => {
      const byGitHub = () => this.db.query<UserRow, [number]>("SELECT * FROM users WHERE github_id = ?").get(profile.id);
      const created = !byGitHub();
      if (created) {
        this.db.run(
          "INSERT INTO users (github_id, login, name, role, status, created_at, approved_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [profile.id, profile.login, profile.name, named ? "admin" : "member", named ? "active" : "pending", now, named ? now : null, now],
        );
      } else {
        this.db.run("UPDATE users SET login = ?, name = ?, last_login_at = ? WHERE github_id = ?", [profile.login, profile.name, now, profile.id]);
        if (named) this.db.run("UPDATE users SET role = 'admin', status = 'active', approved_at = COALESCE(approved_at, ?) WHERE github_id = ?", [now, profile.id]);
      }
      this.db.run("DELETE FROM sessions WHERE expires_at <= ?", [now]);
      const user = byGitHub()!;
      if (user.status === "disabled") return { user, session: null, created };
      const session = randomBytes(32).toString("base64url");
      // Only the hash is stored, so a copy of this file holds no usable session.
      this.db.run("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [hashToken(session), user.id, now, this.iso(SESSION_TTL_MS)]);
      return { user, session, created };
    })();
  }

  userForSession(session: string | null | undefined): UserRow | null {
    if (!session) return null;
    return this.db
      .query<UserRow, [string, string]>("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?")
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
      if (patch.role !== undefined) this.db.run("UPDATE users SET role = ? WHERE id = ?", [patch.role, id]);
      if (patch.status === "active") this.db.run("UPDATE users SET status = 'active', approved_at = COALESCE(approved_at, ?) WHERE id = ?", [this.iso(), id]);
      if (patch.status === "disabled") {
        this.db.run("UPDATE users SET status = 'disabled' WHERE id = ?", [id]);
        this.db.run("DELETE FROM sessions WHERE user_id = ?", [id]);
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
}

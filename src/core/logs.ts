import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { DocifyConfig } from "./config.ts";

export type LogStream = "stdout" | "stderr" | "system";
export type LogLevel = "info" | "warn" | "error";
export interface LogEntry {
  seq: number;
  ts: string;
  source: string;
  stream: LogStream;
  level: LogLevel;
  text: string;
}
export interface LogPage { lines: LogEntry[]; cursor: number; capped: boolean }
export const LOG_LIMIT = 10_000;
const MAX_LINE = 8192;

export class LogReadError extends Error {}

export function redactLog(text: string, config: DocifyConfig): string {
  const names = new Set([config.embeddingApiKeyEnv, config.graph?.apiKeyEnv, "OPENAI_API_KEY", "LITELLM_API_KEY", "DOCIFY_GITHUB_CLIENT_SECRET"]);
  let clean = text;
  for (const name of names) {
    const secret = name ? process.env[name] : undefined;
    if (secret) clean = clean.replaceAll(secret, "[REDACTED]");
  }
  return clean.replace(/(Bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/([?&](?:token|api[_-]?key|access_token|password)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@");
}

/** Separate from the document schema so adding diagnostics never requires rebuilding sources. */
export class LogStore {
  private writer?: Database;
  private warned = false;
  constructor(private readonly config: () => DocifyConfig) {}

  append(source: string, text: string, stream: LogStream = "system", level: LogLevel = "info") {
    try {
      if (!this.writer) {
        const file = join(this.config().home, "logs.sqlite");
        const db = new Database(file, { create: true, strict: true });
        try {
          chmodSync(file, 0o600);
          db.run("PRAGMA busy_timeout = 1000");
          db.run("PRAGMA journal_mode = WAL");
          db.run(`CREATE TABLE IF NOT EXISTS logs (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, source TEXT NOT NULL,
            stream TEXT NOT NULL, level TEXT NOT NULL, text TEXT NOT NULL
          )`);
          this.writer = db;
        } catch (err) { db.close(); throw err; }
      }
      const db = this.writer;
      const clean = redactLog(text, this.config());
      db.transaction(() => {
        for (const line of clean.split(/\r\n|[\r\n]/)) {
          if (!line) continue;
          db.run("INSERT INTO logs (ts, source, stream, level, text) VALUES (?, ?, ?, ?, ?)", [new Date().toISOString(), source, stream, level, line.slice(0, MAX_LINE)]);
        }
        db.run("DELETE FROM logs WHERE seq <= (SELECT MAX(seq) - ? FROM logs)", [LOG_LIMIT]);
      }).immediate();
      this.warned = false;
    } catch {
      // Diagnostics must not turn a committed activation into a failed preparation.
      if (!this.warned) console.error("docify: could not write application logs; check the store permissions and disk space");
      this.warned = true;
    }
  }

  read(after = 0, limit = 1000): LogPage {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("invalid log cursor or limit");
    const file = join(this.config().home, "logs.sqlite");
    if (!existsSync(file)) return { lines: [], cursor: after, capped: false };
    let db: Database | undefined;
    try {
      db = new Database(file, { readonly: true, strict: true });
      db.run("PRAGMA busy_timeout = 1000");
      return db.transaction(() => {
        const first = db!.query<{ seq: number | null }, []>("SELECT MIN(seq) AS seq FROM logs").get()!.seq;
        const lines = db!.query<LogEntry, [number, number]>("SELECT seq, ts, source, stream, level, text FROM logs WHERE seq > ? ORDER BY seq LIMIT ?").all(after, limit);
        for (const line of lines) {
          if (!Number.isSafeInteger(line.seq) || line.seq <= after || typeof line.text !== "string" || typeof line.source !== "string" ||
            !Number.isFinite(Date.parse(line.ts)) || !["stdout", "stderr", "system"].includes(line.stream) || !["info", "warn", "error"].includes(line.level)) {
            throw new Error("invalid log entry");
          }
        }
        return { lines, cursor: lines.at(-1)?.seq ?? after, capped: first !== null && first > after + 1 };
      })();
    } catch {
      throw new LogReadError("Application log history could not be read. Check logs.sqlite and store permissions.");
    } finally { db?.close(); }
  }

  close() { this.writer?.close(); this.writer = undefined; }
}

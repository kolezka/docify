import type { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { openDb, nowIso, SCHEMA_VERSION } from "./db.ts";
import { BYTES_PER_MB, loadConfig, saveConfig, type DocifyConfig } from "./config.ts";
import { collectLocal, crawl, DEFAULT_LIMITS, type CollectLog, type CrawlLimits, type Fetcher, type RawDoc } from "./collect.ts";
import { normalize } from "./normalize.ts";
import { chunk } from "./chunk.ts";
import { countTokens } from "./tokens.ts";
import { sha256 } from "./hash.ts";
import { readSnapshotFile, snapshotRel, writeSnapshotFile } from "./snapshot-file.ts";
import { embedTexts, embeddingIdentity } from "./embed.ts";
import { crawl4aiFetcher } from "./crawl4ai.ts";
import { browserlessFetcher } from "./browserless.ts";
import { groundingTerms, runGraphify, type GraphRunResult } from "./graph.ts";
import { extractSymbols } from "./symbols.ts";
import { LogStore } from "./logs.ts";

export type SourceKind = "local" | "url";
export type CrawlProvider = "builtin" | "crawl4ai" | "browserless";

function validateCrawlProvider(value: unknown): asserts value is CrawlProvider {
  if (value !== "builtin" && value !== "crawl4ai" && value !== "browserless") {
    throw new DocifyError("invalid_input", "crawlProvider must be builtin, crawl4ai or browserless");
  }
}

export interface SourceRow {
  id: string;
  library: string;
  version: string | null;
  kind: SourceKind;
  locator: string;
  options: string;
  created_at: string;
  active_generation: number | null;
  lock_pid: number | null;
  lock_at: string | null;
}

export interface GenerationRow {
  id: number;
  source_id: string;
  status: "staging" | "active" | "superseded" | "failed";
  phase: string | null;
  progress: string | null;
  error: string | null;
  pid: number | null;
  started_at: string;
  finished_at: string | null;
  downloaded_at: string | null;
  snapshot_hash: string | null;
  snapshot_dir: string | null;
  embedding_model: string | null;
  embedding_dims: number | null;
  graph_status: string | null;
  stats: string;
  schema_version: number;
}

export interface Crawl4aiSourceOptions {
  stream?: boolean;
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
  waitFor?: string;
  delayBeforeReturnHtml?: number;
  scanFullPage?: boolean;
  captureScreenshot?: boolean;
  capturePdf?: boolean;
}

function validateCrawl4aiOptions(value: unknown): Crawl4aiSourceOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DocifyError("invalid_input", "crawl4ai must be an object");
  const options = value as Record<string, unknown>;
  for (const [key, v] of Object.entries(options)) {
    if (key === "stream" || key === "scanFullPage" || key === "captureScreenshot" || key === "capturePdf") {
      if (typeof v !== "boolean") throw new DocifyError("invalid_input", `${key} must be a boolean`);
    } else if (key === "waitUntil") {
      if (!["load", "domcontentloaded", "networkidle", "commit"].includes(v as string)) throw new DocifyError("invalid_input", "invalid waitUntil");
    } else if (key === "waitFor") {
      if (typeof v !== "string" || v.length > 1000) throw new DocifyError("invalid_input", "waitFor must be text of at most 1000 characters");
    } else if (key === "delayBeforeReturnHtml") {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 60) throw new DocifyError("invalid_input", "delayBeforeReturnHtml must be between 0 and 60 seconds");
    } else throw new DocifyError("invalid_input", `unknown crawl4ai option: ${key}`);
  }
  return options as Crawl4aiSourceOptions;
}

type CrawlLimitPatch = { maxPages?: number | null; maxDepth?: number | null };

function validateCrawlLimitPatch(value: unknown, allowNull: boolean): CrawlLimitPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DocifyError("invalid_input", "crawl must be an object");
  const patch = value as Record<string, unknown>;
  for (const [key, v] of Object.entries(patch)) {
    if (key !== "maxPages" && key !== "maxDepth") throw new DocifyError("invalid_input", `unknown crawl option: ${key}`);
    if (allowNull && v === null) continue;
    const min = key === "maxPages" ? 1 : 0;
    const max = key === "maxPages" ? 100_000 : 1000;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new DocifyError("invalid_input", `crawl.${key} must be a whole number between ${min} and ${max}`);
  }
  return patch as CrawlLimitPatch;
}

const MAX_IGNORE_PATTERNS = 100;
const MAX_IGNORE_PATTERN_LENGTH = 500;

// Regular expressions tested against a document's path inside the source, anywhere in it unless anchored.
export function validateIgnorePatterns(value: unknown, name: "ignore" | "graphIgnore"): string[] {
  const invalid = (message: string) => new DocifyError("invalid_input", `${name}: ${message}`, name);
  if (!Array.isArray(value)) throw invalid("must be a list of regular expressions");
  if (value.length > MAX_IGNORE_PATTERNS) throw invalid(`at most ${MAX_IGNORE_PATTERNS} patterns are accepted`);
  for (const pattern of value) {
    if (typeof pattern !== "string" || !pattern) throw invalid("patterns must be non-empty text");
    if (pattern.length > MAX_IGNORE_PATTERN_LENGTH) throw invalid(`patterns are limited to ${MAX_IGNORE_PATTERN_LENGTH} characters`);
    try {
      new RegExp(pattern);
    } catch (err) {
      // Name the pattern: the engine's message alone does not say which line of a list is wrong.
      const reason = err instanceof Error ? err.message.replace(/^Invalid regular expression: /, "") : "";
      throw invalid(`${JSON.stringify(pattern)} is not a valid regular expression${reason ? ` (${reason})` : ""}`);
    }
  }
  return [...new Set(value as string[])];
}

const compileIgnore = (value: unknown, name: "ignore" | "graphIgnore") => validateIgnorePatterns(value ?? [], name).map((pattern) => new RegExp(pattern));

export interface AddSourceInput {
  library: string;
  version?: string | null;
  kind: SourceKind;
  locator: string;
  id?: string;
  crawl?: Partial<CrawlLimits>;
  crawlProvider?: CrawlProvider;
  // Paths that are not collected at all.
  ignore?: string[];
  // Paths that stay searchable but are left out of the graph.
  graphIgnore?: string[];
}

export interface PrepareOptions {
  graph?: boolean; // default true; false records graph_status = skipped
  // Retry only the graph of the newest generation whose graph phase failed, from its saved snapshot.
  graphOnly?: boolean;
  force?: boolean;
  signal?: AbortSignal;
  fetcher?: Fetcher;
  // Test hook: called at each phase boundary, may throw to simulate failure.
  onPhase?: (phase: string, generationId: number) => void | Promise<void>;
  graphRunner?: typeof runGraphify;
}

export interface PrepareResult {
  sourceId: string;
  generationId: number;
  status: "activated" | "unchanged";
  stats: Record<string, unknown>;
}

// Saved in stats.resume of a failed generation whose graph phase was reached. Its documents,
// passages, vectors and snapshot are kept, so the graph can be retried without collecting again.
export interface GraphResume {
  downloadedAt: string;
  snapshotHash: string;
  embedding: string;
  dims: number;
  // Stats of the phases before the graph.
  base: Record<string, unknown> & { pipeline: number; passages: number; documents: number };
}

export function graphResumeOf(gen: Pick<GenerationRow, "status" | "stats">): GraphResume | null {
  if (gen.status !== "failed") return null;
  return (JSON.parse(gen.stats) as { resume?: GraphResume }).resume ?? null;
}

interface GraphDoc {
  path: string;
  markdown: string;
  docId: number;
  passages: { rowid: number; text: string; headingPath: string[] }[];
}

export class DocifyError extends Error {
  constructor(
    public code: string,
    message: string,
    // The input the error is about, when there is one; the web UI shows the message at that field.
    public field?: string,
  ) {
    super(message);
  }
}

const ID_RE = /^[a-z0-9][a-z0-9._@-]{0,80}$/;
const LIBRARY_RE = /^[a-z0-9][a-z0-9._-]{0,60}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,40}$/;

// Bump when normalization, chunking or indexing changes, so identical raw snapshots are rebuilt.
export const PIPELINE_VERSION = 5;

export function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// A writer renews its lease while preparing. A lease older than this, or one whose pid is
// gone, is dead; the age check also covers a reused pid.
export const LEASE_MS = 60_000;
const HEARTBEAT_MS = 10_000;

export function leaseAlive(pid: number | null, at: string | null): boolean {
  if (!pid || !pidAlive(pid)) return false;
  return at !== null && Date.now() - Date.parse(at) < LEASE_MS;
}

export const INTERRUPTED_ERROR = "interrupted: the preparing process exited before activation";

// A staging generation whose writer no longer holds a live lease on its source will never
// activate. recoverInterrupted() cleans it up; readers use this to see the same without writing.
export function isInterrupted(gen: Pick<GenerationRow, "status" | "pid">, source: Pick<SourceRow, "lock_pid" | "lock_at"> | null): boolean {
  if (gen.status !== "staging") return false;
  return !(source && source.lock_pid === gen.pid && leaseAlive(source.lock_pid, source.lock_at));
}

// The generation as readers should report it: interrupted reads as failed, as after recovery.
// The failure time is the writer's last heartbeat when known, else its start.
export function effectiveGeneration(gen: GenerationRow, source: SourceRow | null): GenerationRow {
  if (!isInterrupted(gen, source)) return gen;
  const lastSeen = source && source.lock_pid === gen.pid ? source.lock_at : null;
  return { ...gen, status: "failed", error: INTERRUPTED_ERROR, finished_at: gen.finished_at ?? lastSeen ?? gen.started_at };
}

export class Docify {
  private database: Database;
  readonly logs: LogStore;
  private current: DocifyConfig;
  private readonly overrides: Partial<DocifyConfig>;

  constructor(config: Partial<DocifyConfig> & { home?: string } = {}) {
    const base = loadConfig(config.home);
    this.overrides = config;
    this.current = { ...base, ...config };
    this.database = openDb(this.current.home);
    this.logs = new LogStore(() => this.config);
  }

  get db(): Database {
    return this.database;
  }

  get config(): DocifyConfig {
    return this.current;
  }

  close() {
    this.logs.close();
    this.db.close();
  }

  // ---- config --------------------------------------------------------------

  // Sources this process is preparing right now. A preparation reads the config at several
  // points, so it must never see the config change halfway.
  preparingHere(): string[] {
    return this.db
      .query<{ id: string; lock_at: string | null }, [number]>("SELECT id, lock_at FROM sources WHERE lock_pid = ?")
      .all(process.pid)
      .filter((s) => leaseAlive(process.pid, s.lock_at))
      .map((s) => s.id);
  }

  // Validates and writes the changed keys to config.json, then applies them to this instance.
  saveConfig(patch: unknown): DocifyConfig {
    const busy = this.preparingHere();
    if (busy.length) throw new DocifyError("busy", `cannot change settings while preparing ${busy.join(", ")}; wait or cancel first`);
    saveConfig(this.current.home, patch);
    this.current = { ...loadConfig(this.current.home), ...this.overrides };
    return this.current;
  }

  // ---- sources -------------------------------------------------------------

  addSource(input: AddSourceInput): SourceRow {
    const library = input.library.trim().toLowerCase();
    if (!LIBRARY_RE.test(library)) throw new DocifyError("invalid_input", `invalid library name: ${input.library}`);
    const version = input.version?.trim() || null;
    if (version && !VERSION_RE.test(version)) throw new DocifyError("invalid_input", `invalid version: ${version}`);
    const id = input.id ?? `${library}@${version ?? "unknown"}`;
    if (!ID_RE.test(id)) throw new DocifyError("invalid_input", `invalid source id: ${id}`);
    if (input.crawlProvider !== undefined) {
      validateCrawlProvider(input.crawlProvider);
      if (input.kind !== "url") throw new DocifyError("invalid_input", "crawlProvider applies only to URL sources");
    }
    if (input.crawl !== undefined) {
      for (const key of ["maxPages", "maxDepth"] as const) {
        if (key in input.crawl) validateCrawlLimitPatch({ [key]: input.crawl[key] }, false);
      }
    }
    const ignore = input.ignore === undefined ? [] : validateIgnorePatterns(input.ignore, "ignore");
    const graphIgnore = input.graphIgnore === undefined ? [] : validateIgnorePatterns(input.graphIgnore, "graphIgnore");
    let locator = input.locator.trim();
    if (input.kind === "local") {
      locator = resolve(locator.replace(/^~(?=$|\/)/, homedir()));
      if (!existsSync(locator)) throw new DocifyError("invalid_input", `path does not exist: ${locator}`);
      if (locator === this.config.home || locator.startsWith(this.config.home + sep)) {
        throw new DocifyError("invalid_input", "cannot register Docify's own store as a source");
      }
      statSync(locator);
    } else {
      let u: URL;
      try {
        u = new URL(locator);
      } catch {
        throw new DocifyError("invalid_input", `invalid URL: ${locator}`);
      }
      if (!/^https?:$/.test(u.protocol)) throw new DocifyError("invalid_input", "only http(s) URLs are supported");
      locator = u.toString();
    }
    const existing = this.getSource(id);
    if (existing) throw new DocifyError("exists", `source ${id} already exists`);
    this.db.run(
      "INSERT INTO sources (id, library, version, kind, locator, options, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, library, version, input.kind, locator, JSON.stringify({
        crawl: input.crawl ?? {},
        ...(input.crawlProvider === undefined ? {} : { crawlProvider: input.crawlProvider }),
        ...(ignore.length ? { ignore } : {}),
        ...(graphIgnore.length ? { graphIgnore } : {}),
      }), nowIso()],
    );
    this.logs.append(id, `Source registered (${input.kind})`);
    return this.getSource(id)!;
  }

  updateSourceCrawler(id: string, provider: CrawlProvider | null | undefined, crawl4ai?: unknown, crawl?: unknown): SourceRow {
    if (provider === undefined && crawl4ai === undefined && crawl === undefined) throw new DocifyError("invalid_input", "crawler settings are required");
    if (provider !== null && provider !== undefined) validateCrawlProvider(provider);
    const runOptions = crawl4ai === undefined ? undefined : validateCrawl4aiOptions(crawl4ai);
    const limitPatch = crawl === undefined ? undefined : validateCrawlLimitPatch(crawl, true);
    return this.db.transaction(() => {
      const source = this.requireSource(id);
      if (source.kind !== "url") throw new DocifyError("invalid_input", "crawlProvider applies only to URL sources");
      if (leaseAlive(source.lock_pid, source.lock_at)) throw new DocifyError("busy", `source ${id} is being prepared`);
      const options = JSON.parse(source.options);
      if (provider === null) delete options.crawlProvider;
      else if (provider !== undefined) options.crawlProvider = provider;
      if (runOptions !== undefined) options.crawl4ai = runOptions;
      if (limitPatch !== undefined) {
        options.crawl = { ...options.crawl };
        for (const [key, value] of Object.entries(limitPatch)) {
          if (value === null) delete options.crawl[key];
          else options.crawl[key] = value;
        }
      }
      this.db.run("UPDATE sources SET options = ? WHERE id = ?", [JSON.stringify(options), id]);
      return this.requireSource(id);
    }).immediate();
  }

  // Works for local and URL sources. A list replaces the stored one; null or an empty list removes it.
  // The change applies at the next prepare.
  updateSourceIgnore(id: string, patch: { ignore?: unknown; graphIgnore?: unknown }): SourceRow {
    if (patch.ignore === undefined && patch.graphIgnore === undefined) throw new DocifyError("invalid_input", "ignore or graphIgnore is required");
    const lists = (["ignore", "graphIgnore"] as const)
      .filter((name) => patch[name] !== undefined)
      .map((name) => ({ name, patterns: patch[name] === null ? [] : validateIgnorePatterns(patch[name], name) }));
    return this.db.transaction(() => {
      const source = this.requireSource(id);
      if (leaseAlive(source.lock_pid, source.lock_at)) throw new DocifyError("busy", `source ${id} is being prepared`);
      const options = JSON.parse(source.options);
      for (const { name, patterns } of lists) {
        if (patterns.length) options[name] = patterns;
        else delete options[name];
      }
      this.db.run("UPDATE sources SET options = ? WHERE id = ?", [JSON.stringify(options), id]);
      return this.requireSource(id);
    }).immediate();
  }

  removeSource(id: string) {
    const src = this.requireSource(id);
    if (src.lock_pid && leaseAlive(src.lock_pid, src.lock_at)) throw new DocifyError("busy", `source ${id} is being prepared by pid ${src.lock_pid}`);
    const gens = this.db.query<{ id: number }, [string]>("SELECT id FROM generations WHERE source_id = ?").all(id);
    this.db.transaction(() => {
      for (const g of gens) this.deleteGenerationRows(g.id);
      this.db.run("DELETE FROM generations WHERE source_id = ?", [id]);
      this.db.run("DELETE FROM sources WHERE id = ?", [id]);
    })();
    rmSync(join(this.config.home, "snapshots", id), { recursive: true, force: true });
    rmSync(join(this.config.home, "graphify", id), { recursive: true, force: true });
    this.logs.append(id, "Source removed");
  }

  getSource(id: string): SourceRow | null {
    return this.db.query<SourceRow, [string]>("SELECT * FROM sources WHERE id = ?").get(id);
  }

  requireSource(id: string): SourceRow {
    const s = this.getSource(id);
    if (!s) throw new DocifyError("source_unknown", `no source with id ${id}`);
    return s;
  }

  listSourceRows(): SourceRow[] {
    return this.db.query<SourceRow, []>("SELECT * FROM sources ORDER BY library, version").all();
  }

  generations(sourceId: string): GenerationRow[] {
    return this.db.query<GenerationRow, [string]>("SELECT * FROM generations WHERE source_id = ? ORDER BY id DESC").all(sourceId);
  }

  // Marks staging generations and locks left by dead writers as interrupted. Every decision is
  // re-checked inside an immediate transaction, so a lock taken meanwhile is never cleared.
  // Only writer paths call this (prepare, serve startup); queries use effectiveGeneration().
  recoverInterrupted(): number {
    let n = 0;
    const candidates = this.db.query<{ id: number; source_id: string }, []>("SELECT id, source_id FROM generations WHERE status = 'staging'").all();
    for (const c of candidates) {
      const recovered = this.db
        .transaction(() => {
          const g = this.db.query<Pick<GenerationRow, "pid" | "status">, [number]>("SELECT pid, status FROM generations WHERE id = ?").get(c.id);
          const s = this.getSource(c.source_id);
          if (!g || !isInterrupted(g, s)) return false;
          this.deleteGenerationRows(c.id);
          // stats = '{}' also drops a graph-only retry's resume record: its index is deleted here.
          this.db.run("UPDATE generations SET status = 'failed', error = ?, finished_at = ?, stats = '{}' WHERE id = ?", [INTERRUPTED_ERROR, nowIso(), c.id]);
          if (s && s.lock_pid === g.pid) this.db.run("UPDATE sources SET lock_pid = NULL, lock_at = NULL WHERE id = ? AND lock_pid IS ?", [s.id, g.pid]);
          return true;
        })
        .immediate();
      if (recovered) {
        rmSync(join(this.config.home, "snapshots", c.source_id, String(c.id)), { recursive: true, force: true });
        n++;
      }
    }
    for (const s of this.listSourceRows()) {
      if (!s.lock_pid || leaseAlive(s.lock_pid, s.lock_at)) continue;
      this.db.run("UPDATE sources SET lock_pid = NULL, lock_at = NULL WHERE id = ? AND lock_pid = ? AND lock_at IS ?", [s.id, s.lock_pid, s.lock_at]);
    }
    return n;
  }

  // ---- preparation ---------------------------------------------------------

  private acquireLock(sourceId: string) {
    const ok = this.db
      .transaction(() => {
        const s = this.requireSource(sourceId);
        if (s.lock_pid && leaseAlive(s.lock_pid, s.lock_at)) return false;
        this.db.run("UPDATE sources SET lock_pid = ?, lock_at = ? WHERE id = ?", [process.pid, nowIso(), sourceId]);
        return true;
      })
      .immediate();
    if (!ok) throw new DocifyError("busy", `source ${sourceId} is already being prepared`);
  }

  // Leases every source for the length of fn, so no prepare, cleanup or removal changes the
  // store meanwhile. Fails as busy when any source is being prepared.
  async withAllLeases<T>(fn: () => Promise<T>): Promise<T> {
    this.recoverInterrupted();
    const held = this.db
      .transaction(() => {
        const rows = this.listSourceRows();
        const busy = rows.filter((s) => s.lock_pid && leaseAlive(s.lock_pid, s.lock_at)).map((s) => s.id);
        if (busy.length) throw new DocifyError("busy", `wait until ${busy.join(", ")} finished preparing, or cancel it`);
        for (const s of rows) this.db.run("UPDATE sources SET lock_pid = ?, lock_at = ? WHERE id = ?", [process.pid, nowIso(), s.id]);
        return rows.map((s) => s.id);
      })
      .immediate();
    const renew = () => {
      for (const id of held) this.db.run("UPDATE sources SET lock_at = ? WHERE id = ? AND lock_pid = ?", [nowIso(), id, process.pid]);
    };
    const heartbeat = setInterval(renew, HEARTBEAT_MS);
    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
      for (const id of held) this.releaseLock(id);
    }
  }

  // Closes the database, lets swap replace the store files, then opens whatever is there and
  // reloads config.json.
  // Reopens even when swap throws, so this instance stays usable.
  replaceStoreFiles(swap: () => void) {
    this.database.close();
    try {
      swap();
    } finally {
      this.database = openDb(this.current.home);
      this.current = { ...loadConfig(this.current.home), ...this.overrides };
    }
  }

  private releaseLock(sourceId: string) {
    this.db.run("UPDATE sources SET lock_pid = NULL, lock_at = NULL WHERE id = ? AND lock_pid = ?", [sourceId, process.pid]);
  }

  private setPhase(genId: number, phase: string, progress = "") {
    this.db.run("UPDATE generations SET phase = ?, progress = ? WHERE id = ?", [phase, progress, genId]);
  }

  async prepare(sourceId: string, opts: PrepareOptions = {}): Promise<PrepareResult> {
    this.recoverInterrupted();
    this.acquireLock(sourceId);
    const source = this.requireSource(sourceId);
    this.logs.append(sourceId, "Preparation started");
    const heartbeat = setInterval(() => {
      this.db.run("UPDATE sources SET lock_at = ? WHERE id = ? AND lock_pid = ?", [nowIso(), sourceId, process.pid]);
    }, HEARTBEAT_MS);
    try {
      return await (opts.graphOnly ? this.retryGraph(source, opts) : this.prepareLocked(source, opts));
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async prepareLocked(source: SourceRow, opts: PrepareOptions): Promise<PrepareResult> {
    const sourceId = source.id;
    // Generations already in flight in another Docify instance of this process are covered by the lock.
    // AUTOINCREMENT keeps ids increasing even after rows are deleted, so ids never repeat.
    const genId = Number(
      this.db.run(
        "INSERT INTO generations (source_id, status, phase, pid, started_at, schema_version) VALUES (?, 'staging', 'collect', ?, ?, ?)",
        [sourceId, process.pid, nowIso(), SCHEMA_VERSION],
      ).lastInsertRowid,
    );
    const snapshotDir = join(this.config.home, "snapshots", sourceId, String(genId));
    let result: PrepareResult;
    let resume: GraphResume | null = null;
    const checkpoint = async (phase: string, progress = "") => {
      if (opts.signal?.aborted) throw new DocifyError("cancelled", "preparation cancelled");
      this.setPhase(genId, phase, progress);
      this.logs.append(sourceId, `Generation ${genId}: ${phase}${progress ? ` (${progress})` : ""}`);
      await opts.onPhase?.(phase, genId);
    };
    try {
      await checkpoint("collect");
      const sourceOpts = JSON.parse(source.options) as { crawl?: Partial<CrawlLimits>; crawlProvider?: CrawlProvider; crawl4ai?: Crawl4aiSourceOptions; ignore?: string[]; graphIgnore?: string[] };
      const ignore = compileIgnore(sourceOpts.ignore, "ignore");
      const graphIgnore = compileIgnore(sourceOpts.graphIgnore, "graphIgnore");
      const inGraph = (path: string) => !graphIgnore.some((pattern) => pattern.test(path));
      const provider = source.kind === "local" ? "local" : (sourceOpts.crawlProvider ?? this.config.crawlProvider);
      if (provider !== "local") validateCrawlProvider(provider);
      const limits = { ...DEFAULT_LIMITS, ...(source.kind === "url" ? { maxPages: this.config.maxPages, maxDepth: this.config.maxDepth, maxTotalBytes: this.config.maxTotalMb * BYTES_PER_MB } : {}), ...sourceOpts.crawl };
      const downloadedAt = nowIso();
      const artifacts: { kind: "screenshot" | "pdf"; bytes: Uint8Array }[] = [];
      const collectLog: CollectLog = (level, text) => this.logs.append(sourceId, text, "system", level);
      if (provider !== "local") this.logs.append(sourceId, `Collecting with ${this.describeProvider(provider as CrawlProvider)}`);
      const raw: RawDoc[] = source.kind === "local" ? collectLocal(source.locator, limits, collectLog, ignore) : await this.collectUrl(source.locator, limits, opts, provider as CrawlProvider, sourceOpts.crawl4ai, artifacts, collectLog, ignore);
      raw.sort((a, b) => a.path.localeCompare(b.path));
      const docHashes = raw.map((d) => ({ d, rawSha: sha256(d.bytes) }));
      const snapshotHash = sha256([...docHashes.map((x) => `${x.d.path}\0${x.rawSha}`), ...artifacts.map((a) => `artifact:${a.kind}\0${sha256(a.bytes)}`)].join("\n"));
      const active = source.active_generation ? this.getGeneration(source.active_generation) : null;
      const graphEnabled = opts.graph !== false && this.config.graph !== null;
      // With every document left out there is nothing to extract, so the graph is skipped, not failed.
      const graphWanted = graphEnabled && raw.some((d) => inGraph(d.path));
      // As the user wrote them: RegExp.source escapes slashes.
      const graphIgnorePatterns = validateIgnorePatterns(sourceOpts.graphIgnore ?? [], "graphIgnore");
      if (
        !opts.force &&
        active?.snapshot_hash === snapshotHash &&
        (JSON.parse(active.stats) as { pipeline?: number }).pipeline === PIPELINE_VERSION &&
        (JSON.parse(active.stats) as { collector?: string }).collector === provider &&
        (active.graph_status === "ok" || !graphWanted) &&
        // The same documents with another graphIgnore list need a new graph.
        (!graphEnabled || JSON.stringify((JSON.parse(active.stats) as { graphIgnore?: string[] }).graphIgnore ?? []) === JSON.stringify(graphIgnorePatterns)) &&
        active.embedding_model === embeddingIdentity(this.config)
      ) {
        this.db.transaction(() => {
          this.db.run("DELETE FROM generations WHERE id = ?", [genId]);
        })();
        this.releaseLock(sourceId);
        this.logs.append(sourceId, `Unchanged: serving generation ${active.id}`);
        return { sourceId, generationId: active.id, status: "unchanged", stats: JSON.parse(active.stats) };
      }

      await checkpoint("normalize", `${raw.length} documents`);
      mkdirSync(snapshotDir, { recursive: true });
      for (const artifact of artifacts) {
        const dir = join(snapshotDir, "artifacts");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, artifact.kind === "pdf" ? "page.pdf" : "screenshot.png"), artifact.bytes);
      }
      const normalizedDocs: { path: string; markdown: string; docId: number; passages: { rowid: number; text: string; headingPath: string[] }[] }[] = [];
      let passageCount = 0;
      using insertDoc = this.db.prepare(
        "INSERT INTO documents (generation_id, path, url, title, kind, raw_file, raw_sha256, normalized_file, normalized_sha256, lines_match_raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      using insertPassage = this.db.prepare(
        "INSERT INTO passages (id, generation_id, document_id, ord, heading_path, anchor, start_line, end_line, text, content_sha256, tokens, has_code, has_warning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      using insertFts = this.db.prepare("INSERT INTO passages_fts (rowid, heading, body, symbols) VALUES (?, ?, ?, ?)");
      const fileNames = snapshotNames(docHashes.map((x) => x.d.path));
      for (const [i, { d, rawSha }] of docHashes.entries()) {
        const text = new TextDecoder().decode(d.bytes);
        const norm = normalize(text, d.kind);
        const rawPath = join(snapshotDir, "raw", fileNames[i]!);
        const normPath = join(snapshotDir, "normalized", fileNames[i]! + ".md");
        mkdirSync(dirname(rawPath), { recursive: true });
        mkdirSync(dirname(normPath), { recursive: true });
        // Raw Markdown stays plain: its citations give raw line numbers a reader can open.
        const rawFile = writeSnapshotFile(rawPath, d.bytes, d.kind === "html");
        const normFile = writeSnapshotFile(normPath, norm.markdown, true);
        const chunks = chunk(norm.markdown, norm.anchors);
        const entry = { path: d.path, markdown: norm.markdown, docId: 0, passages: [] as { rowid: number; text: string; headingPath: string[] }[] };
        this.db.transaction(() => {
          entry.docId = Number(
            insertDoc.run(genId, d.path, d.url, norm.title, d.kind, rawFile, rawSha, normFile, sha256(norm.markdown), norm.linesMatchRaw && !d.extracted ? 1 : 0).lastInsertRowid,
          );
          chunks.forEach((c, ord) => {
            const contentSha = sha256(c.text);
            // Generation id is part of the hash, so an id never names content from another snapshot.
            const id = "p_" + sha256(`${sourceId}\0${genId}\0${snapshotHash}\0${d.path}\0${c.startLine}\0${c.endLine}\0${contentSha}`).slice(0, 20);
            const rowid = Number(
              insertPassage.run(id, genId, entry.docId, ord, JSON.stringify(c.headingPath), c.anchor, c.startLine, c.endLine, c.text, contentSha, countTokens(c.text), c.hasCode ? 1 : 0, c.hasWarning ? 1 : 0)
                .lastInsertRowid,
            );
            const heading = [norm.title ?? "", ...c.headingPath].join(" > ");
            insertFts.run(rowid, heading, c.text, extractSymbols(heading + "\n" + c.text).join(" "));
            entry.passages.push({ rowid, text: c.text, headingPath: c.headingPath });
          });
        })();
        passageCount += chunks.length;
        normalizedDocs.push(entry);
      }
      if (!passageCount) throw new DocifyError("empty", "no passages produced from the source documents");

      await checkpoint("embed", `0/${passageCount}`);
      this.logs.append(sourceId, `Embedding with ${embeddingIdentity(this.config)}`);
      const all = normalizedDocs.flatMap((d) => d.passages.map((p) => ({ ...p, title: d.path })));
      using insertVec = this.db.prepare("INSERT INTO vectors (passage_rowid, generation_id, embedding) VALUES (?, ?, ?)");
      const embedStart = performance.now();
      // The embedding input is the heading path plus the text, so a vector is reused only when both match
      // and it came from a finished generation of the same provider, model and size.
      const reused = this.db.transaction(() => this.reuseVectors(genId)).immediate();
      const todo = all.filter((p) => !reused.has(p.rowid));
      if (reused.size) this.logs.append(sourceId, `Reused ${reused.size} of ${all.length} embeddings from earlier generations`);
      await checkpoint("embed", `${reused.size}/${all.length}`);
      for (let i = 0; i < todo.length; i += 64) {
        const batch = todo.slice(i, i + 64);
        const vecs = await embedTexts(
          this.config,
          batch.map((p) => [p.headingPath.join(" > "), p.text].filter(Boolean).join("\n")),
          "",
          opts.signal,
        ).catch((err) => {
          if (opts.signal?.aborted) throw new DocifyError("cancelled", "preparation cancelled");
          throw err;
        });
        this.db.transaction(() => vecs.forEach((v, j) => insertVec.run(batch[j]!.rowid, genId, new Uint8Array(v.buffer))))();
        await checkpoint("embed", `${reused.size + Math.min(i + 64, todo.length)}/${all.length}`);
      }
      const embedMs = Math.round(performance.now() - embedStart);
      const embedReused = reused.size;
      this.checkCounts(genId, passageCount);

      const base = { pipeline: PIPELINE_VERSION, collector: provider, documents: raw.length, passages: passageCount, embedMs, embedReused, artifacts: artifacts.map((a) => a.kind) };
      // From here on only the graph can fail, so a failure keeps the indexed snapshot for a graph-only retry.
      if (graphWanted) resume = { downloadedAt, snapshotHash, embedding: embeddingIdentity(this.config), dims: this.config.embeddingDims, base };
      result = await this.finishWithGraph({ sourceId, genId, snapshotDir, docs: normalizedDocs, opts, checkpoint, base, downloadedAt, snapshotHash, graphEnabled });
    } catch (err) {
      this.failGeneration(sourceId, genId, snapshotDir, err, opts, resume);
      throw err;
    }
    this.afterActivation(sourceId, genId);
    return result;
  }

  // Graph, validation and activation: the shared tail of a full prepare and a graph-only retry.
  private async finishWithGraph(c: {
    sourceId: string;
    genId: number;
    snapshotDir: string;
    docs: GraphDoc[];
    opts: PrepareOptions;
    checkpoint: (phase: string, progress?: string) => Promise<void>;
    base: GraphResume["base"];
    downloadedAt: string;
    snapshotHash: string;
    graphEnabled: boolean;
  }): Promise<PrepareResult> {
    const { sourceId, genId, snapshotDir, opts } = c;
    const sourceOpts = JSON.parse(this.requireSource(sourceId).options) as { graphIgnore?: string[] };
    const graphIgnore = compileIgnore(sourceOpts.graphIgnore, "graphIgnore");
    const graphIgnorePatterns = validateIgnorePatterns(sourceOpts.graphIgnore ?? [], "graphIgnore");
    let graphStatus = "skipped";
    let graphStats: Record<string, unknown> = {};
    const graphDocs = c.docs.filter((d) => !graphIgnore.some((pattern) => pattern.test(d.path)));
    const graphIgnored = c.docs.length - graphDocs.length;
    if (c.graphEnabled && graphIgnored) {
      this.logs.append(sourceId, graphDocs.length
        ? `Left ${graphIgnored} documents out of the graph (graphIgnore)`
        : `Every document matches graphIgnore; no graph is built`, "system", graphDocs.length ? "info" : "warn");
    }
    if (c.graphEnabled && graphDocs.length) {
      await c.checkpoint("graph", "semantic extraction");
      const runner = opts.graphRunner ?? runGraphify;
      const result = await runner(this.config, sourceId, graphDocs.map((d) => ({ path: d.path, markdown: d.markdown })), opts.signal, opts.force,
        (stream, text) => this.logs.append(sourceId, text, stream, /\b(error|failed|traceback)\b/i.test(text) ? "error" : /\bwarn(?:ing)?\b/i.test(text) ? "warn" : "info"));
      writeFileSync(join(snapshotDir, "graph.json"), result.graphJsonText);
      // Only documents sent to the graph can be missing from it.
      graphStats = this.importGraph(genId, result, graphDocs);
      if (graphStats.graphDropped) this.logs.append(sourceId, `Skipped ${graphStats.graphDropped} malformed graph records (no usable id, label or relation)`, "system", "warn");
      // Partial still activates and is searchable; it never counts as unchanged, so the next prepare retries the gaps.
      graphStatus = (graphStats.graphMissing as string[]).length || result.incomplete.length ? "partial" : "ok";
      if (graphStatus === "partial") this.logs.append(sourceId, `Graph is partial: ${(graphStats.graphMissing as string[]).length} documents without nodes`, "system", "warn");
    }

    await c.checkpoint("validate");
    this.checkCounts(genId, c.base.passages);
    if (graphStatus !== "skipped" && !(graphStats.groundedNodes as number)) {
      throw new DocifyError("invalid_generation", "graph extraction produced no nodes grounded in passages");
    }
    const stats = { ...c.base, ...graphStats, ...(c.graphEnabled && graphIgnorePatterns.length ? { graphIgnore: graphIgnorePatterns, graphIgnored } : {}) };

    await c.checkpoint("activate");
    this.db
      .transaction(() => {
        const prev = this.requireSource(sourceId).active_generation;
        if (prev) this.db.run("UPDATE generations SET status = 'superseded' WHERE id = ?", [prev]);
        this.db.run(
          `UPDATE generations SET status = 'active', phase = 'done', progress = '', error = NULL, finished_at = ?, downloaded_at = ?, snapshot_hash = ?,
           snapshot_dir = ?, embedding_model = ?, embedding_dims = ?, graph_status = ?, stats = ? WHERE id = ?`,
          [nowIso(), c.downloadedAt, c.snapshotHash, snapshotDir, embeddingIdentity(this.config), this.config.embeddingDims, graphStatus, JSON.stringify(stats), genId],
        );
        this.db.run("UPDATE sources SET active_generation = ? WHERE id = ?", [genId, sourceId]);
      })
      .immediate();
    this.releaseLock(sourceId);
    this.logs.append(sourceId, `Generation ${genId} activated: ${c.base.documents} documents, ${c.base.passages} passages`);
    return { sourceId, generationId: genId, status: "activated", stats };
  }

  private checkCounts(genId: number, passageCount: number) {
    const counts = this.db
      .query<{ p: number; v: number }, [number, number]>(
        "SELECT (SELECT count(*) FROM passages WHERE generation_id = ?) AS p, (SELECT count(*) FROM vectors WHERE generation_id = ?) AS v",
      )
      .get(genId, genId)!;
    if (counts.p !== passageCount || counts.v !== passageCount) {
      throw new DocifyError("invalid_generation", `validation failed: ${counts.p} passages, ${counts.v} vectors, expected ${passageCount}`);
    }
  }

  // With resume, the generation keeps its documents, passages, vectors and snapshot (not its graph),
  // so `prepare --graph-only` can retry the graph. Without it everything goes, as before.
  private failGeneration(sourceId: string, genId: number, snapshotDir: string, err: unknown, opts: PrepareOptions, resume: GraphResume | null) {
    const message = err instanceof Error ? err.message : String(err);
    const cancelled = opts.signal?.aborted || (err instanceof DocifyError && err.code === "cancelled");
    this.logs.append(sourceId, `${cancelled ? "Preparation cancelled" : "Preparation failed"}: ${message}`, "system", cancelled ? "warn" : "error");
    this.db.transaction(() => {
      if (resume) this.deleteGraphRows(genId);
      else this.deleteGenerationRows(genId);
      this.db.run("UPDATE generations SET status = 'failed', error = ?, finished_at = ?, stats = ?, snapshot_dir = ? WHERE id = ?", [
        message.slice(0, 2000),
        nowIso(),
        JSON.stringify(resume ? { resume } : {}),
        resume ? snapshotDir : null,
        genId,
      ]);
    })();
    if (resume) {
      rmSync(join(snapshotDir, "graph.json"), { force: true });
      this.logs.append(sourceId, `Generation ${genId} keeps its index; run prepare --graph-only to retry the graph without collecting again`, "system", "info");
    } else {
      rmSync(snapshotDir, { recursive: true, force: true });
    }
    this.releaseLock(sourceId);
    try {
      this.pruneResumable(sourceId);
    } catch (pruneErr) {
      this.logs.append(sourceId, `cleanup of earlier failed generations failed: ${pruneErr instanceof Error ? pruneErr.message : pruneErr}`, "system", "warn");
    }
  }

  // Outside the prepare try: cleanup of old generations must never undo a committed activation.
  private afterActivation(sourceId: string, genId: number) {
    try {
      // Failed generations older than the new active one can no longer be retried.
      this.pruneResumable(sourceId);
      this.collectGarbage(sourceId);
    } catch (err) {
      const message = `cleanup of old generations failed; generation ${genId} stays active: ${err instanceof Error ? err.message : err}`;
      this.logs.append(sourceId, message, "system", "warn");
      console.error(`docify: ${sourceId}: ${message}`);
    }
  }

  // The failed generation a graph-only retry would use: the newest one with a saved index that is
  // newer than the active generation. Older ones are pruned, so there is at most one.
  resumableGeneration(sourceId: string): GenerationRow | null {
    const active = this.requireSource(sourceId).active_generation ?? 0;
    const gen = this.db
      .query<GenerationRow, [string, number]>("SELECT * FROM generations WHERE source_id = ? AND status = 'failed' AND id > ? AND json_extract(stats, '$.resume') IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get(sourceId, active);
    return gen && graphResumeOf(gen) ? gen : null;
  }

  private async retryGraph(source: SourceRow, opts: PrepareOptions): Promise<PrepareResult> {
    const sourceId = source.id;
    if (opts.graph === false) throw new DocifyError("invalid_input", "--graph-only and --no-graph cannot be combined");
    const gen = this.resumableGeneration(sourceId);
    const fail = (message: string): never => {
      this.releaseLock(sourceId);
      throw new DocifyError("not_resumable", message);
    };
    if (!gen) return fail(`${sourceId} has no failed graph to retry; run a full prepare`);
    const resume = graphResumeOf(gen)!;
    if (this.config.graph === null) return fail("no graph provider is configured");
    if (resume.base.pipeline !== PIPELINE_VERSION) return fail(`generation ${gen.id} was indexed by an older pipeline; run a full prepare`);
    if (resume.embedding !== embeddingIdentity(this.config) || resume.dims !== this.config.embeddingDims) {
      return fail(`generation ${gen.id} was embedded with ${resume.embedding}, the configuration now uses ${embeddingIdentity(this.config)}; run a full prepare`);
    }
    // Built from home, never from the stored snapshot_dir.
    const snapshotDir = join(this.config.home, "snapshots", sourceId, String(gen.id));
    const genId = gen.id;
    this.db.run("UPDATE generations SET status = 'staging', phase = 'graph', progress = '', pid = ?, error = NULL, finished_at = NULL WHERE id = ?", [process.pid, genId]);
    this.logs.append(sourceId, `Retrying the graph of generation ${genId} from its saved snapshot`);
    const checkpoint = async (phase: string, progress = "") => {
      if (opts.signal?.aborted) throw new DocifyError("cancelled", "preparation cancelled");
      this.setPhase(genId, phase, progress);
      this.logs.append(sourceId, `Generation ${genId}: ${phase}${progress ? ` (${progress})` : ""}`);
      await opts.onPhase?.(phase, genId);
    };
    let result: PrepareResult;
    try {
      await checkpoint("load");
      const docs = this.loadGraphDocs(genId, snapshotDir);
      this.checkCounts(genId, resume.base.passages);
      result = await this.finishWithGraph({ sourceId, genId, snapshotDir, docs, opts, checkpoint, base: resume.base, downloadedAt: resume.downloadedAt, snapshotHash: resume.snapshotHash, graphEnabled: true });
    } catch (err) {
      // A snapshot that can no longer be read is not worth keeping for another retry.
      const keep = !(err instanceof DocifyError && (err.code === "invalid_generation" || err.code === "snapshot_missing")) || /grounded/.test(err.message);
      this.failGeneration(sourceId, genId, snapshotDir, err, opts, keep ? resume : null);
      throw err;
    }
    this.afterActivation(sourceId, genId);
    return result;
  }

  // Documents of a generation with their normalized markdown and passages, as the graph phase needs them.
  private loadGraphDocs(genId: number, snapshotDir: string): GraphDoc[] {
    const docs = this.db.query<{ id: number; path: string; normalized_file: string; normalized_sha256: string }, [number]>(
      "SELECT id, path, normalized_file, normalized_sha256 FROM documents WHERE generation_id = ? ORDER BY id",
    ).all(genId);
    const gen = this.getGeneration(genId)!;
    using passages = this.db.prepare<{ rowid: number; text: string; heading_path: string }, [number]>("SELECT rowid, text, heading_path FROM passages WHERE document_id = ? ORDER BY ord");
    return docs.map((d) => {
      const rel = gen.snapshot_dir ? snapshotRel(gen.snapshot_dir, d.normalized_file) : null;
      let content: Uint8Array | null = null;
      try {
        content = rel ? readSnapshotFile(join(snapshotDir, rel), d.normalized_sha256) : null;
      } catch {
        content = null;
      }
      if (!content) throw new DocifyError("snapshot_missing", `the saved snapshot of ${d.path} is missing or changed; run a full prepare`);
      return {
        path: d.path,
        markdown: new TextDecoder().decode(content),
        docId: d.id,
        passages: passages.all(d.id).map((p) => ({ rowid: p.rowid, text: p.text, headingPath: JSON.parse(p.heading_path) as string[] })),
      };
    });
  }

  // Drops the saved index of every failed generation except the one resumableGeneration() returns.
  private pruneResumable(sourceId: string) {
    const keep = this.resumableGeneration(sourceId)?.id;
    const stale = this.db
      .query<{ id: number }, [string]>("SELECT id FROM generations WHERE source_id = ? AND status = 'failed' AND json_extract(stats, '$.resume') IS NOT NULL")
      .all(sourceId)
      .filter((g) => g.id !== keep);
    for (const g of stale) {
      this.db.transaction(() => {
        this.deleteGenerationRows(g.id);
        this.db.run("UPDATE generations SET stats = '{}' WHERE id = ?", [g.id]);
      })();
      rmSync(join(this.config.home, "snapshots", sourceId, String(g.id)), { recursive: true, force: true });
    }
  }

  // Service origin only: the configured URL may carry a path or query worth keeping out of logs.
  private describeProvider(provider: CrawlProvider): string {
    const origin = (url: string) => { try { return new URL(url).origin; } catch { return "an invalid URL"; } };
    if (provider === "crawl4ai") return `Crawl4AI at ${origin(this.config.crawl4aiUrl)}`;
    if (provider === "browserless") return `Browserless at ${origin(this.config.browserlessUrl)}`;
    return "the built-in crawler";
  }

  // Remote providers never fall back to the built-in crawler.
  private async collectUrl(locator: string, limits: CrawlLimits, opts: PrepareOptions, provider: CrawlProvider, runOptions: Crawl4aiSourceOptions | undefined, artifacts: { kind: "screenshot" | "pdf"; bytes: Uint8Array }[], log: CollectLog, ignore: RegExp[]): Promise<RawDoc[]> {
    try {
      if (provider === "browserless") {
        const fetcher = browserlessFetcher({
          url: this.config.browserlessUrl,
          apiKey: process.env[this.config.browserlessApiKeyEnv] || undefined,
          timeoutMs: this.config.browserlessTimeoutSeconds * 1000,
          maxBytesPerPage: limits.maxBytesPerPage,
          signal: opts.signal,
        });
        return await crawl(locator, { ...limits, timeoutMs: this.config.browserlessTimeoutSeconds * 1000 }, fetcher, { signal: opts.signal, markdownExports: false, log, ignore });
      }
      if (provider === "crawl4ai") {
        const fetcher = crawl4aiFetcher({
          url: this.config.crawl4aiUrl,
          apiKey: process.env[this.config.crawl4aiApiKeyEnv] || undefined,
          apiKeyEnv: this.config.crawl4aiApiKeyEnv,
          timeoutMs: this.config.crawl4aiTimeoutSeconds * 1000,
          maxBytesPerPage: limits.maxBytesPerPage,
          signal: opts.signal,
          capture: (runOptions?.captureScreenshot || runOptions?.capturePdf) ? {
            startUrl: locator, screenshot: !!runOptions.captureScreenshot, pdf: !!runOptions.capturePdf, maxBytes: limits.maxBytesPerPage,
            onArtifacts: (result) => {
              if (result.screenshot) artifacts.push({ kind: "screenshot", bytes: result.screenshot });
              if (result.pdf) artifacts.push({ kind: "pdf", bytes: result.pdf });
            },
          } : undefined,
        }, runOptions);
        const docs = await crawl(locator, limits, fetcher, { signal: opts.signal, markdownExports: false, pdfFetcher: opts.fetcher ?? fetch, onAcceptedPage: (url) => fetcher.acceptPage(url), log, ignore });
        if ((runOptions?.captureScreenshot && !artifacts.some(a => a.kind === "screenshot")) || (runOptions?.capturePdf && !artifacts.some(a => a.kind === "pdf"))) {
          throw new Error("Crawl4AI did not capture the start page");
        }
        return docs;
      }
      if (provider !== "builtin") throw new DocifyError("invalid_config", `unknown crawlProvider: ${String(provider)}`);
      return await crawl(locator, limits, opts.fetcher, { signal: opts.signal, log, ignore });
    } catch (err) {
      if (opts.signal?.aborted) throw new DocifyError("cancelled", "preparation cancelled");
      throw err;
    }
  }

  private importGraph(genId: number, result: GraphRunResult, docs: { path: string; docId: number; passages: { rowid: number; text: string; headingPath: string[] }[] }[]) {
    const byPath = new Map(docs.map((d) => [d.path, d]));
    using insertNode = this.db.prepare(
      "INSERT OR IGNORE INTO graph_nodes (generation_id, node_id, label, norm_label, node_type, document_id) VALUES (?, ?, ?, ?, ?, ?)",
    );
    using insertEdge = this.db.prepare("INSERT INTO graph_edges (generation_id, src, dst, relation, confidence) VALUES (?, ?, ?, ?, ?)");
    using insertGround = this.db.prepare("INSERT OR IGNORE INTO node_passages (generation_id, node_id, passage_rowid) VALUES (?, ?, ?)");
    let grounded = 0;
    let nodes = 0;
    let edges = 0;
    // graph.json is model output that Graphify's raw mode does not validate: a record without
    // a usable id is skipped and counted, so it cannot fail the prepare (NOT NULL on graph_edges).
    let dropped = 0;
    const text = (v: unknown): v is string => typeof v === "string" && v !== "";
    const covered = new Set<string>();
    this.db.transaction(() => {
      for (const n of result.graph.nodes) {
        if (!n || !text(n.id) || !text(n.label)) {
          dropped++;
          continue;
        }
        nodes++;
        const path = text(n.source_file) ? result.fileToPath.get(n.source_file.split("/").pop()!) : undefined;
        const doc = path ? byPath.get(path) : undefined;
        if (doc) covered.add(doc.path);
        insertNode.run(genId, n.id, n.label, (text(n.norm_label) ? n.norm_label : n.label).toLowerCase(), text(n.file_type) ? n.file_type : null, doc?.docId ?? null);
        const pool = doc ? doc.passages : docs.flatMap((d) => d.passages);
        const terms = groundingTerms(n.label);
        const scored = pool
          .map((p) => {
            const text = p.text.toLowerCase();
            const head = p.headingPath.join(" ").toLowerCase().replace(/`/g, "");
            let score = 0;
            for (const t of terms) {
              const hits = text.split(t).length - 1;
              score += Math.min(hits, 5) + (head.includes(t.replace(/^\./, "")) ? 5 : 0);
            }
            return { p, score };
          })
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3);
        for (const s of scored) insertGround.run(genId, n.id, s.p.rowid);
        if (scored.length) grounded++;
      }
      for (const e of result.graph.links) {
        if (!e || !text(e.source) || !text(e.target) || !text(e.relation)) {
          dropped++;
          continue;
        }
        insertEdge.run(genId, e.source, e.target, e.relation, text(e.confidence) ? e.confidence : null);
        edges++;
      }
      for (const h of result.graph.hyperedges ?? []) {
        if (!h || !text(h.label) || !Array.isArray(h.nodes)) {
          dropped++;
          continue;
        }
        const members = h.nodes.filter(text);
        dropped += h.nodes.length - members.length;
        const [hub, ...rest] = members;
        for (const m of rest) {
          insertEdge.run(genId, hub!, m, `group:${h.label}`, "HYPEREDGE");
          edges++;
        }
      }
    })();
    return {
      graphNodes: nodes,
      groundedNodes: grounded,
      graphEdges: edges,
      graphDropped: dropped,
      graphMs: result.durationMs,
      graphTokensIn: result.tokensIn,
      graphTokensOut: result.tokensOut,
      graphCostEstimate: result.costEstimate,
      graphModel: this.config.graph?.model ?? null,
      // Documents no node maps to; a non-empty list makes the graph partial.
      graphMissing: docs.filter((d) => !covered.has(d.path)).map((d) => d.path),
      graphWarnings: result.incomplete,
    };
  }

  // Copies vectors for passages of genId whose text and heading path were already embedded by a finished
  // generation (any source) with the current embedding identity. Returns the passage rowids now covered.
  private reuseVectors(genId: number): Set<number> {
    const dims = this.config.embeddingDims;
    this.db.run(
      `INSERT INTO vectors (passage_rowid, generation_id, embedding)
       SELECT rowid, ?, e FROM (
         SELECT p.rowid AS rowid, (
           SELECT v.embedding FROM passages o
           JOIN vectors v ON v.passage_rowid = o.rowid
           JOIN generations g ON g.id = o.generation_id
           WHERE o.content_sha256 = p.content_sha256 AND o.heading_path = p.heading_path
             AND g.status IN ('active', 'superseded') AND g.embedding_model = ? AND g.embedding_dims = ?
             AND length(v.embedding) = ?
           LIMIT 1
         ) AS e
         FROM passages p WHERE p.generation_id = ?
       ) WHERE e IS NOT NULL`,
      [genId, embeddingIdentity(this.config), dims, dims * 4, genId],
    );
    const rows = this.db.query<{ r: number }, [number]>("SELECT passage_rowid AS r FROM vectors WHERE generation_id = ?").all(genId);
    return new Set(rows.map((x) => x.r));
  }

  private deleteGraphRows(genId: number) {
    this.db.run("DELETE FROM node_passages WHERE generation_id = ?", [genId]);
    this.db.run("DELETE FROM graph_edges WHERE generation_id = ?", [genId]);
    this.db.run("DELETE FROM graph_nodes WHERE generation_id = ?", [genId]);
  }

  private deleteGenerationRows(genId: number) {
    this.db.run("DELETE FROM passages_fts WHERE rowid IN (SELECT rowid FROM passages WHERE generation_id = ?)", [genId]);
    this.db.run("DELETE FROM vectors WHERE generation_id = ?", [genId]);
    this.db.run("DELETE FROM node_passages WHERE generation_id = ?", [genId]);
    this.db.run("DELETE FROM graph_edges WHERE generation_id = ?", [genId]);
    this.db.run("DELETE FROM graph_nodes WHERE generation_id = ?", [genId]);
    this.db.run("DELETE FROM passages WHERE generation_id = ?", [genId]);
    this.db.run("DELETE FROM documents WHERE generation_id = ?", [genId]);
  }

  // Keeps the active generation plus the newest superseded ones, so recent passage ids stay readable.
  private collectGarbage(sourceId: string) {
    const superseded = this.db
      .query<{ id: number }, [string]>("SELECT id FROM generations WHERE source_id = ? AND status = 'superseded' ORDER BY id DESC")
      .all(sourceId);
    for (const g of superseded.slice(Math.max(0, this.config.keepGenerations - 1))) {
      this.db.transaction(() => {
        this.deleteGenerationRows(g.id);
        this.db.run("DELETE FROM generations WHERE id = ?", [g.id]);
      })();
      // Built from home, not the stored snapshot_dir, so a moved store never deletes at its old path.
      rmSync(join(this.config.home, "snapshots", sourceId, String(g.id)), { recursive: true, force: true });
    }
    const failed = this.db.query<{ id: number }, [string]>("SELECT id FROM generations WHERE source_id = ? AND status = 'failed' ORDER BY id DESC").all(sourceId);
    for (const g of failed.slice(3)) this.db.run("DELETE FROM generations WHERE id = ?", [g.id]);
  }

  getGeneration(id: number): GenerationRow | null {
    return this.db.query<GenerationRow, [number]>("SELECT * FROM generations WHERE id = ?").get(id);
  }

  // ---- project pins --------------------------------------------------------

  // The nearest .docify.json at or above projectDir; that is the file whose pins apply.
  static pinFile(projectDir: string): string | null {
    let dir = resolve(projectDir);
    for (;;) {
      const file = join(dir, ".docify.json");
      if (existsSync(file)) return file;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  static readPins(projectDir: string | undefined): Record<string, string> {
    if (!projectDir) return {};
    const file = Docify.pinFile(projectDir);
    return file ? (readPinFile(file).pins ?? {}) : {};
  }

  // `docify pin`: always ./.docify.json in projectDir.
  static writePin(projectDir: string, library: string, version: string | null) {
    const file = join(resolve(projectDir), ".docify.json");
    writePinFile(file, library, version);
    return file;
  }

  // Web UI: edits the file that readPins uses, or creates one in projectDir.
  static setPin(projectDir: string, library: string, version: string | null) {
    const file = Docify.pinFile(projectDir) ?? join(resolve(projectDir), ".docify.json");
    writePinFile(file, library, version);
    return { file, pins: Docify.readPins(projectDir) };
  }
}

function readPinFile(file: string): { pins?: Record<string, string> } & Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new DocifyError("invalid_input", `${file} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new DocifyError("invalid_input", `${file} is not a JSON object`);
  return parsed as { pins?: Record<string, string> };
}

function writePinFile(file: string, library: string, version: string | null) {
  const lib = library.trim().toLowerCase();
  if (!LIBRARY_RE.test(lib)) throw new DocifyError("invalid_input", `invalid library name: ${library}`);
  const ver = version?.trim() || null;
  if (ver && !VERSION_RE.test(ver)) throw new DocifyError("invalid_input", `invalid version: ${ver}`);
  const current = existsSync(file) ? readPinFile(file) : {};
  const pins = { ...(current.pins ?? {}) };
  if (ver) pins[lib] = ver;
  else delete pins[lib];
  writeFileSync(file, JSON.stringify({ ...current, pins }, null, 2) + "\n");
}

function safeRel(path: string): string {
  const parts = path.split(/[\\/]+/).filter((p) => p && p !== "." && p !== "..");
  return parts.join("/") || "index";
}

// File names under raw/ and normalized/, one per path, in order. A name mirrors its path and gets
// a "~n" suffix only when it would sit on a directory another path needs or on another document's file.
// On disk the raw file is the name or the name plus ".gz", and the normalized copy the name plus ".md.gz".
function snapshotNames(paths: string[]): string[] {
  const rels = paths.map(safeRel);
  // Compared in lower case so names also stay apart on a case-insensitive file system.
  const key = (name: string) => name.toLowerCase();
  const dirs = new Set<string>();
  for (const rel of rels) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(key(parts.slice(0, i).join("/")));
  }
  const used = new Set<string>();
  // Every form a name can take on disk must stay off directories and off other documents' files.
  const taken = (name: string) => [name, name + ".gz"].some((file) => used.has(key(file))) || [name, name + ".gz", name + ".md.gz"].some((file) => dirs.has(key(file)));
  return rels.map((rel) => {
    let name = rel;
    for (let n = 1; taken(name); n++) name = `${rel}~${n}`;
    used.add(key(name)).add(key(name + ".gz"));
    return name;
  });
}

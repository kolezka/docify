import type { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { openDb, nowIso, SCHEMA_VERSION } from "./db.ts";
import { loadConfig, saveConfig, type DocifyConfig } from "./config.ts";
import { collectLocal, crawl, DEFAULT_LIMITS, type CrawlLimits, type Fetcher, type RawDoc } from "./collect.ts";
import { normalize } from "./normalize.ts";
import { chunk } from "./chunk.ts";
import { countTokens } from "./tokens.ts";
import { sha256 } from "./hash.ts";
import { embedTexts, embeddingIdentity } from "./embed.ts";
import { groundingTerms, runGraphify, type GraphRunResult } from "./graph.ts";
import { extractSymbols } from "./symbols.ts";

export type SourceKind = "local" | "url";

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

export interface AddSourceInput {
  library: string;
  version?: string | null;
  kind: SourceKind;
  locator: string;
  id?: string;
  crawl?: Partial<CrawlLimits>;
}

export interface PrepareOptions {
  graph?: boolean; // default true; false records graph_status = skipped
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

export class DocifyError extends Error {
  constructor(
    public code: string,
    message: string,
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

export class Docify {
  readonly db: Database;
  private current: DocifyConfig;
  private readonly overrides: Partial<DocifyConfig>;

  constructor(config: Partial<DocifyConfig> & { home?: string } = {}) {
    const base = loadConfig(config.home);
    this.overrides = config;
    this.current = { ...base, ...config };
    this.db = openDb(this.current.home);
  }

  get config(): DocifyConfig {
    return this.current;
  }

  close() {
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
      [id, library, version, input.kind, locator, JSON.stringify({ crawl: input.crawl ?? {} }), nowIso()],
    );
    return this.getSource(id)!;
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
  recoverInterrupted(): number {
    let n = 0;
    const candidates = this.db.query<{ id: number; source_id: string }, []>("SELECT id, source_id FROM generations WHERE status = 'staging'").all();
    for (const c of candidates) {
      const recovered = this.db
        .transaction(() => {
          const g = this.db.query<{ pid: number | null; status: string }, [number]>("SELECT pid, status FROM generations WHERE id = ?").get(c.id);
          const s = this.getSource(c.source_id);
          if (!g || g.status !== "staging") return false;
          if (s && s.lock_pid === g.pid && leaseAlive(s.lock_pid, s.lock_at)) return false;
          this.deleteGenerationRows(c.id);
          this.db.run("UPDATE generations SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", [
            "interrupted: the preparing process exited before activation",
            nowIso(),
            c.id,
          ]);
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

  private releaseLock(sourceId: string) {
    this.db.run("UPDATE sources SET lock_pid = NULL, lock_at = NULL WHERE id = ? AND lock_pid = ?", [sourceId, process.pid]);
  }

  private setPhase(genId: number, phase: string, progress = "") {
    this.db.run("UPDATE generations SET phase = ?, progress = ? WHERE id = ?", [phase, progress, genId]);
  }

  async prepare(sourceId: string, opts: PrepareOptions = {}): Promise<PrepareResult> {
    this.recoverInterrupted();
    const source = this.requireSource(sourceId);
    this.acquireLock(sourceId);
    const heartbeat = setInterval(() => {
      this.db.run("UPDATE sources SET lock_at = ? WHERE id = ? AND lock_pid = ?", [nowIso(), sourceId, process.pid]);
    }, HEARTBEAT_MS);
    try {
      return await this.prepareLocked(source, opts);
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
    const checkpoint = async (phase: string, progress = "") => {
      if (opts.signal?.aborted) throw new DocifyError("cancelled", "preparation cancelled");
      this.setPhase(genId, phase, progress);
      await opts.onPhase?.(phase, genId);
    };
    try {
      await checkpoint("collect");
      const sourceOpts = JSON.parse(source.options) as { crawl?: Partial<CrawlLimits> };
      const limits = { ...DEFAULT_LIMITS, ...sourceOpts.crawl };
      const downloadedAt = nowIso();
      const raw: RawDoc[] = source.kind === "local" ? collectLocal(source.locator, limits) : await crawl(source.locator, limits, opts.fetcher);
      raw.sort((a, b) => a.path.localeCompare(b.path));
      const docHashes = raw.map((d) => ({ d, rawSha: sha256(d.bytes) }));
      const snapshotHash = sha256(docHashes.map((x) => `${x.d.path}\0${x.rawSha}`).join("\n"));
      const active = source.active_generation ? this.getGeneration(source.active_generation) : null;
      const graphWanted = opts.graph !== false && this.config.graph !== null;
      if (
        !opts.force &&
        active?.snapshot_hash === snapshotHash &&
        (JSON.parse(active.stats) as { pipeline?: number }).pipeline === PIPELINE_VERSION &&
        (active.graph_status === "ok" || !graphWanted) &&
        active.embedding_model === embeddingIdentity(this.config)
      ) {
        this.db.transaction(() => {
          this.db.run("DELETE FROM generations WHERE id = ?", [genId]);
        })();
        this.releaseLock(sourceId);
        return { sourceId, generationId: active.id, status: "unchanged", stats: JSON.parse(active.stats) };
      }

      await checkpoint("normalize", `${raw.length} documents`);
      mkdirSync(snapshotDir, { recursive: true });
      const normalizedDocs: { path: string; markdown: string; docId: number; passages: { rowid: number; text: string; headingPath: string[] }[] }[] = [];
      let passageCount = 0;
      const insertDoc = this.db.prepare(
        "INSERT INTO documents (generation_id, path, url, title, kind, raw_file, raw_sha256, normalized_file, normalized_sha256, lines_match_raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const insertPassage = this.db.prepare(
        "INSERT INTO passages (id, generation_id, document_id, ord, heading_path, anchor, start_line, end_line, text, content_sha256, tokens, has_code, has_warning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const insertFts = this.db.prepare("INSERT INTO passages_fts (rowid, heading, body, symbols) VALUES (?, ?, ?, ?)");
      const fileNames = snapshotNames(docHashes.map((x) => x.d.path));
      for (const [i, { d, rawSha }] of docHashes.entries()) {
        const text = new TextDecoder().decode(d.bytes);
        const norm = normalize(text, d.kind);
        const rawFile = join(snapshotDir, "raw", fileNames[i]!);
        const normFile = join(snapshotDir, "normalized", fileNames[i]! + ".md");
        mkdirSync(dirname(rawFile), { recursive: true });
        mkdirSync(dirname(normFile), { recursive: true });
        writeFileSync(rawFile, d.bytes);
        writeFileSync(normFile, norm.markdown);
        const chunks = chunk(norm.markdown, norm.anchors);
        const entry = { path: d.path, markdown: norm.markdown, docId: 0, passages: [] as { rowid: number; text: string; headingPath: string[] }[] };
        this.db.transaction(() => {
          entry.docId = Number(
            insertDoc.run(genId, d.path, d.url, norm.title, d.kind, rawFile, rawSha, normFile, sha256(norm.markdown), norm.linesMatchRaw ? 1 : 0).lastInsertRowid,
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
      const all = normalizedDocs.flatMap((d) => d.passages.map((p) => ({ ...p, title: d.path })));
      const insertVec = this.db.prepare("INSERT INTO vectors (passage_rowid, generation_id, embedding) VALUES (?, ?, ?)");
      const embedStart = performance.now();
      for (let i = 0; i < all.length; i += 64) {
        const batch = all.slice(i, i + 64);
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
        await checkpoint("embed", `${Math.min(i + 64, all.length)}/${all.length}`);
      }
      const embedMs = Math.round(performance.now() - embedStart);

      let graphStatus = "skipped";
      let graphStats: Record<string, unknown> = {};
      if (graphWanted) {
        await checkpoint("graph", "semantic extraction");
        const runner = opts.graphRunner ?? runGraphify;
        const result = await runner(this.config, sourceId, normalizedDocs.map((d) => ({ path: d.path, markdown: d.markdown })), opts.signal, opts.force);
        writeFileSync(join(snapshotDir, "graph.json"), result.graphJsonText);
        graphStats = this.importGraph(genId, result, normalizedDocs);
        // Partial still activates and is searchable; it never counts as unchanged, so the next prepare retries the gaps.
        graphStatus = (graphStats.graphMissing as string[]).length || result.incomplete.length ? "partial" : "ok";
      }

      await checkpoint("validate");
      const counts = this.db
        .query<{ p: number; v: number }, [number, number]>(
          "SELECT (SELECT count(*) FROM passages WHERE generation_id = ?) AS p, (SELECT count(*) FROM vectors WHERE generation_id = ?) AS v",
        )
        .get(genId, genId)!;
      if (counts.p !== passageCount || counts.v !== passageCount) {
        throw new DocifyError("invalid_generation", `validation failed: ${counts.p} passages, ${counts.v} vectors, expected ${passageCount}`);
      }
      if (graphStatus !== "skipped" && !(graphStats.groundedNodes as number)) {
        throw new DocifyError("invalid_generation", "graph extraction produced no nodes grounded in passages");
      }
      const stats = { pipeline: PIPELINE_VERSION, documents: raw.length, passages: passageCount, embedMs, ...graphStats };

      await checkpoint("activate");
      this.db
        .transaction(() => {
          const prev = this.requireSource(sourceId).active_generation;
          if (prev) this.db.run("UPDATE generations SET status = 'superseded' WHERE id = ?", [prev]);
          this.db.run(
            `UPDATE generations SET status = 'active', phase = 'done', progress = '', finished_at = ?, downloaded_at = ?, snapshot_hash = ?,
             snapshot_dir = ?, embedding_model = ?, embedding_dims = ?, graph_status = ?, stats = ? WHERE id = ?`,
            [nowIso(), downloadedAt, snapshotHash, snapshotDir, embeddingIdentity(this.config), this.config.embeddingDims, graphStatus, JSON.stringify(stats), genId],
          );
          this.db.run("UPDATE sources SET active_generation = ? WHERE id = ?", [genId, sourceId]);
        })
        .immediate();
      this.releaseLock(sourceId);
      result = { sourceId, generationId: genId, status: "activated", stats };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.db.transaction(() => {
        this.deleteGenerationRows(genId);
        this.db.run("UPDATE generations SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", [message.slice(0, 2000), nowIso(), genId]);
      })();
      rmSync(snapshotDir, { recursive: true, force: true });
      this.releaseLock(sourceId);
      throw err;
    }
    // Outside the try: cleanup of old generations must never undo a committed activation.
    try {
      this.collectGarbage(sourceId);
    } catch (err) {
      console.error(`docify: cleanup of old generations for ${sourceId} failed; generation ${genId} stays active: ${err instanceof Error ? err.message : err}`);
    }
    return result;
  }

  private importGraph(genId: number, result: GraphRunResult, docs: { path: string; docId: number; passages: { rowid: number; text: string; headingPath: string[] }[] }[]) {
    const byPath = new Map(docs.map((d) => [d.path, d]));
    const insertNode = this.db.prepare(
      "INSERT OR IGNORE INTO graph_nodes (generation_id, node_id, label, norm_label, node_type, document_id) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insertEdge = this.db.prepare("INSERT INTO graph_edges (generation_id, src, dst, relation, confidence) VALUES (?, ?, ?, ?, ?)");
    const insertGround = this.db.prepare("INSERT OR IGNORE INTO node_passages (generation_id, node_id, passage_rowid) VALUES (?, ?, ?)");
    let grounded = 0;
    let edges = 0;
    const covered = new Set<string>();
    this.db.transaction(() => {
      for (const n of result.graph.nodes) {
        const path = n.source_file ? result.fileToPath.get(n.source_file.split("/").pop()!) : undefined;
        const doc = path ? byPath.get(path) : undefined;
        if (doc) covered.add(doc.path);
        insertNode.run(genId, n.id, n.label, (n.norm_label ?? n.label).toLowerCase(), n.file_type ?? null, doc?.docId ?? null);
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
        insertEdge.run(genId, e.source, e.target, e.relation, e.confidence ?? null);
        edges++;
      }
      for (const h of result.graph.hyperedges ?? []) {
        const [hub, ...rest] = h.nodes;
        for (const m of rest) {
          insertEdge.run(genId, hub!, m, `group:${h.label}`, "HYPEREDGE");
          edges++;
        }
      }
    })();
    return {
      graphNodes: result.graph.nodes.length,
      groundedNodes: grounded,
      graphEdges: edges,
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
  // The normalized copy adds ".md", so that name must stay off directories too.
  const taken = (name: string) => used.has(key(name)) || dirs.has(key(name)) || dirs.has(key(name + ".md"));
  return rels.map((rel) => {
    let name = rel;
    for (let n = 1; taken(name); n++) name = `${rel}~${n}`;
    used.add(key(name));
    return name;
  });
}

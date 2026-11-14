import { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { sha256 } from "./hash.ts";
import { SCHEMA_VERSION, nowIso } from "./db.ts";
import { Docify, DocifyError, PIPELINE_VERSION } from "./docify.ts";
import { ConfigError, EDITABLE_KEYS, configFilePath, legacyMaxTotalMb, readConfigFile, validateConfigPatch } from "./config.ts";
import { VERSION } from "../version.ts";

// A whole-store backup: docify.sqlite, config.json and the snapshot files of every active and
// superseded generation, in one gzipped tar with a manifest of sizes and SHA-256 sums.
// Models, the Graphify venv and logs stay out: they are per machine and `docify setup` remakes them.

export const BACKUP_FORMAT = "docify-store-backup";
export const BACKUP_FORMAT_VERSION = 1;
const MANIFEST = "docify-backup.json";
const DB_FILE = "docify.sqlite";
const CONFIG_FILE = "config.json";
// Keys that point at code Docify runs or loads. They belong to the machine, not the backup.
const MACHINE_KEYS = ["home", "graphifyBin", "modelsDir"];
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9._@-]{0,80}$/;

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  docifyVersion: string;
  schemaVersion: number;
  pipelineVersion: number;
  createdAt: string;
  sources: string[];
  files: Record<string, { size: number; sha256: string }>;
}

export interface ExportResult {
  bytes: Uint8Array<ArrayBuffer>;
  manifest: BackupManifest;
}

export interface ImportOptions {
  // Replace a store that already has sources. The old files are moved aside, never deleted.
  force?: boolean;
  // Keep this machine's config.json instead of the one in the backup.
  keepConfig?: boolean;
  // Called with each local source path; throw to refuse the import (the web UI's source roots).
  checkLocalSource?: (path: string) => void;
}

export interface ImportResult {
  sources: string[];
  createdAt: string;
  docifyVersion: string;
  movedAside: string | null;
  configReplaced: boolean;
  droppedConfigKeys: string[];
}

function walkFiles(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = lstatSync(join(root, rel));
    if (st.isDirectory()) out.push(...walkFiles(root, rel));
    else if (st.isFile()) out.push(rel);
    else throw new DocifyError("export_failed", `unexpected non-file in the snapshot directory: ${join(root, rel)}`);
  }
  return out;
}

// Snapshot file of a document, relative to its generation directory, from the stored absolute path.
function snapshotRel(snapshotDir: string, file: string): string | null {
  const rel = relative(snapshotDir, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

interface DocRow {
  generation_id: number;
  source_id: string;
  snapshot_dir: string | null;
  raw_file: string;
  raw_sha256: string;
  normalized_file: string;
  normalized_sha256: string;
}

const KEPT_DOCS_SQL = `SELECT d.generation_id, g.source_id, g.snapshot_dir, d.raw_file, d.raw_sha256, d.normalized_file, d.normalized_sha256
  FROM documents d JOIN generations g ON g.id = d.generation_id WHERE g.status IN ('active', 'superseded')`;

// Every document of a kept generation must have both snapshot files, with the hashes the DB recorded.
function checkDocuments(db: Database, files: Map<string, string>, what: string) {
  for (const d of db.query<DocRow, []>(KEPT_DOCS_SQL).all()) {
    for (const [file, sha] of [
      [d.raw_file, d.raw_sha256],
      [d.normalized_file, d.normalized_sha256],
    ] as const) {
      const rel = d.snapshot_dir ? snapshotRel(d.snapshot_dir, file) : null;
      const key = rel && `snapshots/${d.source_id}/${d.generation_id}/${rel}`;
      // raw_sha256 is over the raw bytes; normalized_sha256 over the text, which is the same for UTF-8.
      if (!key || files.get(key) !== sha) throw new DocifyError(what, `snapshot file missing or changed for generation ${d.generation_id}: ${rel ?? file}`);
    }
  }
}

export async function exportStore(docify: Docify): Promise<ExportResult> {
  const home = docify.config.home;
  return docify.withAllLeases(async () => {
    const work = mkdtempSync(join(tmpdir(), "docify-export-"));
    try {
      // VACUUM INTO writes one consistent, self-contained copy even while readers are active.
      const dbCopy = join(work, DB_FILE);
      docify.db.run("VACUUM INTO ?", [dbCopy]);
      const copy = new Database(dbCopy, { strict: true });
      const entries = new Map<string, Uint8Array>();
      let sources: string[];
      try {
        copy.run("UPDATE sources SET lock_pid = NULL, lock_at = NULL");
        // Only a source added after the leases were taken can have one; it never activated.
        copy.run("UPDATE generations SET status = 'failed', error = 'interrupted by export', finished_at = ? WHERE status = 'staging'", [nowIso()]);
        sources = copy.query<{ id: string }, []>("SELECT id FROM sources ORDER BY id").all().map((r) => r.id);
        const gens = copy.query<{ id: number; source_id: string }, []>("SELECT id, source_id FROM generations WHERE status IN ('active', 'superseded') ORDER BY id").all();
        for (const g of gens) {
          // Built from home, never from the stored snapshot_dir.
          const dir = join(home, "snapshots", g.source_id, String(g.id));
          if (!existsSync(dir)) throw new DocifyError("export_failed", `snapshot directory missing for ${g.source_id} generation ${g.id}: ${dir}`);
          for (const rel of walkFiles(dir)) entries.set(`snapshots/${g.source_id}/${g.id}/${rel}`, readFileSync(join(dir, rel)));
        }
        const hashes = new Map([...entries].map(([k, v]) => [k, sha256(v)]));
        checkDocuments(copy, hashes, "export_failed");
      } finally {
        copy.close();
      }
      entries.set(DB_FILE, readFileSync(dbCopy));
      const config = configFilePath(home);
      if (existsSync(config)) entries.set(CONFIG_FILE, readFileSync(config));
      const manifest: BackupManifest = {
        format: BACKUP_FORMAT,
        formatVersion: BACKUP_FORMAT_VERSION,
        docifyVersion: VERSION,
        schemaVersion: SCHEMA_VERSION,
        pipelineVersion: PIPELINE_VERSION,
        createdAt: nowIso(),
        sources,
        files: Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, { size: v.length, sha256: sha256(v) }])),
      };
      const archive = new Bun.Archive({ [MANIFEST]: JSON.stringify(manifest, null, 2) + "\n", ...Object.fromEntries(entries) }, { compress: "gzip" });
      return { bytes: await archive.bytes(), manifest };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
}

// Archive paths are untrusted: only the store layout, no empty, dot or dot-dot segments.
function safeEntryPath(path: string): boolean {
  if (path === DB_FILE || path === CONFIG_FILE) return true;
  const parts = path.split("/");
  if (parts.length < 4 || parts[0] !== "snapshots" || !SOURCE_ID_RE.test(parts[1]!) || !/^\d+$/.test(parts[2]!)) return false;
  return parts.every((p) => p !== "" && p !== "." && p !== ".." && !p.includes("\\") && !p.includes("\0"));
}

function parseManifest(text: string): BackupManifest {
  let m: BackupManifest;
  try {
    m = JSON.parse(text);
  } catch {
    throw new DocifyError("invalid_backup", "the backup manifest is not valid JSON");
  }
  if (m?.format !== BACKUP_FORMAT) throw new DocifyError("invalid_backup", "not a Docify store backup");
  if (m.formatVersion !== BACKUP_FORMAT_VERSION) throw new DocifyError("invalid_backup", `backup format ${m.formatVersion} is not supported by this build (${BACKUP_FORMAT_VERSION})`);
  if (m.schemaVersion !== SCHEMA_VERSION) {
    throw new DocifyError("invalid_backup", `backup has store schema ${m.schemaVersion}, this build needs ${SCHEMA_VERSION}; import it with Docify ${m.docifyVersion}`);
  }
  if (typeof m.files !== "object" || m.files === null || !m.files[DB_FILE]) throw new DocifyError("invalid_backup", "the backup has no database");
  return m;
}

// The imported config.json: the backup's settings, validated like the web UI's, with this
// machine's paths kept. A backup must never point Docify at code to run.
function mergeConfig(imported: Uint8Array | undefined, current: Record<string, unknown>): { text: string; dropped: string[] } {
  let parsed: Record<string, unknown> = {};
  if (imported) {
    try {
      parsed = JSON.parse(new TextDecoder().decode(imported));
    } catch {
      throw new DocifyError("invalid_backup", "config.json in the backup is not valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new DocifyError("invalid_backup", "config.json in the backup is not an object");
  }
  const dropped = MACHINE_KEYS.filter((k) => k in parsed);
  const editable = Object.fromEntries(Object.entries(parsed).filter(([k]) => (EDITABLE_KEYS as readonly string[]).includes(k)));
  try {
    validateConfigPatch(editable);
    legacyMaxTotalMb(parsed); // a backup made before maxTotalMb names the limit in bytes
  } catch (err) {
    if (err instanceof ConfigError) throw new DocifyError("invalid_backup", `config.json in the backup: ${err.message}`);
    throw err;
  }
  const next: Record<string, unknown> = Object.fromEntries(Object.entries(parsed).filter(([k]) => !MACHINE_KEYS.includes(k)));
  for (const k of MACHINE_KEYS) if (k in current) next[k] = current[k];
  return { text: JSON.stringify(next, null, 2) + "\n", dropped };
}

// Checks the staged database and points its stored snapshot paths at this store.
function prepareStagedDb(file: string, home: string, files: Map<string, string>, opts: ImportOptions): string[] {
  const db = new Database(file, { strict: true });
  try {
    const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0]!.integrity_check !== "ok") throw new DocifyError("invalid_backup", "the database in the backup is damaged");
    if (db.query("PRAGMA foreign_key_check").all().length) throw new DocifyError("invalid_backup", "the database in the backup has broken references");
    const schema = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (Number(schema?.value) !== SCHEMA_VERSION) throw new DocifyError("invalid_backup", `the database has schema ${schema?.value ?? "none"}, this build needs ${SCHEMA_VERSION}`);
    const sources = db.query<{ id: string; kind: string; locator: string }, []>("SELECT id, kind, locator FROM sources ORDER BY id").all();
    for (const s of sources) {
      if (!SOURCE_ID_RE.test(s.id)) throw new DocifyError("invalid_backup", `invalid source id in the backup: ${s.id}`);
      if (s.kind === "local") opts.checkLocalSource?.(s.locator);
    }
    checkDocuments(db, files, "invalid_backup");
    db.transaction(() => {
      db.run("UPDATE sources SET lock_pid = NULL, lock_at = NULL");
      db.run("UPDATE generations SET status = 'failed', error = 'interrupted before the backup was made', finished_at = ? WHERE status = 'staging'", [nowIso()]);
      // Stored paths are absolute on the machine that made the backup; rewrite them for this home.
      for (const g of db.query<{ id: number; source_id: string; snapshot_dir: string | null }, []>("SELECT id, source_id, snapshot_dir FROM generations").all()) {
        if (!g.snapshot_dir) continue;
        const dir = join(home, "snapshots", g.source_id, String(g.id));
        const docs = db.query<{ id: number; raw_file: string; normalized_file: string }, [number]>("SELECT id, raw_file, normalized_file FROM documents WHERE generation_id = ?").all(g.id);
        for (const d of docs) {
          const raw = snapshotRel(g.snapshot_dir, d.raw_file);
          const norm = snapshotRel(g.snapshot_dir, d.normalized_file);
          if (!raw || !norm) throw new DocifyError("invalid_backup", `document ${d.id} points outside its snapshot`);
          db.run("UPDATE documents SET raw_file = ?, normalized_file = ? WHERE id = ?", [join(dir, raw), join(dir, norm), d.id]);
        }
        db.run("UPDATE generations SET snapshot_dir = ? WHERE id = ?", [dir, g.id]);
      }
    })();
    return sources.map((s) => s.id);
  } finally {
    db.close();
  }
}

export async function importStore(docify: Docify, data: Uint8Array, opts: ImportOptions = {}): Promise<ImportResult> {
  const home = docify.config.home;
  let entries: Map<string, Blob>;
  try {
    entries = await new Bun.Archive(data).files();
  } catch (err) {
    throw new DocifyError("invalid_backup", `not a readable backup archive: ${err instanceof Error ? err.message : err}`);
  }
  const manifestBlob = entries.get(MANIFEST);
  if (!manifestBlob) throw new DocifyError("invalid_backup", "not a Docify store backup (no manifest)");
  const manifest = parseManifest(await manifestBlob.text());

  // Every file must be listed, safe and intact; nothing listed may be missing.
  const contents = new Map<string, Uint8Array>();
  const hashes = new Map<string, string>();
  for (const [path, blob] of entries) {
    if (path === MANIFEST) continue;
    const expected = manifest.files[path];
    if (!expected) throw new DocifyError("invalid_backup", `file not listed in the manifest: ${path}`);
    if (!safeEntryPath(path)) throw new DocifyError("invalid_backup", `unsafe path in the backup: ${path}`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const sum = sha256(bytes);
    if (bytes.length !== expected.size || sum !== expected.sha256) throw new DocifyError("invalid_backup", `file damaged in the backup: ${path}`);
    contents.set(path, bytes);
    hashes.set(path, sum);
  }
  for (const path of Object.keys(manifest.files)) if (!contents.has(path)) throw new DocifyError("invalid_backup", `file missing from the backup: ${path}`);

  // Staged next to home so the final moves are renames on one filesystem.
  mkdirSync(dirname(home), { recursive: true });
  const stage = mkdtempSync(join(dirname(home), `.${basename(home)}-import-`));
  try {
    for (const [path, bytes] of contents) {
      if (path === CONFIG_FILE) continue;
      const target = join(stage, ...path.split("/"));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { mode: 0o600 });
    }
    const sources = prepareStagedDb(join(stage, DB_FILE), home, hashes, opts);
    const current = existsSync(configFilePath(home)) ? readConfigFile(home) : {};
    let dropped: string[] = [];
    if (!opts.keepConfig) {
      const merged = mergeConfig(contents.get(CONFIG_FILE), current);
      writeFileSync(join(stage, CONFIG_FILE), merged.text, { mode: 0o600 });
      dropped = merged.dropped;
    }

    // The leases keep writers out during the swap; taking them fails if one is preparing now.
    const movedAside = await docify.withAllLeases(async () => {
      const existing = docify.listSourceRows().length;
      if (existing && !opts.force) {
        throw new DocifyError("exists", `the store at ${home} already has ${existing} source(s); import with --force to replace it (the current store is moved aside, not deleted)`);
      }
      const replaced = [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, "snapshots", ...(opts.keepConfig ? [] : [CONFIG_FILE])];
      // A store with nothing to lose (a fresh, empty database) is dropped, not kept aside.
      const snapshots = join(home, "snapshots");
      const keep = existing > 0 || (!opts.keepConfig && existsSync(configFilePath(home))) || (existsSync(snapshots) && readdirSync(snapshots).length > 0);
      const aside = keep ? `${home}.before-import-${nowIso().replace(/[:.]/g, "-")}` : join(stage, "previous");
      let result: string | null = null;
      docify.replaceStoreFiles(() => {
        const moved: string[] = [];
        const placed: string[] = [];
        try {
          for (const name of replaced) {
            if (!existsSync(join(home, name))) continue;
            mkdirSync(aside, { recursive: true, mode: 0o700 });
            renameSync(join(home, name), join(aside, name));
            moved.push(name);
          }
          for (const name of [DB_FILE, "snapshots", CONFIG_FILE]) {
            if (!existsSync(join(stage, name))) continue;
            renameSync(join(stage, name), join(home, name));
            placed.push(name);
          }
        } catch (err) {
          // Put the old store back exactly as it was.
          for (const name of placed) renameSync(join(home, name), join(stage, name));
          for (const name of moved) renameSync(join(aside, name), join(home, name));
          rmSync(aside, { recursive: true, force: true });
          throw err;
        }
        result = keep && moved.length ? aside : null;
      });
      return result as string | null;
    });
    docify.logs.append("docify", `Store imported from a backup made ${manifest.createdAt} by Docify ${manifest.docifyVersion}${movedAside ? `; the previous store is in ${movedAside}` : ""}`);
    return { sources, createdAt: manifest.createdAt, docifyVersion: manifest.docifyVersion, movedAside, configReplaced: !opts.keepConfig, droppedConfigKeys: dropped };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  library TEXT NOT NULL,
  version TEXT,                      -- NULL means the library version is unknown
  kind TEXT NOT NULL CHECK (kind IN ('local', 'url')),
  locator TEXT NOT NULL,             -- absolute path or start URL
  options TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  active_generation INTEGER,
  lock_pid INTEGER,
  lock_at TEXT
);

CREATE TABLE IF NOT EXISTS generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('staging', 'active', 'superseded', 'failed')),
  phase TEXT,
  progress TEXT,
  error TEXT,
  pid INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  downloaded_at TEXT,
  snapshot_hash TEXT,
  snapshot_dir TEXT,
  embedding_model TEXT,
  embedding_dims INTEGER,
  graph_status TEXT,
  stats TEXT NOT NULL DEFAULT '{}',
  schema_version INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS generations_source ON generations(source_id, id);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  path TEXT NOT NULL,                -- path relative to the source root, or URL path
  url TEXT,
  title TEXT,
  kind TEXT NOT NULL,
  raw_file TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL,
  normalized_file TEXT NOT NULL,
  normalized_sha256 TEXT NOT NULL,
  lines_match_raw INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS passages (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  heading_path TEXT NOT NULL,
  anchor TEXT,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  text TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  has_code INTEGER NOT NULL,
  has_warning INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS passages_doc ON passages(document_id, ord);
CREATE INDEX IF NOT EXISTS passages_gen ON passages(generation_id);

CREATE VIRTUAL TABLE IF NOT EXISTS passages_fts USING fts5(
  heading, body, symbols, content='', contentless_delete=1, tokenize = "unicode61 tokenchars '_'"
);

CREATE TABLE IF NOT EXISTS vectors (
  passage_rowid INTEGER PRIMARY KEY REFERENCES passages(rowid) ON DELETE CASCADE,
  generation_id INTEGER NOT NULL,
  embedding BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS vectors_gen ON vectors(generation_id);

CREATE TABLE IF NOT EXISTS graph_nodes (
  generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  label TEXT NOT NULL,
  norm_label TEXT NOT NULL,
  node_type TEXT,
  document_id INTEGER,
  PRIMARY KEY (generation_id, node_id)
);
CREATE TABLE IF NOT EXISTS graph_edges (
  generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  relation TEXT NOT NULL,
  confidence TEXT
);
CREATE INDEX IF NOT EXISTS graph_edges_src ON graph_edges(generation_id, src);
CREATE INDEX IF NOT EXISTS graph_edges_dst ON graph_edges(generation_id, dst);
CREATE TABLE IF NOT EXISTS node_passages (
  generation_id INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  passage_rowid INTEGER NOT NULL REFERENCES passages(rowid) ON DELETE CASCADE,
  PRIMARY KEY (generation_id, node_id, passage_rowid)
);
`;

export function openDb(home: string): Database {
  mkdirSync(home, { recursive: true });
  const db = new Database(join(home, "docify.sqlite"), { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 10000");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA synchronous = NORMAL");
  db.run(SCHEMA);
  const row = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (!row) db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
  else if (Number(row.value) !== SCHEMA_VERSION) {
    throw new Error(`Docify store schema ${row.value} does not match this build (${SCHEMA_VERSION}). Run a newer Docify or move ${home} aside.`);
  }
  return db;
}

export const nowIso = () => new Date().toISOString();

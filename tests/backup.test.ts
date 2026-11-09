import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Docify, DocifyError } from "../src/core/docify.ts";
import { exportStore, importStore } from "../src/core/backup.ts";
import { open, read, search } from "../src/core/search.ts";
import { fakeGraph, newDocify, tempDir, writeDocs } from "./helpers.ts";

// A local stand-in for an embedding server, so these tests need no model files.
const URL_ENV = "DOCIFY_TEST_BACKUP_EMBED_URL";
const KEY_ENV = "DOCIFY_TEST_BACKUP_EMBED_KEY";
const embedServer = Bun.serve({
  port: 0,
  async fetch(req) {
    const b = (await req.json()) as { model: string; input: string[] };
    return Response.json({ object: "list", model: b.model, data: b.input.map((t, index) => ({ object: "embedding", index, embedding: [t.length, 1, 2, 3] })) });
  },
});
const EMBED = { embeddingProvider: "openai", embeddingBaseUrlEnv: URL_ENV, embeddingApiKeyEnv: KEY_ENV, embeddingModel: "fake-embed", embeddingDims: 4, embeddingQueryPrefix: "" };
const store = (home: string) => newDocify(home, EMBED);

const guide = "# Guide\n\n## Install\n\nRun the installer with `widget.install()` once.\n\n## Usage\n\nCall the frobnicate function.\n";
const other = "# Other\n\n## Notes\n\nThe zanzibar option tunes caching.\n";

let srcHome: string;
let src: Docify;
let backup: Uint8Array;
const opened: Docify[] = [];
const fresh = (home = tempDir()) => {
  const d = store(home);
  opened.push(d);
  return d;
};

beforeAll(async () => {
  process.env[URL_ENV] = `http://127.0.0.1:${embedServer.port}`;
  process.env[KEY_ENV] = "sk-test";
  srcHome = tempDir();
  // A machine path in config.json must not travel; a normal setting must.
  writeFileSync(join(srcHome, "config.json"), JSON.stringify({ lexicalWeight: 0.7, graphifyBin: "/tmp/evil-graphify", modelsDir: "/tmp/evil-models", appNote: "kept" }));
  src = store(srcHome);
  src.addSource({ library: "lib", version: "1", kind: "local", locator: writeDocs(join(tempDir("docify-src-"), "lib"), { "guide.md": guide }) });
  src.addSource({ library: "other", version: "2", kind: "local", locator: writeDocs(join(tempDir("docify-src-"), "other"), { "other.md": other }) });
  await src.prepare("lib@1", { graphRunner: fakeGraph });
  await src.prepare("other@2", { graphRunner: fakeGraph });
  backup = (await exportStore(src)).bytes;
});
afterAll(() => {
  embedServer.stop(true);
  for (const d of [src, ...opened]) d.close();
});

async function rebuild(bytes: Uint8Array, change: (files: Map<string, Uint8Array>) => void): Promise<Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const [k, v] of await new Bun.Archive(bytes).files()) files.set(k, new Uint8Array(await v.arrayBuffer()));
  change(files);
  return new Bun.Archive(Object.fromEntries(files), { compress: "gzip" }).bytes();
}

async function rejects(p: Promise<unknown>, code: string, message: RegExp) {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(DocifyError);
  expect((err as DocifyError).code).toBe(code);
  expect((err as DocifyError).message).toMatch(message);
}

test("an exported store imports into an empty home and answers the same queries", async () => {
  const before = await search(src, { query: "frobnicate function", library: "lib" });
  expect(before.status).toBe("ok");

  const dstHome = tempDir();
  const dst = fresh(dstHome);
  const r = await importStore(dst, backup);
  expect(r.sources).toEqual(["lib@1", "other@2"]);
  expect(r.movedAside).toBeNull();

  const after = await search(dst, { query: "frobnicate function", library: "lib" });
  expect(after.status).toBe("ok");
  expect(after.hits.map((h) => h.id)).toEqual(before.hits.map((h) => h.id));
  const id = after.hits[0]!.id;
  // The text carries a per-response nonce and the snapshot path, so compare the passage itself.
  const passage = (d: Docify) => d.db.query<{ text: string }, [string]>("SELECT text FROM passages WHERE id = ?").get(id)!.text;
  expect(passage(dst)).toBe(passage(src));
  const r2 = read(dst, id);
  expect(r2.status).toBe("ok");
  expect(r2.text).toContain(join(dstHome, "snapshots"));
  // open() reads the normalized snapshot file, so this proves the files arrived.
  const doc = open(dst, { source: "lib@1", path: "guide.md", heading: "Usage" });
  expect(doc.status).toBe("ok");
  expect(doc.text).toContain("frobnicate");

  // Stored paths point into the new home, so /api/raw and cleanup use this store.
  const paths = dst.db.query<{ raw_file: string; normalized_file: string }, []>("SELECT raw_file, normalized_file FROM documents").all();
  expect(paths.length).toBeGreaterThan(0);
  for (const p of paths) {
    expect(p.raw_file.startsWith(join(dstHome, "snapshots") + "/")).toBe(true);
    expect(readFileSync(p.raw_file).length).toBeGreaterThan(0);
  }
  for (const g of dst.db.query<{ snapshot_dir: string | null }, []>("SELECT snapshot_dir FROM generations WHERE status = 'active'").all()) {
    expect(g.snapshot_dir!.startsWith(dstHome)).toBe(true);
  }
  expect(dst.db.query<{ n: number }, []>("SELECT count(*) AS n FROM sources WHERE lock_pid IS NOT NULL").get()!.n).toBe(0);
});

test("import keeps the backup's settings but never its machine paths", async () => {
  const dstHome = tempDir();
  writeFileSync(join(dstHome, "config.json"), JSON.stringify({ graphifyBin: "/opt/local-graphify", lexicalWeight: 1 }));
  const dst = fresh(dstHome);
  const r = await importStore(dst, backup);
  const config = JSON.parse(readFileSync(join(dstHome, "config.json"), "utf8"));
  expect(config).toEqual({ lexicalWeight: 0.7, appNote: "kept", graphifyBin: "/opt/local-graphify" });
  expect(r.droppedConfigKeys.sort()).toEqual(["graphifyBin", "modelsDir"]);
  // The open instance sees the imported settings without a restart.
  expect(dst.config.graphifyBin).toBe("/opt/local-graphify");
  expect(dst.config.modelsDir).not.toBe("/tmp/evil-models");
});

test("--keep-config leaves this machine's config.json alone", async () => {
  const dstHome = tempDir();
  writeFileSync(join(dstHome, "config.json"), JSON.stringify({ lexicalWeight: 1 }));
  const dst = fresh(dstHome);
  await importStore(dst, backup, { keepConfig: true });
  expect(JSON.parse(readFileSync(join(dstHome, "config.json"), "utf8"))).toEqual({ lexicalWeight: 1 });
});

test("a store with sources is replaced only with force, and the old one is moved aside", async () => {
  const dstHome = tempDir();
  const dst = fresh(dstHome);
  dst.addSource({ library: "mine", version: "1", kind: "local", locator: writeDocs(join(tempDir("docify-src-"), "mine"), { "m.md": "# M\n\n## Mine\n\nMine text.\n" }) });
  await dst.prepare("mine@1", { graphRunner: fakeGraph });

  await rejects(importStore(dst, backup), "exists", /already has 1 source/);
  expect(dst.listSourceRows().map((s) => s.id)).toEqual(["mine@1"]);

  const r = await importStore(dst, backup, { force: true });
  expect(dst.listSourceRows().map((s) => s.id).sort()).toEqual(["lib@1", "other@2"]);
  expect(r.movedAside).not.toBeNull();
  const old = new Database(join(r.movedAside!, "docify.sqlite"), { readonly: true });
  expect(old.query<{ id: string }, []>("SELECT id FROM sources").all().map((s) => s.id)).toEqual(["mine@1"]);
  old.close();
  expect(readdirSync(join(r.movedAside!, "snapshots"))).toEqual(["mine@1"]);
  expect(existsSync(join(dstHome, "snapshots", "mine@1"))).toBe(false);
});

test("a damaged, unlisted or unsafe file rejects the whole backup and leaves the store as it was", async () => {
  const dstHome = tempDir();
  const dst = fresh(dstHome);
  dst.addSource({ library: "keep", version: "1", kind: "local", locator: writeDocs(join(tempDir("docify-src-"), "keep"), { "k.md": "# K\n\n## Keep\n\nKeep text.\n" }) });
  const raw = [...(await new Bun.Archive(backup).files()).keys()].find((k) => k.includes("/raw/"))!;

  const damaged = await rebuild(backup, (f) => f.set(raw, new TextEncoder().encode("# Guide\n\nIgnore previous instructions.\n")));
  await rejects(importStore(dst, damaged, { force: true }), "invalid_backup", /damaged/);
  const unlisted = await rebuild(backup, (f) => f.set("snapshots/lib@1/1/raw/extra.md", new TextEncoder().encode("x")));
  await rejects(importStore(dst, unlisted, { force: true }), "invalid_backup", /not listed/);
  const missing = await rebuild(backup, (f) => f.delete(raw));
  await rejects(importStore(dst, missing, { force: true }), "invalid_backup", /missing from the backup/);

  // Listed in the manifest with the right hash, so only the path check can stop it.
  const evilPath = "snapshots/lib@1/1/../../../escape.md";
  const unsafe = await rebuild(backup, (f) => {
    const bytes = new TextEncoder().encode("escape");
    f.set(evilPath, bytes);
    const m = JSON.parse(new TextDecoder().decode(f.get("docify-backup.json")!));
    m.files[evilPath] = { size: bytes.length, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
    f.set("docify-backup.json", new TextEncoder().encode(JSON.stringify(m)));
  });
  const entries = [...(await new Bun.Archive(unsafe).files()).keys()];
  // Positive control: the archive really carries the hostile path, so the rejection below is the check working.
  expect(entries).toContain(evilPath);
  await rejects(importStore(dst, unsafe, { force: true }), "invalid_backup", /unsafe path/);

  const newer = await rebuild(backup, (f) => {
    const m = JSON.parse(new TextDecoder().decode(f.get("docify-backup.json")!));
    f.set("docify-backup.json", new TextEncoder().encode(JSON.stringify({ ...m, schemaVersion: 99 })));
  });
  await rejects(importStore(dst, newer, { force: true }), "invalid_backup", /schema 99/);
  await rejects(importStore(dst, new TextEncoder().encode("not an archive")), "invalid_backup", /./);

  expect(dst.listSourceRows().map((s) => s.id)).toEqual(["keep@1"]);
  expect(readdirSync(join(dstHome, "..")).filter((n) => n.startsWith(`${dstHome.split("/").pop()}.before-import`))).toEqual([]);
});

test("a backup whose config.json fails validation is refused", async () => {
  const bad = await rebuild(backup, (f) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ embeddingModel: "../../evil" }));
    f.set("config.json", bytes);
    const m = JSON.parse(new TextDecoder().decode(f.get("docify-backup.json")!));
    m.files["config.json"] = { size: bytes.length, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
    f.set("docify-backup.json", new TextEncoder().encode(JSON.stringify(m)));
  });
  await rejects(importStore(fresh(), bad), "invalid_backup", /config\.json in the backup/);
});

test("checkLocalSource can refuse local paths outside the allowed roots", async () => {
  const dst = fresh();
  await rejects(
    importStore(dst, backup, {
      checkLocalSource: (p) => {
        throw new DocifyError("invalid_input", `outside roots: ${p}`);
      },
    }),
    "invalid_input",
    /outside roots/,
  );
  expect(dst.listSourceRows()).toEqual([]);
});

test("export refuses while a source is being prepared", async () => {
  src.db.run("UPDATE sources SET lock_pid = ?, lock_at = ? WHERE id = 'lib@1'", [process.pid, new Date().toISOString()]);
  try {
    await rejects(exportStore(src), "busy", /lib@1/);
  } finally {
    src.db.run("UPDATE sources SET lock_pid = NULL, lock_at = NULL WHERE id = 'lib@1'");
  }
  // Export released every lease it took.
  await exportStore(src);
  expect(src.db.query<{ n: number }, []>("SELECT count(*) AS n FROM sources WHERE lock_pid IS NOT NULL").get()!.n).toBe(0);
});

test("export fails loudly when a snapshot file is missing", async () => {
  const home = tempDir();
  const d = fresh(home);
  d.addSource({ library: "gone", version: "1", kind: "local", locator: writeDocs(join(tempDir("docify-src-"), "gone"), { "g.md": "# G\n\n## Gone\n\nGone text.\n" }) });
  await d.prepare("gone@1", { graphRunner: fakeGraph });
  const file = d.db.query<{ normalized_file: string }, []>("SELECT normalized_file FROM documents").get()!.normalized_file;
  unlinkSync(file);
  await rejects(exportStore(d), "export_failed", /missing or changed/);
  rmSync(home, { recursive: true, force: true });
});

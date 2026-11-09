// Queries must never write: no DB change and no file removal, even when the store holds a
// staging generation left by a dead writer. Readers derive the interrupted state instead.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { pidAlive, type Docify } from "../src/core/docify.ts";
import { open, outline, read, scope, search, searchMany, sources } from "../src/core/search.ts";
import { createMcpServer } from "../src/mcp/tools.ts";
import { fakeGraph, newDocify, tempDir, writeDocs } from "./helpers.ts";

const DEAD_PID = 4_000_000;
const STALE = new Date(Date.now() - 10 * 60_000).toISOString();
const cleanup: string[] = [];
afterAll(() => cleanup.forEach((p) => rmSync(p, { recursive: true, force: true })));

// Two sources, each with a staging generation that holds real passages and snapshot files but
// whose writer is dead: "upd@1" was being updated (an older active generation still serves),
// "first@1" was being prepared for the first time (nothing serves).
async function orphanedStore() {
  const home = tempDir();
  const src = tempDir("docify-src-");
  cleanup.push(home, src);
  const d = newDocify(home);
  const upd = writeDocs(join(src, "upd"), { "a.md": "# Upd\n\n## Walrus\n\nWalrus tusks are long teeth.\n" });
  d.addSource({ library: "upd", version: "1", kind: "local", locator: upd });
  const first = await d.prepare("upd@1", { graphRunner: fakeGraph });
  writeFileSync(join(upd, "a.md"), "# Upd\n\n## Walrus\n\nWalrus tusks revised text.\n");
  const second = await d.prepare("upd@1", { graphRunner: fakeGraph });
  const fst = writeDocs(join(src, "first"), { "a.md": "# First\n\n## Narwhal\n\nNarwhal horn is a tooth.\n" });
  d.addSource({ library: "first", version: "1", kind: "local", locator: fst });
  const only = await d.prepare("first@1", { graphRunner: fakeGraph });
  // Prepare runs recovery, so the generations are orphaned only after the last prepare.
  // Roll upd's second generation back to staging with a dead writer holding a stale lease.
  d.db.run("UPDATE generations SET status = 'active' WHERE id = ?", [first.generationId!]);
  d.db.run("UPDATE generations SET status = 'staging', phase = 'graph', pid = ?, finished_at = NULL WHERE id = ?", [DEAD_PID, second.generationId!]);
  d.db.run("UPDATE sources SET active_generation = ?, lock_pid = ?, lock_at = ? WHERE id = 'upd@1'", [first.generationId!, DEAD_PID, STALE]);
  d.db.run("UPDATE generations SET status = 'staging', phase = 'embed', pid = ?, finished_at = NULL WHERE id = ?", [DEAD_PID, only.generationId!]);
  // No lease at all: the writer's lock was already gone.
  d.db.run("UPDATE sources SET active_generation = NULL WHERE id = 'first@1'");

  const dirs = [join(home, "snapshots", "upd@1", String(second.generationId)), join(home, "snapshots", "first@1", String(only.generationId))];
  for (const dir of dirs) {
    mkdirSync(join(dir, "raw"), { recursive: true });
    writeFileSync(join(dir, "raw", "marker.txt"), "keep me");
  }
  const orphanPassage = d.db.query<{ id: string }, [number]>("SELECT id FROM passages WHERE generation_id = ? LIMIT 1").get(second.generationId!)!.id;
  return { d, home, dirs, orphanPassage, activeGen: first.generationId!, orphanGens: [second.generationId!, only.generationId!] };
}

function storeState(d: Docify) {
  return {
    changes: d.db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n,
    generations: d.db.query("SELECT id, source_id, status, error, finished_at FROM generations ORDER BY id").all(),
    sources: d.db.query("SELECT id, active_generation, lock_pid, lock_at FROM sources ORDER BY id").all(),
    passages: d.db.query<{ n: number }, []>("SELECT count(*) AS n FROM passages").get()!.n,
  };
}

// Timestamps differ between a recovery done now and one derived at read time; nothing else may.
const stripTimes = (s: string) => s.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<time>");

async function observe(d: Docify, orphanPassage: string) {
  const one = async (input: Parameters<typeof search>[1]) => {
    const r = await search(d, input);
    return { status: r.status, warnings: r.warnings.map(stripTimes), notIndexed: r.notIndexed, searched: r.searched, hits: r.hits.map((h) => h.id) };
  };
  const many = await searchMany(d, { queries: ["walrus tusks", "narwhal horn"] });
  const sc = (input: Parameters<typeof scope>[1]) => {
    const r = scope(d, input);
    return { status: r.status, warnings: r.warnings.map(stripTimes), notIndexed: r.notIndexed, selected: r.selected };
  };
  return {
    searchUpd: await one({ query: "walrus tusks", library: "upd" }),
    searchFirst: await one({ query: "narwhal horn", library: "first" }),
    searchAll: await one({ query: "walrus narwhal" }),
    many: many.queries.map((q) => ({ status: q.status, warnings: q.warnings.map(stripTimes) })),
    scopeUpd: sc({ library: "upd" }),
    scopeFirst: sc({ library: "first" }),
    sources: sources(d).map((s) => ({ id: s.id, state: s.state, latest: s.latest && { id: s.latest.id, status: s.latest.status, error: s.latest.error } })),
    outlineUpd: (({ status, text }) => ({ status, refreshFailed: text.includes("the last refresh failed") }))(outline(d, { source: "upd@1" })),
    outlineFirst: outline(d, { source: "first@1" }).status,
    openUpd: (({ status, passages }) => ({ status, passages: passages.map((p) => p.id) }))(open(d, { source: "upd@1", path: "a.md" })),
    openFirst: open(d, { source: "first@1", path: "a.md" }).status,
    readOrphan: read(d, orphanPassage).status,
  };
}

let s: Awaited<ReturnType<typeof orphanedStore>>;
beforeAll(async () => {
  expect(pidAlive(DEAD_PID)).toBe(false);
  s = await orphanedStore();
});
afterAll(() => s?.d.close());

test("no query entry point writes to the store or removes snapshot files", async () => {
  const before = storeState(s.d);
  await observe(s.d, s.orphanPassage);

  const server = createMcpServer(s.d, s.home);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const calls: [string, Record<string, unknown>][] = [
    ["docs_search", { query: "walrus tusks" }],
    ["docs_search", { queries: ["walrus tusks", "narwhal horn"] }],
    ["docs_sources", {}],
    ["docs_scope", { library: "first" }],
    ["docs_outline", { source: "upd@1" }],
    ["docs_open", { source: "upd@1", path: "a.md" }],
    ["docs_read", { id: s.orphanPassage }],
  ];
  for (const [name, args] of calls) {
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError, `${name} failed: ${JSON.stringify(r.content)}`).toBeFalsy();
  }
  await client.close();

  expect(storeState(s.d)).toEqual(before);
  for (const dir of s.dirs) expect(existsSync(join(dir, "raw", "marker.txt"))).toBe(true);
});

test("readers report an interrupted generation exactly as they did after recovery", async () => {
  const derived = await observe(s.d, s.orphanPassage);
  expect(derived.searchUpd.status).toBe("ok");
  expect(derived.searchUpd.warnings.some((w) => w.includes("last update failed") && w.includes("interrupted"))).toBe(true);
  expect(derived.searchFirst.status).toBe("update_failed");
  expect(derived.scopeFirst.status).toBe("update_failed");
  expect(derived.sources.map((x) => x.state)).toEqual(["failed", "stale"]);
  expect(derived.readOrphan).toBe("unavailable");
  expect(derived.outlineUpd).toEqual({ status: "ok", refreshFailed: true });

  // A writer path recovers for real; readers must then see the same thing.
  expect(s.d.recoverInterrupted()).toBe(2);
  const recovered = await observe(s.d, s.orphanPassage);
  expect(derived).toEqual(recovered);
  for (const dir of s.dirs) expect(existsSync(dir)).toBe(false);
});

test("prepare still recovers an interrupted generation: failed, rows and directory removed", async () => {
  const fresh = await orphanedStore();
  const { d, dirs, orphanGens } = fresh;
  await d.prepare("upd@1", { graphRunner: fakeGraph });
  for (const id of orphanGens) {
    const g = d.getGeneration(id)!;
    expect(g.status).toBe("failed");
    expect(g.error).toBe("interrupted: the preparing process exited before activation");
    expect(d.db.query<{ n: number }, [number]>("SELECT count(*) AS n FROM passages WHERE generation_id = ?").get(id)!.n).toBe(0);
  }
  for (const dir of dirs) expect(existsSync(dir)).toBe(false);
  d.close();
});

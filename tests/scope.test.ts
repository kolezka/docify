import { test, expect, beforeAll, afterAll } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Docify } from "../src/core/docify.ts";
import { scope, search, type ScopeInput } from "../src/core/search.ts";
import { copyFixture, fakeGraph, newDocify, tempDir, writeDocs } from "./helpers.ts";

let d: Docify;
const home = tempDir();
const noPins = tempDir("docify-proj-");
const pinned = tempDir("docify-proj-");
const badPin = tempDir("docify-proj-");
writeFileSync(join(pinned, ".docify.json"), JSON.stringify({ pins: { bun: "1.3.0" } }));
writeFileSync(join(badPin, ".docify.json"), JSON.stringify({ pins: { bun: "9.9.9" } }));

beforeAll(async () => {
  d = newDocify(home);
  d.addSource({ library: "bun", version: "1.4.3", kind: "local", locator: copyFixture("bun-1.4.3") });
  await d.prepare("bun@1.4.3", { graphRunner: fakeGraph });
  const old = writeDocs(join(tempDir("docify-src-"), "bun-old"), { "sqlite.md": "# SQLite\n\n## Database\n\nOpen a database with new Database(path) and close it with db.close().\n" });
  d.addSource({ library: "bun", version: "1.3.0", kind: "local", locator: old });
  await d.prepare("bun@1.3.0", { graphRunner: fakeGraph });
  const ghost = writeDocs(join(tempDir("docify-src-"), "ghost"), { "a.md": "# Ghost\n\nNever prepared.\n" });
  d.addSource({ library: "ghost", version: "1", kind: "local", locator: ghost });
});
afterAll(() => {
  d.close();
  for (const dir of [home, noPins, pinned, badPin]) rmSync(dir, { recursive: true, force: true });
});

const gen = (id: string) => d.listSourceRows().find((s) => s.id === id)!.active_generation;

test("no filters selects every indexed source and reports the unprepared one", () => {
  const r = scope(d, { project: noPins });
  expect(r.status).toBe("ok");
  expect(r.selected.map((s) => s.source).sort()).toEqual(["bun@1.3.0", "bun@1.4.3"]);
  expect(r.notIndexed).toEqual(["ghost@1"]);
  expect(r.pins).toEqual({ file: null, values: {} });
  expect(r.text).toContain("pins file: none");
  expect(r.text).toContain("not indexed: ghost@1");
});

test("an explicit registered version selects only that source", () => {
  const r = scope(d, { library: "bun", version: "1.4.3", project: noPins });
  expect(r.status).toBe("ok");
  expect(r.selected).toEqual([{ source: "bun@1.4.3", library: "bun", version: "1.4.3", generation: gen("bun@1.4.3")! }]);
  expect(r.libraries).toHaveLength(1);
  expect(r.libraries[0]).toMatchObject({ library: "bun", version: "1.4.3", reason: "explicit version" });
  expect([...r.libraries[0]!.registered].sort()).toEqual(["1.3.0", "1.4.3"]);
  expect(r.text).toContain("library bun: version 1.4.3 (explicit version)");
  expect(r.text).toContain(`selected: bun@1.4.3 (bun@1.4.3) generation ${gen("bun@1.4.3")}`);
  expect(r.warnings).toEqual([]);
});

test("a missing explicit version is version_unavailable with the available versions", () => {
  const r = scope(d, { library: "bun", version: "2.0", project: noPins });
  expect(r.status).toBe("version_unavailable");
  expect(r.selected).toEqual([]);
  expect(r.availableVersions!.bun!.sort()).toEqual(["1.3.0", "1.4.3"]);
  expect(r.text).toMatch(/available bun versions: 1\.(3\.0|4\.3), 1\.(3\.0|4\.3)/);
});

test("a registered project pin chooses the version and names the pins file", () => {
  const r = scope(d, { library: "bun", project: pinned });
  expect(r.status).toBe("ok");
  expect(r.pins).toEqual({ file: join(pinned, ".docify.json"), values: { bun: "1.3.0" } });
  expect(r.selected.map((s) => s.source)).toEqual(["bun@1.3.0"]);
  expect(r.libraries[0]!.reason).toBe("project pin");
  expect(r.text).toContain(`pins file: ${join(pinned, ".docify.json")}`);
  expect(r.text).toContain("pins: bun@1.3.0");
  expect(r.text).toContain("library bun: version 1.3.0 (project pin)");
});

test("an unregistered project pin warns and falls back to all versions", () => {
  const r = scope(d, { library: "bun", project: badPin });
  expect(r.status).toBe("ok");
  expect(r.libraries[0]!.reason).toBe("project pin not registered");
  expect(r.selected.map((s) => s.source).sort()).toEqual(["bun@1.3.0", "bun@1.4.3"]);
  expect(r.warnings).toContain("project pin bun@9.9.9 is not registered; searching all bun versions");
});

test("an unknown source id or library is source_unknown and lists what is registered", () => {
  const r = scope(d, { sources: ["nope@1"], project: noPins });
  expect(r.status).toBe("source_unknown");
  expect(r.pins).toBeUndefined();
  expect(r.text).toContain("registered libraries: ");
  expect(r.text).toContain("ghost (1)");
  expect(scope(d, { library: "nope", project: noPins }).warnings).toEqual(['no source registered for library "nope"']);
});

test("a source that was never prepared is not_indexed", () => {
  const r = scope(d, { library: "ghost", project: noPins });
  expect(r.status).toBe("not_indexed");
  expect(r.notIndexed).toEqual(["ghost@1"]);
  expect(r.selected).toEqual([]);
});

test("several versions without a version or pin give the mixed-version warning", () => {
  const r = scope(d, { library: "bun", project: noPins });
  expect(r.libraries[0]!.reason).toBe("all versions");
  expect(r.warnings.some((w) => w.startsWith("several bun versions match"))).toBe(true);
  expect(r.text).toContain("library bun: all versions (all versions)");
});

test("scope writes nothing to the store", () => {
  const changes = () => d.db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;
  const before = changes();
  scope(d, { project: pinned });
  scope(d, { library: "bun", version: "2.0", project: noPins });
  expect(changes()).toBe(before);
});

test("scope and search agree on status, generations and warnings for the same filters", async () => {
  const inputs: ScopeInput[] = [
    { project: noPins },
    { library: "bun", project: noPins },
    { library: "bun", version: "1.4.3", project: noPins },
    { library: "bun", version: "2.0", project: noPins },
    { library: "bun", project: pinned },
    { library: "bun", project: badPin },
    { library: "ghost", project: noPins },
    { library: "nope", project: noPins },
    { sources: ["nope@1"], project: noPins },
    { sources: ["bun@1.3.0"], version: "1.3.0", project: noPins },
  ];
  for (const input of inputs) {
    const sc = scope(d, input);
    const se = await search(d, { ...input, query: "close the database", mode: "lexical" });
    if (sc.status === "ok") expect(["ok", "weak_match", "no_match"]).toContain(se.status);
    else expect(se.status).toBe(sc.status);
    const ids = (xs: { source: string; generation: number }[]) => xs.map((x) => `${x.source}#${x.generation}`).sort();
    expect(ids(se.searched)).toEqual(ids(sc.selected));
    expect(se.notIndexed).toEqual(sc.notIndexed);
    expect(se.availableVersions).toEqual(sc.availableVersions);
    for (const w of sc.warnings) expect(se.warnings).toContain(w);
  }
});

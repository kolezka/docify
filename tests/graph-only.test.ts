// A prepare that fails in the graph phase keeps its index so `prepare --graph-only` can retry the
// graph without collecting, normalizing or embedding again.
import { describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DocifyError } from "../src/core/docify.ts";
import { read, search, sources } from "../src/core/search.ts";
import { fakeGraph, newDocify, tempDir, writeDocs } from "./helpers.ts";

const GRAPH = { graph: { backend: "ollama", model: "fake", timeoutSeconds: 60 } };
const down = async () => Promise.reject(new Error("provider down"));

function setup() {
  const d = newDocify(tempDir(), GRAPH);
  const dir = writeDocs(join(tempDir("docify-src-"), "lib"), {
    "a.md": "# A\n\n## Otter knob\n\nThe otterKnob setting enables floating.\n",
    "b.md": "# B\n\n## Beaver dam\n\nThe beaverDam option stacks logs.\n",
  });
  d.addSource({ library: "lib", version: "1", kind: "local", locator: dir });
  const count = (table: string, gen: number) => (d.db.query(`SELECT count(*) AS n FROM ${table} WHERE generation_id = ?`).get(gen) as { n: number }).n;
  return { d, dir, count, info: () => sources(d).find((s) => s.id === "lib@1")! };
}

describe("graph-only retry", () => {
  test("a graph failure keeps the index; --graph-only activates it without collecting again", async () => {
    const { d, dir, count, info } = setup();
    const good = await d.prepare("lib@1", { graphRunner: fakeGraph });
    writeFileSync(join(dir, "a.md"), "# A\n\n## Otter knob\n\nThe otterKnob setting now sinks.\n");
    const err = await d.prepare("lib@1", { graphRunner: down }).catch((e) => e);
    expect(String(err)).toContain("provider down");

    const failed = info();
    expect(failed.state).toBe("stale");
    expect(failed.graphRetry).toMatchObject({ documents: 2, passages: 2 });
    const genId = failed.graphRetry!.generation;
    expect(count("passages", genId)).toBe(2);
    expect(count("vectors", genId)).toBe(2);
    // Kept rows are never served: search stays on the previous generation and read() hides them.
    const r = await search(d, { query: "otterKnob", library: "lib" });
    expect(r.hits[0]!.citation.generation).toBe(good.generationId);
    const kept = d.db.query("SELECT id FROM passages WHERE generation_id = ? LIMIT 1").get(genId) as { id: string };
    expect(read(d, kept.id).status).toBe("unavailable");

    // The source changes again, but the retry must use what the failed attempt collected.
    rmSync(join(dir, "b.md"));
    let collected = false;
    const r2 = await d.prepare("lib@1", { graphOnly: true, graphRunner: fakeGraph, onPhase: (p) => void (p === "collect" && (collected = true)) });
    expect(collected).toBe(false);
    expect(r2).toMatchObject({ status: "activated", generationId: genId });
    expect(r2.stats).toMatchObject({ documents: 2, passages: 2 });
    expect(d.getGeneration(genId)!.graph_status).toBe("ok");
    expect(d.getGeneration(genId)!.error).toBeNull();
    expect(d.getGeneration(good.generationId)!.status).toBe("superseded");
    expect(info()).toMatchObject({ state: "ready", graphRetry: null });
    const hit = (await search(d, { query: "otterKnob sinks", library: "lib" })).hits[0]!;
    expect(hit.citation.generation).toBe(genId);
    expect(read(d, hit.id).status).toBe("ok");
    expect((await search(d, { query: "Otter knob", library: "lib", mode: "graph" })).hits.length).toBeGreaterThan(0);
  });

  test("a failed graph-only retry keeps the index for the next one", async () => {
    const { d, count, info } = setup();
    await d.prepare("lib@1", { graphRunner: down }).catch(() => {});
    const genId = info().graphRetry!.generation;
    expect(info().state).toBe("failed");
    const err = await d.prepare("lib@1", { graphOnly: true, graphRunner: down }).catch((e) => e);
    expect(String(err)).toContain("provider down");
    expect(info().graphRetry?.generation).toBe(genId);
    expect(count("vectors", genId)).toBe(2);
    expect((await d.prepare("lib@1", { graphOnly: true, graphRunner: fakeGraph })).generationId).toBe(genId);
  });

  test("a cancelled graph phase is resumable too", async () => {
    const { d, info } = setup();
    const controller = new AbortController();
    await d.prepare("lib@1", { graphRunner: fakeGraph, signal: controller.signal, onPhase: (p) => void (p === "graph" && controller.abort()) }).catch(() => {});
    expect(info().graphRetry).not.toBeNull();
  });

  test("failures before the graph phase keep nothing", async () => {
    const { d, info } = setup();
    for (const phase of ["normalize", "embed"]) {
      await d.prepare("lib@1", { graphRunner: fakeGraph, onPhase: (p) => { if (p === phase) throw new Error(`boom at ${phase}`); } }).catch(() => {});
      expect(info().graphRetry).toBeNull();
      expect(d.db.query("SELECT count(*) AS n FROM passages").get()).toEqual({ n: 0 });
    }
    const err = await d.prepare("lib@1", { graphOnly: true, graphRunner: fakeGraph }).catch((e) => e);
    expect(err).toBeInstanceOf(DocifyError);
    expect((err as DocifyError).code).toBe("not_resumable");
    expect(d.getSource("lib@1")!.lock_pid).toBeNull();
  });

  test("a newer failure replaces the kept index, and a full prepare drops it", async () => {
    const { d, dir, info } = setup();
    await d.prepare("lib@1", { graphRunner: down }).catch(() => {});
    const first = info().graphRetry!.generation;
    writeFileSync(join(dir, "a.md"), "# A\n\n## Otter knob\n\nSecond attempt.\n");
    await d.prepare("lib@1", { graphRunner: down }).catch(() => {});
    const second = info().graphRetry!.generation;
    expect(second).toBeGreaterThan(first);
    expect(existsSync(join(d.config.home, "snapshots", "lib@1", String(first)))).toBe(false);
    expect(d.db.query("SELECT count(*) AS n FROM passages WHERE generation_id = ?").get(first)).toEqual({ n: 0 });

    await d.prepare("lib@1", { graphRunner: fakeGraph });
    expect(info().graphRetry).toBeNull();
    expect(existsSync(join(d.config.home, "snapshots", "lib@1", String(second)))).toBe(false);
  });

  test("a changed embedding model refuses the retry", async () => {
    const { d, info } = setup();
    await d.prepare("lib@1", { graphRunner: down }).catch(() => {});
    const genId = info().graphRetry!.generation;
    d.db.run("UPDATE generations SET stats = json_set(stats, '$.resume.embedding', 'ollama:other') WHERE id = ?", [genId]);
    const err = await d.prepare("lib@1", { graphOnly: true, graphRunner: fakeGraph }).catch((e) => e);
    expect(String(err)).toContain("run a full prepare");
    expect(d.getSource("lib@1")!.lock_pid).toBeNull();
  });

  test("a missing snapshot file fails the retry and drops the kept index", async () => {
    const { d, info } = setup();
    await d.prepare("lib@1", { graphRunner: down }).catch(() => {});
    const genId = info().graphRetry!.generation;
    rmSync(join(d.config.home, "snapshots", "lib@1", String(genId), "normalized"), { recursive: true });
    const err = await d.prepare("lib@1", { graphOnly: true, graphRunner: fakeGraph }).catch((e) => e);
    expect((err as DocifyError).code).toBe("snapshot_missing");
    expect(info().graphRetry).toBeNull();
  });
});

import { test, expect, describe, afterAll, beforeAll } from "bun:test";
import { rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Docify, DocifyError, PIPELINE_VERSION } from "../src/core/docify.ts";
import { read, search, sources, type Mode } from "../src/core/search.ts";
import { copyFixture, fakeGraph, newDocify, tempDir, writeDocs } from "./helpers.ts";

const homes: string[] = [];
const home = () => {
  const h = tempDir();
  homes.push(h);
  return h;
};
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

const MODES: Mode[] = ["combined", "lexical", "vector", "graph"];

describe("restart and versions", () => {
  const h = home();
  let d: Docify;
  beforeAll(async () => {
    d = newDocify(h);
    d.addSource({ library: "bun", version: "1.4.3", kind: "local", locator: copyFixture("bun-1.4.3") });
    d.addSource({ library: "bun", version: "1.2.0", kind: "local", locator: copyFixture("bun-1.2.0") });
    await d.prepare("bun@1.4.3", { graphRunner: fakeGraph });
    await d.prepare("bun@1.2.0", { graphRunner: fakeGraph });
  });

  test("a new process on the same store returns the same passage ids", async () => {
    const before = await search(d, { query: "Statement finalize", library: "bun", version: "1.4.3" });
    d.close();
    const again = newDocify(h);
    const after = await search(again, { query: "Statement finalize", library: "bun", version: "1.4.3" });
    expect(after.hits.map((x) => x.id)).toEqual(before.hits.map((x) => x.id));
    expect(after.hits.length).toBeGreaterThan(0);
    again.close();
  });

  test("version filters hold in every mode", async () => {
    const x = newDocify(h);
    for (const mode of MODES) {
      const r = await search(x, { query: "Bun.password.hash bcrypt", library: "bun", version: "1.2.0", mode, graphWeight: 1 });
      for (const hit of r.hits) expect(hit.citation.source).toBe("bun@1.2.0");
    }
    x.close();
  });

  test("unknown version is version_unavailable with the available list", async () => {
    const x = newDocify(h);
    const r = await search(x, { query: "Bun.password", library: "bun", version: "9.9" });
    expect(r.status).toBe("version_unavailable");
    expect(r.availableVersions?.bun?.sort()).toEqual(["1.2.0", "1.4.3"]);
    expect(r.hits).toHaveLength(0);
    x.close();
  });

  test("a project pin restricts results; unpinned search warns about mixed versions", async () => {
    const x = newDocify(h);
    const project = tempDir("docify-project-");
    homes.push(project);
    Docify.writePin(project, "bun", "1.2.0");
    const pinned = await search(x, { query: "bcrypt cost", library: "bun", project });
    expect(pinned.hits.length).toBeGreaterThan(0);
    for (const hit of pinned.hits) expect(hit.citation.version).toBe("1.2.0");
    const open = await search(x, { query: "bcrypt cost", library: "bun" });
    expect(open.warnings.join(" ")).toContain("several bun versions");
    x.close();
  });
});

describe("refresh, deletion and old ids", () => {
  const h = home();
  const d = newDocify(h, { keepGenerations: 2 });
  const dir = writeDocs(join(tempDir("docify-src-"), "lib"), {
    "a.md": "# Alpha\n\n## Zebra setting\n\nThe zebraFactor option controls stripes and defaults to seven.\n",
    "b.md": "# Beta\n\n## Walrus mode\n\nWalrus mode keeps tusks polished during long sessions.\n",
  });
  let first: Awaited<ReturnType<Docify["prepare"]>>;
  let oldHit: { id: string };
  beforeAll(async () => {
    d.addSource({ library: "lib", version: "1.0", kind: "local", locator: dir });
    first = await d.prepare("lib@1.0", { graphRunner: fakeGraph });
    oldHit = (await search(d, { query: "zebraFactor stripes", library: "lib" })).hits[0]!;
  });

  test("edited and deleted content is gone from every mode; new content is found", async () => {
    writeFileSync(join(dir, "a.md"), "# Alpha\n\n## Zebra setting\n\nThe giraffeFactor option controls necks and defaults to nine.\n");
    unlinkSync(join(dir, "b.md"));
    const second = await d.prepare("lib@1.0", { graphRunner: fakeGraph });
    expect(second.generationId).toBeGreaterThan(first.generationId);
    for (const mode of MODES) {
      for (const q of ["zebraFactor stripes seven", "walrus tusks polished"]) {
        const r = await search(d, { query: q, library: "lib", mode, graphWeight: 1 });
        for (const hit of r.hits) {
          expect(hit.excerpt).not.toContain("zebraFactor");
          expect(hit.excerpt).not.toContain("Walrus");
          expect(hit.citation.generation).toBe(second.generationId);
        }
      }
    }
    const fresh = await search(d, { query: "giraffeFactor necks", library: "lib" });
    expect(fresh.hits[0]?.excerpt).toContain("giraffeFactor");
  });

  test("an old id reads its own snapshot text marked superseded, then unavailable after GC", async () => {
    const r = read(d, oldHit.id);
    expect(r.status).toBe("superseded");
    expect(r.passage).toContain("zebraFactor");
    expect(r.passage).not.toContain("giraffeFactor");
    writeFileSync(join(dir, "a.md"), "# Alpha\n\n## Zebra setting\n\nThird revision about okapis.\n");
    await d.prepare("lib@1.0", { graphRunner: fakeGraph });
    writeFileSync(join(dir, "a.md"), "# Alpha\n\n## Zebra setting\n\nFourth revision about tapirs.\n");
    await d.prepare("lib@1.0", { graphRunner: fakeGraph });
    expect(read(d, oldHit.id).status).toBe("unavailable");
  });

  test("an unchanged snapshot does not create a generation", async () => {
    const before = d.generations("lib@1.0").length;
    const r = await d.prepare("lib@1.0", { graphRunner: fakeGraph });
    expect(r.status).toBe("unchanged");
    expect(d.generations("lib@1.0").length).toBe(before);
    expect(JSON.parse(d.getGeneration(r.generationId)!.stats).pipeline).toBe(PIPELINE_VERSION);
  });

  test("an older pipeline version forces a rebuild of an identical snapshot", async () => {
    const active = d.getSource("lib@1.0")!.active_generation!;
    const stats = JSON.parse(d.getGeneration(active)!.stats);
    d.db.run("UPDATE generations SET stats = ? WHERE id = ?", [JSON.stringify({ ...stats, pipeline: PIPELINE_VERSION - 1 }), active]);
    const r = await d.prepare("lib@1.0", { graphRunner: fakeGraph });
    expect(r.status).toBe("activated");
    expect(r.generationId).not.toBe(active);
  });
});

describe("failed updates", () => {
  const h = home();
  const d = newDocify(h);
  const dir = writeDocs(join(tempDir("docify-src-"), "lib"), { "a.md": "# A\n\n## Otter knob\n\nThe otterKnob setting enables floating.\n" });
  let good: Awaited<ReturnType<Docify["prepare"]>>;
  beforeAll(async () => {
    d.addSource({ library: "lib", version: "2.0", kind: "local", locator: dir });
    good = await d.prepare("lib@2.0", { graphRunner: fakeGraph });
  });

  for (const phase of ["embed", "graph", "validate"]) {
    test(`failure at ${phase} keeps the previous generation and reports stale`, async () => {
      writeFileSync(join(dir, "a.md"), `# A\n\n## Otter knob\n\nChanged before failing at ${phase}.\n`);
      const err = await d
        .prepare("lib@2.0", {
          graphRunner: fakeGraph,
          onPhase: (p) => {
            if (p === phase) throw new Error(`boom at ${phase}`);
          },
        })
        .catch((e) => e);
      expect(String(err)).toContain(`boom at ${phase}`);
      expect(d.getSource("lib@2.0")!.active_generation).toBe(good.generationId);
      const r = await search(d, { query: "otterKnob floating", library: "lib" });
      expect(r.status).toBe("ok");
      expect(r.hits[0]!.citation.generation).toBe(good.generationId);
      expect(r.warnings.join(" ")).toContain("last update failed");
      const info = sources(d).find((s) => s.id === "lib@2.0")!;
      expect(info.state).toBe("stale");
      expect(info.latest?.error).toContain(`boom at ${phase}`);
      expect(d.db.query("SELECT count(*) AS n FROM passages WHERE generation_id = ?").get(info.latest!.id)).toEqual({ n: 0 });
    });
  }

  test("graph provider failure fails the update instead of activating without a graph", async () => {
    writeFileSync(join(dir, "a.md"), "# A\n\n## Otter knob\n\nProvider failure revision.\n");
    const err = await d.prepare("lib@2.0", { graphRunner: async () => Promise.reject(new Error("provider down")) }).catch((e) => e);
    expect(String(err)).toContain("provider down");
    expect(d.getSource("lib@2.0")!.active_generation).toBe(good.generationId);
  });

  test("a registered but never prepared source is not_indexed; an unknown id is source_unknown", async () => {
    d.addSource({ library: "empty", version: "1", kind: "local", locator: dir });
    expect((await search(d, { query: "otter", library: "empty" })).status).toBe("not_indexed");
    expect((await search(d, { query: "otter", sources: ["nope@1"] })).status).toBe("source_unknown");
  });

  test("a failed first preparation reports update_failed", async () => {
    const bad = writeDocs(join(tempDir("docify-src-"), "bad"), { "a.md": "# Bad\n\n## Thing\n\nSome text here.\n" });
    d.addSource({ library: "bad", version: "1", kind: "local", locator: bad });
    await d.prepare("bad@1", { graphRunner: async () => Promise.reject(new Error("no provider")) }).catch(() => {});
    const r = await search(d, { query: "thing", library: "bad" });
    expect(r.status).toBe("update_failed");
    expect(r.warnings.join(" ")).toContain("no provider");
  });

  test("invalid input is rejected with DocifyError", () => {
    expect(() => d.addSource({ library: "../x", kind: "local", locator: dir })).toThrow(DocifyError);
    expect(() => d.addSource({ library: "x", kind: "url", locator: "file:///etc/passwd" })).toThrow(DocifyError);
    expect(() => read(d, "../../etc/passwd")).toThrow(DocifyError);
  });
});

import { test, expect, afterAll } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DocifyError } from "../src/core/docify.ts";
import { search, sources } from "../src/core/search.ts";
import { fakeGraph, newDocify, tempDir, writeDocs } from "./helpers.ts";

const CHILD = join(import.meta.dir, "helpers", "prepare-child.ts");
const cleanup: string[] = [];
afterAll(() => cleanup.forEach((p) => rmSync(p, { recursive: true, force: true })));

async function waitFor(check: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await Bun.sleep(100);
  }
  throw new Error("timed out waiting");
}

test("SIGKILL during preparation keeps the previous generation; the lock blocks a second writer and is recovered", async () => {
  const home = tempDir();
  const dir = writeDocs(join(tempDir("docify-src-"), "lib"), { "a.md": "# A\n\n## Badger burrow\n\nBadgers dig a burrowDepth of two metres.\n" });
  cleanup.push(home, dir);
  const d = newDocify(home);
  d.addSource({ library: "lib", version: "1", kind: "local", locator: dir });
  const good = await d.prepare("lib@1", { graphRunner: fakeGraph });

  writeFileSync(join(dir, "a.md"), "# A\n\n## Badger burrow\n\nInterrupted revision.\n");
  const child = Bun.spawn(["bun", CHILD, home, "lib@1", "hang"], { stdout: "pipe", stderr: "inherit" });
  await waitFor(() => d.generations("lib@1")[0]?.phase === "embed");

  // A second writer is refused while the child holds the lock.
  const busy = await d.prepare("lib@1", { graphRunner: fakeGraph }).catch((e) => e);
  expect(busy).toBeInstanceOf(DocifyError);
  expect((busy as DocifyError).code).toBe("busy");
  // Readers keep the active generation during the write.
  expect((await search(d, { query: "burrowDepth badgers", library: "lib" })).hits[0]!.citation.generation).toBe(good.generationId);

  child.kill("SIGKILL");
  await child.exited;
  expect(d.recoverInterrupted()).toBe(1);
  const info = sources(d).find((s) => s.id === "lib@1")!;
  expect(info.state).toBe("stale");
  expect(info.latest?.error).toContain("interrupted");
  expect(d.getSource("lib@1")!.lock_pid).toBeNull();
  expect((await search(d, { query: "burrowDepth badgers", library: "lib" })).hits[0]!.citation.generation).toBe(good.generationId);

  const next = await d.prepare("lib@1", { graphRunner: fakeGraph });
  expect(next.status).toBe("activated");
  expect((await search(d, { query: "interrupted revision", library: "lib" })).hits[0]!.excerpt).toContain("Interrupted revision");
  d.close();
}, 60_000);

test("concurrent readers never see a mix of generations while another process rewrites the source", async () => {
  const home = tempDir();
  const dir = writeDocs(join(tempDir("docify-src-"), "lib"), {
    "a.md": "# Doc\n\n## Heron section\n\nHeron AMARKER herons wade in shallow water.\n\n## Crane section\n\nCrane AMARKER cranes fly high.\n",
  });
  cleanup.push(home, dir);
  const d = newDocify(home);
  d.addSource({ library: "lib", version: "1", kind: "local", locator: dir });
  await d.prepare("lib@1", { graphRunner: fakeGraph });

  const child = Bun.spawn(["bun", CHILD, home, "lib@1", "alternate", dir], { stdout: "pipe", stderr: "inherit" });
  let running = true;
  child.exited.then(() => (running = false));
  let searches = 0;
  const generationsSeen = new Set<number>();
  while (running) {
    const r = await search(d, { query: "herons cranes wade fly", library: "lib", mode: "lexical", maxTokens: 800 });
    searches++;
    const gens = new Set(r.hits.map((h) => h.citation.generation));
    expect(gens.size).toBeLessThanOrEqual(1);
    const text = r.hits.map((h) => h.excerpt).join("\n");
    expect(text.includes("AMARKER") && text.includes("BMARKER")).toBe(false);
    gens.forEach((g) => generationsSeen.add(g));
    // Lexical search never awaits, so yield or the child's exit callback never runs.
    await Bun.sleep(5);
  }
  expect(await child.exited).toBe(0);
  expect(searches).toBeGreaterThan(10);
  // The readers actually observed several generations switching underneath them.
  expect(generationsSeen.size).toBeGreaterThan(1);
  d.close();
}, 120_000);

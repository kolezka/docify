import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "svelte/compiler";

const WEB = join(import.meta.dir, "..", "src", "web");

// A local named `state`, `derived` or `effect` turns `$state` into a store read. The component
// still compiles and the bundle builds, but it throws when it mounts and the view stays empty.
test("no component shadows a rune with a local of the same name", () => {
  const files = [...new Bun.Glob("**/*.svelte").scanSync(WEB)].sort();
  expect(files.length).toBeGreaterThan(10);
  const conflicts: string[] = [];
  for (const file of files) {
    const { warnings } = compile(readFileSync(join(WEB, file), "utf8"), { filename: file, generate: "client" });
    for (const w of warnings) if (w.code === "store_rune_conflict") conflicts.push(`${file}:${w.start?.line}`);
  }
  expect(conflicts).toEqual([]);
});

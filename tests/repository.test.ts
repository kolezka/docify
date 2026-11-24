import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { rmSync, symlinkSync } from "node:fs";
import { newDocify, tempDir, writeDocs } from "./helpers.ts";
import { readRepositoryTree } from "../src/core/repository.ts";
import { DEFAULT_LIMITS } from "../src/core/collect.ts";
import { normalize } from "../src/core/normalize.ts";

test("register and reopen a repository without contacting its host", () => {
  const home = tempDir();
  let d = newDocify(home);
  try {
    const s = d.addSource({ library: "sample", kind: "git", locator: "https://example.invalid/sample.git" });
    d.close();
    d = newDocify(home);
    expect(d.requireSource(s.id).kind).toBe("git");
    expect(d.listSourceRows()[0]?.kind).toBe("git");
    expect(d.requireSource(s.id).active_generation).toBeNull();
    for (const locator of ["file:///tmp/sample", "http://example.invalid/sample", "https://user:secret@example.invalid/sample"]) {
      expect(() => d.addSource({ library: "bad", kind: "git", locator })).toThrow(/HTTPS repository URL/);
    }
  } finally { d.close(); rmSync(home, { recursive: true, force: true }); }
});

test("collect committed docs and source verbatim, skip links, binary and ignored files", async () => {
  const root = tempDir();
  const code = 'export function identity(value: string) {\n  return value;\n}\n';
  try {
    writeDocs(root, { README: "Project guide", "main.ts": code, "binary.ts": "a\0b", "ignored.py": "print(1)" });
    symlinkSync("README", join(root, "link.md"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
    git("init", "--quiet", "--template="); git("add", ".");
    git("-c", "user.email=test@example.invalid", "-c", "user.name=Test", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture");
    const tree = join(root, ".git");
    const files = await readRepositoryTree(tree, DEFAULT_LIMITS, [/^ignored/]);
    expect(files.map(f => f.path)).toEqual(["README", "main.ts"]);
    const impl = files[1]!;
    expect(normalize(new TextDecoder().decode(impl.bytes), impl.kind).markdown).toBe(code);
    await expect(readRepositoryTree(tree, { ...DEFAULT_LIMITS, maxTotalBytes: 2 }, [])).rejects.toThrow("collection limits");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { newDocify, tempDir, writeDocs } from "./helpers.ts";
import { collectRepository, readRepositoryTree } from "../src/core/repository.ts";
import { DEFAULT_LIMITS } from "../src/core/collect.ts";
import { normalize } from "../src/core/normalize.ts";

test("update pulls a new commit, reports no change, and logs a failed pull", async () => {
  const root = tempDir();
  const remote = join(root, "upstream");
  const bin = join(root, "bin");
  const cache = join(root, "cache");
  const url = "https://example.invalid/project.git";
  const originalPath = process.env.PATH;
  const realGit = Bun.which("git")!;
  const messages: string[] = [];
  const collect = () => collectRepository(url, DEFAULT_LIMITS, [], undefined, cache, (_level, text) => messages.push(text));
  const git = (...args: string[]) => execFileSync(realGit, args, { cwd: remote });
  try {
    mkdirSync(remote);
    git("init", "--quiet", "--template=");
    const commit = (text: string) => {
      writeDocs(remote, { "README.md": text });
      git("add", ".");
      git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", text);
    };
    commit("first");
    // Rewrite only the fixture URL; clone and pull still execute real Git.
    writeDocs(bin, { git: `#!/bin/sh\nexport GIT_ALLOW_PROTOCOL=file\nprintf '%s\\n' "$*" >> '${root}/commands'\nexec "${realGit}" -c 'url.file://${remote}.insteadOf=${url}' "$@"\n` });
    chmodSync(join(bin, "git"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    expect((await collect())[0]?.bytes.toString()).toBe("first");
    commit("second");
    messages.length = 0;
    expect((await collect())[0]?.bytes.toString()).toBe("second");
    const commands = readFileSync(join(root, "commands"), "utf8").split("\n");
    expect(commands.filter(line => line.includes(" clone "))).toHaveLength(1);
    expect(commands.filter(line => line.includes(" pull --ff-only "))).toHaveLength(1);
    expect(readdirSync(cache)).toEqual([".git"]);
    expect(messages.join("\n")).toContain("git pull --ff-only");
    expect(messages.join("\n")).toContain(git("rev-parse", "--short", "HEAD").toString().trim());
    messages.length = 0;
    await collect();
    expect(messages.join("\n")).toContain("Already up to date");
    rmSync(remote, { recursive: true });
    await expect(collect()).rejects.toThrow();
    expect(messages.at(-1)).toContain("git pull failed");
  } finally { process.env.PATH = originalPath; rmSync(root, { recursive: true, force: true }); }
});

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

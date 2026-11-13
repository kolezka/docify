import { expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { $ } from "bun";
import { VERSION, compareVersions, requireVersion } from "../src/version.ts";
import { VERSION_FILES, nextVersion, readVersions, release } from "../scripts/release.ts";
import { tempDir } from "./helpers.ts";

const repoRoot = join(import.meta.dir, "..");

test("package.json, both plugin manifests and the version the plugins require all agree", () => {
  const versions = readVersions(repoRoot);
  expect(versions.length).toBe(VERSION_FILES.length);
  for (const v of versions) expect({ path: v.path, version: v.version }).toEqual({ path: v.path, version: VERSION });
  // A manifest or MCP config added later must be listed, or release would leave it behind.
  const manifests = ["integrations/**/{plugin.json,.mcp.json}", "integrations/**/dsh/package.json"].flatMap((pattern) => [...new Bun.Glob(pattern).scanSync({ cwd: repoRoot, dot: true })]);
  expect(manifests).toContain("integrations/claude-code/docify/.claude-plugin/plugin.json");
  expect(manifests).toContain("integrations/codex/docify/.codex-plugin/plugin.json");
  expect(manifests).toContain("integrations/codex/docify/.mcp.json");
  expect(manifests).toContain("integrations/claude-code/docify/dsh/package.json");
  for (const path of manifests) expect(VERSION_FILES.map((f) => f.path)).toContain(path);
});

test("requireVersion accepts the same or a newer docify and refuses an older one", () => {
  expect(() => requireVersion("1.2.3", "1.2.3")).not.toThrow();
  expect(() => requireVersion("1.2.3", "1.10.0")).not.toThrow();
  expect(() => requireVersion("1.10.0", "1.9.9")).toThrow("needs docify 1.10.0 or newer, but the docify on PATH is 1.9.9");
  expect(() => requireVersion("1.2", "1.2.3")).toThrow("not a version");
  expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
});

test("nextVersion bumps each part and refuses an explicit version that is not newer", () => {
  expect(nextVersion("1.2.3", "patch")).toBe("1.2.4");
  expect(nextVersion("1.2.3", "minor")).toBe("1.3.0");
  expect(nextVersion("1.2.3", "major")).toBe("2.0.0");
  expect(nextVersion("1.2.3", "1.4.0")).toBe("1.4.0");
  expect(() => nextVersion("1.2.3", "1.2.3")).toThrow("not newer");
  expect(() => nextVersion("1.2.3", "next")).toThrow("not a version");
});

test("docify --version prints the version, and mcp --require refuses an older docify before serving", async () => {
  const cli = join(repoRoot, "src", "cli.ts");
  const version = Bun.spawnSync(["bun", cli, "--version"], { stdout: "pipe", stderr: "pipe" });
  expect([version.exitCode, version.stdout.toString().trim()]).toEqual([0, VERSION]);
  const old = Bun.spawnSync(["bun", cli, "mcp", "--require", "999.0.0"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, DOCIFY_HOME: tempDir() } });
  expect(old.exitCode).toBe(1);
  expect(old.stderr.toString()).toContain(`error (version_mismatch): this plugin needs docify 999.0.0 or newer, but the docify on PATH is ${VERSION}`);
  expect(old.stdout.toString()).toBe("");
});

async function fixtureRepo() {
  const root = tempDir("docify-release-");
  for (const { path } of VERSION_FILES) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(repoRoot, path), join(root, path));
  }
  const git = (args: string[]) => $`git ${args}`.cwd(root).quiet();
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "test@example.test"]);
  await git(["config", "user.name", "test"]);
  await git(["config", "commit.gpgsign", "false"]);
  await git(["config", "tag.gpgsign", "false"]);
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "chore: initial"]);
  const commit = async (subject: string) => {
    writeFileSync(join(root, "notes.txt"), subject);
    await git(["add", "notes.txt"]);
    await git(["commit", "-q", "-m", subject]);
  };
  return { root, git, commit };
}

test("release bumps every version file, writes the changelog from commits since the last tag, commits and tags", async () => {
  const { root, git, commit } = await fixtureRepo();
  await commit("feat: search by symbol");
  await commit("fix(crawl): keep the query string");
  await commit("feat!: drop the old store path");

  const first = await release(root, "minor", { date: "2026-11-09" });
  const [major, minor] = VERSION.split(".").map(Number);
  const expected = `${major}.${minor! + 1}.0`;
  expect(first.version).toBe(expected);
  expect(readVersions(root).map((v) => v.version)).toEqual(VERSION_FILES.map(() => expected));
  expect(JSON.parse(readFileSync(join(root, "integrations/codex/docify/.mcp.json"), "utf8")).mcpServers.docify.args).toEqual(["mcp", "--require", expected]);
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  expect(changelog).toStartWith(`# Changelog\n\n## ${expected} (2026-11-09)\n\n### Breaking changes\n\n- feat!: drop the old store path\n\n### Features\n\n- feat: search by symbol\n\n### Fixes\n\n- fix(crawl): keep the query string\n`);
  expect((await git(["log", "-1", "--format=%s"]).text()).trim()).toBe(`chore: release v${expected}`);
  expect((await git(["tag", "--points-at", "HEAD"]).text()).trim()).toBe(`v${expected}`);
  expect((await git(["status", "--porcelain"]).text()).trim()).toBe("");

  await commit("perf: cache vectors");
  const second = await release(root, "patch", { date: "2026-11-10" });
  expect(second.section).toBe(`## ${major}.${minor! + 1}.1 (2026-11-10)\n\n### Performance\n\n- perf: cache vectors\n`);
  const after = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  expect(after.indexOf(`## ${major}.${minor! + 1}.1`)).toBeLessThan(after.indexOf(`## ${expected}`));
  expect(after.match(/search by symbol/g)?.length).toBe(1);
});

test("release refuses a dirty tree, disagreeing versions and an existing tag, and writes nothing", async () => {
  const { root, git, commit } = await fixtureRepo();
  writeFileSync(join(root, "notes.txt"), "uncommitted");
  await expect(release(root, "patch")).rejects.toThrow("working tree has changes");
  await commit("fix: something");

  const codex = join(root, "integrations/codex/docify/.mcp.json");
  writeFileSync(codex, readFileSync(codex, "utf8").replace(VERSION, "0.0.1"));
  await git(["commit", "-qam", "chore: drift"]);
  await expect(release(root, "patch")).rejects.toThrow(`integrations/codex/docify/.mcp.json=0.0.1`);
  writeFileSync(codex, readFileSync(codex, "utf8").replace("0.0.1", VERSION));
  await git(["commit", "-qam", "chore: undrift"]);

  const taken = nextVersion(VERSION, "patch");
  await git(["tag", `v${taken}`]);
  await expect(release(root, "patch")).rejects.toThrow(`tag v${taken} already exists`);
  expect(readVersions(root).map((v) => v.version)).toEqual(VERSION_FILES.map(() => VERSION));
  expect((await git(["status", "--porcelain"]).text()).trim()).toBe("");
});

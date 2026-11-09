#!/usr/bin/env bun
// Bumps the shared version in package.json and both agent plugins, writes a CHANGELOG.md section
// from the Conventional Commits since the last tag, then commits and tags. It never pushes.
//
//   bun scripts/release.ts <patch|minor|major|X.Y.Z> [--dry-run]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { compareVersions, parseVersion } from "../src/version.ts";

// Every file that carries the version, and the pattern that holds it. tests/version.test.ts
// checks that they all agree.
export const VERSION_FILES: { path: string; pattern: RegExp }[] = [
  { path: "package.json", pattern: /("version":\s*")([^"]+)(")/ },
  { path: "integrations/claude-code/docify/.claude-plugin/plugin.json", pattern: /("version":\s*")([^"]+)(")/ },
  { path: "integrations/claude-code/docify/.claude-plugin/plugin.json", pattern: /("--require",\s*")([^"]+)(")/ },
  { path: "integrations/codex/docify/.codex-plugin/plugin.json", pattern: /("version":\s*")([^"]+)(")/ },
  { path: "integrations/codex/docify/.mcp.json", pattern: /("--require",\s*")([^"]+)(")/ },
];

export function readVersions(root: string): { path: string; version: string | null }[] {
  return VERSION_FILES.map(({ path, pattern }) => ({ path, version: pattern.exec(readFileSync(join(root, path), "utf8"))?.[2] ?? null }));
}

export function nextVersion(current: string, bump: string): string {
  const [major, minor, patch] = parseVersion(current);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  parseVersion(bump);
  if (compareVersions(bump, current) <= 0) throw new Error(`${bump} is not newer than ${current}`);
  return bump;
}

const SECTIONS: [RegExp, string][] = [
  [/^\w+(\([^)]*\))?!:/, "Breaking changes"],
  [/^feat(\([^)]*\))?:/, "Features"],
  [/^fix(\([^)]*\))?:/, "Fixes"],
  [/^perf(\([^)]*\))?:/, "Performance"],
];

export function changelogSection(version: string, date: string, subjects: string[]): string {
  const groups = new Map<string, string[]>();
  for (const subject of subjects) {
    if (/^chore(\([^)]*\))?: release v/.test(subject)) continue;
    const title = SECTIONS.find(([re]) => re.test(subject))?.[1] ?? "Other";
    groups.set(title, [...(groups.get(title) ?? []), subject]);
  }
  const order = [...SECTIONS.map(([, t]) => t), "Other"];
  const body = order
    .filter((t) => groups.has(t))
    .map((t) => `### ${t}\n\n${groups.get(t)!.map((s) => `- ${s}`).join("\n")}\n`)
    .join("\n");
  return `## ${version} (${date})\n\n${body || "No changes recorded.\n"}`;
}

export async function release(root: string, bump: string, opts: { dryRun?: boolean; date?: string } = {}) {
  const git = (strings: TemplateStringsArray, ...values: Parameters<typeof $>[1][]) => $(strings, ...values).cwd(root).quiet();
  if ((await git`git status --porcelain`.text()).trim()) throw new Error("the working tree has changes; commit or stash them first");

  const versions = readVersions(root);
  const current = versions[0]!.version!;
  const stray = versions.filter((v) => v.version !== current);
  if (stray.length) throw new Error(`versions disagree with package.json ${current}: ${stray.map((v) => `${v.path}=${v.version}`).join(", ")}`);
  const version = nextVersion(current, bump);
  const tag = `v${version}`;
  if ((await git`git tag --list ${tag}`.text()).trim()) throw new Error(`tag ${tag} already exists`);

  const lastTag = (await $`git describe --tags --abbrev=0 --match ${"v*"}`.cwd(root).quiet().nothrow().text()).trim();
  const range = lastTag ? [`${lastTag}..HEAD`] : [];
  const subjects = (await git`git log --no-merges --format=%s ${range}`.text()).split("\n").filter(Boolean);
  const section = changelogSection(version, opts.date ?? new Date().toISOString().slice(0, 10), subjects);
  if (opts.dryRun) return { version, tag, section, written: false };

  for (const { path, pattern } of VERSION_FILES) {
    const file = join(root, path);
    writeFileSync(file, readFileSync(file, "utf8").replace(pattern, `$1${version}$3`));
  }
  const changelog = join(root, "CHANGELOG.md");
  const existing = existsSync(changelog) ? readFileSync(changelog, "utf8").replace(/^# Changelog\n+/, "") : "";
  writeFileSync(changelog, `# Changelog\n\n${section}\n${existing}`);

  const files = [...new Set(VERSION_FILES.map((f) => f.path)), "CHANGELOG.md"];
  await git`git add -- ${files}`;
  await git`git commit -m ${`chore: release ${tag}`}`;
  await git`git tag -a ${tag} -m ${`docify ${version}`}`;
  return { version, tag, section, written: true };
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const bump = args.find((a) => !a.startsWith("--"));
  if (!bump) {
    console.error("usage: bun scripts/release.ts <patch|minor|major|X.Y.Z> [--dry-run]");
    process.exit(2);
  }
  try {
    const r = await release(join(import.meta.dir, ".."), bump, { dryRun: args.includes("--dry-run") });
    console.log(r.section);
    console.log(r.written ? `Committed and tagged ${r.tag}. Push with: git push --follow-tags` : `Dry run: nothing written for ${r.tag}.`);
  } catch (err) {
    console.error(`release failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

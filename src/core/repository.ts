import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { kindFromPath } from "./normalize.ts";
import type { CollectLog, CrawlLimits, RawDoc } from "./collect.ts";

const exec = promisify(execFile);
const codeFile = /\.(?:[cm]?[jt]sx?|pyi?|rb|rs|go|java|kt[s]?|swift|[ch](?:pp|xx)?|cc|cs|fs|scala|php|lua|sh|bash|zsh|sql|vue|svelte|css|scss|dart|exs?|erl|hs|ml|zig|m|mm)$/i;

export function repositoryUrl(input: string): string {
  const u = URL.canParse(input) ? new URL(input) : null;
  if (!u || u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname === "/") {
    throw new Error("Use an HTTPS repository URL without credentials, query or fragment");
  }
  return u.href;
}

export async function collectRepository(locator: string, limits: CrawlLimits, ignore: RegExp[], signal: AbortSignal | undefined, cache: string, log: CollectLog): Promise<RawDoc[]> {
  const url = repositoryUrl(locator);
  const parent = dirname(cache);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const git = async (cwd: string, ...args: string[]) => (await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "http.followRedirects=false", ...args], {
    cwd, maxBuffer: 1024 * 1024, timeout: limits.timeoutMs, signal,
    env: { PATH: process.env.PATH, HOME: parent, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https", LC_ALL: "C" },
  })).stdout.trim();
  const cached = await stat(cache).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; return null; });
  if (!cached) {
    log("info", "git clone: initializing repository cache");
    const staging = await mkdtemp(join(parent, ".clone-"));
    try {
      await git(parent, "clone", "--no-checkout", "--depth=1", "--single-branch", "--no-tags", "--template=", "--", url, staging);
      // Pull needs a worktree, but collection reads blobs. Keep every remote path out of the worktree.
      await git(staging, "sparse-checkout", "set", "--no-cone", "!/*");
      await git(staging, "read-tree", "-mu", "HEAD");
      await rename(staging, cache);
    } finally { await rm(staging, { recursive: true, force: true }); }
    log("info", `git clone: indexed revision selected: ${await git(cache, "rev-parse", "--short", "HEAD")}`);
  } else {
    const before = await git(cache, "rev-parse", "HEAD");
    log("info", "git pull --ff-only: checking upstream");
    try { await git(cache, "pull", "--ff-only", "--no-rebase", "--no-recurse-submodules", url, "HEAD"); }
    catch (err) { log("warn", "git pull failed; repository was not indexed"); throw err; }
    const after = await git(cache, "rev-parse", "HEAD");
    log("info", before === after ? `git pull: Already up to date (${after.slice(0, 12)})` : `git pull: ${before.slice(0, 12)} -> ${after.slice(0, 12)}`);
  }
  return readRepositoryTree(join(cache, ".git"), limits, ignore, signal);
}

export async function readRepositoryTree(repo: string, limits: CrawlLimits, ignore: RegExp[], signal?: AbortSignal): Promise<RawDoc[]> {
    const git = async (args: string[], maxBuffer: number) => (await exec("git", args, { encoding: "buffer", maxBuffer, signal, timeout: limits.timeoutMs,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" },
    })).stdout;
    const tree = await git(["--git-dir", repo, "ls-tree", "-rlz", "HEAD"], 16 * 1024 * 1024);
    const docs: RawDoc[] = [];
    let total = 0;
    for (const entry of tree.toString().split("\0")) {
      const match = /^100(?:644|755) blob ([0-9a-f]+) +([0-9]+)\t(.+)$/s.exec(entry);
      if (!match) continue;
      const [, oid, length, path] = match;
      if (!path || path.split("/").some(p => p.startsWith(".") || ["node_modules", "vendor", "dist", "build", "graphify-out"].includes(p)) || ignore.some(r => r.test(path))) continue;
      const kind = kindFromPath(path) ?? (codeFile.test(path) ? "code" : /(?:^|\/)readme$/i.test(path) ? "markdown" : null);
      const size = Number(length);
      if (!kind || !size || size > limits.maxBytesPerPage) continue;
      if (total + size > limits.maxTotalBytes || docs.length >= limits.maxPages * 40) throw new Error("repository exceeds collection limits");
      const bytes = await git(["--git-dir", repo, "cat-file", "blob", oid!], limits.maxBytesPerPage);
      if (bytes.includes(0)) continue;
      total += size;
      docs.push({ path, bytes, kind, url: null });
    }
    if (!docs.length) throw new Error("no supported documentation or source files in repository");
    return docs;
}

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { kindFromPath } from "./normalize.ts";
import type { CrawlLimits, RawDoc } from "./collect.ts";

const exec = promisify(execFile);
const codeFile = /\.(?:[cm]?[jt]sx?|pyi?|rb|rs|go|java|kt[s]?|swift|[ch](?:pp|xx)?|cc|cs|fs|scala|php|lua|sh|bash|zsh|sql|vue|svelte|css|scss|dart|exs?|erl|hs|ml|zig|m|mm)$/i;

export function repositoryUrl(input: string): string {
  const u = URL.canParse(input) ? new URL(input) : null;
  if (!u || u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname === "/") {
    throw new Error("Use an HTTPS repository URL without credentials, query or fragment");
  }
  return u.href;
}

export async function collectRepository(locator: string, limits: CrawlLimits, ignore: RegExp[], signal?: AbortSignal): Promise<RawDoc[]> {
  const url = repositoryUrl(locator);
  const tmp = await mkdtemp(join(tmpdir(), "docify-repo-"));
  const repo = join(tmp, "repo.git");
  // A bare clone never checks out untrusted paths, runs checkout filters or follows symlinks.
  const git = async (args: string[], maxBuffer: number) => (await exec("git", args, {
    cwd: tmp, maxBuffer, encoding: "buffer", timeout: limits.timeoutMs, signal,
    env: { PATH: process.env.PATH, HOME: tmp, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https", LC_ALL: "C" },
  })).stdout;
  try {
    await git(["-c", "http.followRedirects=false", "clone", "--bare", "--depth=1", "--single-branch", "--no-tags", "--template=", "--", url, repo], 1024 * 1024);
    return await readRepositoryTree(repo, limits, ignore, signal);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
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

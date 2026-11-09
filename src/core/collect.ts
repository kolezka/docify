import { readdirSync, statSync, readFileSync, realpathSync, lstatSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { kindFromPath, type DocKind } from "./normalize.ts";

export interface RawDoc {
  path: string; // relative path or URL path, unique within the snapshot
  url: string | null;
  kind: DocKind;
  bytes: Uint8Array;
}

export interface CrawlLimits {
  maxPages: number;
  maxDepth: number;
  maxBytesPerPage: number;
  maxTotalBytes: number;
  maxRedirects: number;
  timeoutMs: number;
}

export const DEFAULT_LIMITS: CrawlLimits = {
  maxPages: 50,
  maxDepth: 2,
  maxBytesPerPage: 5_000_000,
  maxTotalBytes: 50_000_000,
  maxRedirects: 5,
  timeoutMs: 20_000,
};

const SKIP_DIRS = new Set(["node_modules", ".git", "graphify-out"]);

// Symlinks are followed only while they resolve inside the registered root, so a link
// cannot pull files from elsewhere into the store (the UI only vets the root itself).
export function collectLocal(root: string, limits: CrawlLimits = DEFAULT_LIMITS): RawDoc[] {
  const abs = realpathSync(resolve(root));
  const st = statSync(abs);
  const files: string[] = [];
  const skipped: string[] = [];
  const inside = (p: string) => {
    const real = realpathSync(p);
    return real === abs || real.startsWith(abs + sep);
  };
  if (st.isFile()) files.push(abs);
  else {
    const walk = (dir: string) => {
      for (const name of readdirSync(dir).sort()) {
        if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
        const p = join(dir, name);
        if (lstatSync(p).isSymbolicLink() && !inside(p)) {
          skipped.push(p);
          continue;
        }
        const s = statSync(p);
        if (s.isDirectory()) walk(p);
        else if (kindFromPath(p)) files.push(p);
      }
    };
    walk(abs);
  }
  if (skipped.length) console.error(`docify: skipped ${skipped.length} symlink(s) pointing outside ${abs}: ${skipped.slice(0, 3).join(", ")}`);
  let total = 0;
  const docs: RawDoc[] = [];
  for (const f of files) {
    if (docs.length >= limits.maxPages * 40) throw new Error(`more than ${limits.maxPages * 40} documents under ${abs}`);
    const bytes = new Uint8Array(readFileSync(f));
    if (bytes.length > limits.maxBytesPerPage) continue;
    total += bytes.length;
    if (total > limits.maxTotalBytes) throw new Error(`source exceeds ${limits.maxTotalBytes} bytes`);
    docs.push({ path: st.isFile() ? relative(join(abs, ".."), f) : relative(abs, f), url: null, kind: kindFromPath(f)!, bytes });
  }
  if (!docs.length) throw new Error(`no Markdown or HTML files found under ${abs}`);
  return docs;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

// Breadth-first crawl limited to the start URL's origin and directory path.
// Redirects are followed by hand so every hop is checked against the same scope.
export async function crawl(start: string, limits: CrawlLimits = DEFAULT_LIMITS, fetcher: Fetcher = fetch): Promise<RawDoc[]> {
  const startUrl = new URL(start);
  if (!/^https?:$/.test(startUrl.protocol)) throw new Error(`only http(s) URLs are supported: ${start}`);
  const scopePath = startUrl.pathname.endsWith("/") ? startUrl.pathname : startUrl.pathname.replace(/[^/]*$/, "");
  const inScope = (u: URL) => u.origin === startUrl.origin && u.pathname.startsWith(scopePath);
  const canonical = (u: URL) => {
    const c = new URL(u);
    c.hash = "";
    c.search = "";
    return c.toString();
  };

  const fetchInScope = async (url: URL) => {
    let res: Response | null = null;
    let current = url;
    for (let hop = 0; hop <= limits.maxRedirects; hop++) {
      res = await fetcher(current.toString(), { redirect: "manual", signal: AbortSignal.timeout(limits.timeoutMs) });
      if (res.status < 300 || res.status >= 400) break;
      const loc = res.headers.get("location");
      if (!loc) break;
      const next = new URL(loc, current);
      if (!inScope(next)) {
        res = null;
        break;
      }
      current = next;
      if (hop === limits.maxRedirects) throw new Error(`too many redirects from ${url}`);
    }
    return res ? { res, current } : null;
  };

  const queue: { url: URL; depth: number; preferMarkdown?: boolean }[] = [{ url: startUrl, depth: 0 }];
  const seen = new Set([canonical(startUrl)]);
  const collected = new Set<string>();
  const docs: RawDoc[] = [];
  let total = 0;
  while (queue.length && docs.length < limits.maxPages) {
    const { url, depth, preferMarkdown } = queue.shift()!;
    if (collected.has(canonical(url))) continue;
    let fetched = null;
    if (preferMarkdown) {
      const markdownUrl = new URL(url);
      markdownUrl.pathname += ".md";
      try {
        fetched = await fetchInScope(markdownUrl);
      } catch (error) {
        console.error(`docify: Markdown export probe failed for ${markdownUrl}; trying linked route: ${error instanceof Error ? error.message : error}`);
      }
      // A Markdown export can exist even when the linked HTML route is a soft 404.
      const exportType = fetched?.res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (fetched && (!fetched.res.ok || (exportType !== "" && !["text/markdown", "text/x-markdown", "text/plain"].includes(exportType)))) {
        await fetched.res.body?.cancel();
        fetched = null;
      }
    }
    fetched ??= await fetchInScope(url);
    if (!fetched) continue;
    const { res, current } = fetched;
    if (collected.has(canonical(current))) {
      await res.body?.cancel();
      continue;
    }
    if (!res.ok) {
      if (depth === 0) throw new Error(`fetch ${current} failed: HTTP ${res.status}`);
      continue;
    }
    const type = res.headers.get("content-type") ?? "";
    const isMarkdownIndex = /\/llms?\.txt$/i.test(current.pathname);
    const kind: DocKind | null = /text\/html|application\/xhtml/.test(type) ? "html" : /markdown/.test(type) || isMarkdownIndex ? "markdown" : kindFromPath(current.pathname);
    if (!kind) continue;
    const bytes = await readCapped(res, limits.maxBytesPerPage);
    if (!bytes) continue;
    total += bytes.length;
    if (total > limits.maxTotalBytes) throw new Error(`crawl exceeded ${limits.maxTotalBytes} bytes`);
    const path = current.pathname.slice(scopePath.length) || "index.html";
    collected.add(canonical(current));
    docs.push({ path, url: canonical(current), kind, bytes });
    // Ordinary Markdown pages also contain navigation, not just llms.txt indexes.
    if (depth < limits.maxDepth) {
      const text = new TextDecoder().decode(bytes);
      const links = kind === "html"
        ? [...text.matchAll(/href\s*=\s*["']([^"'#]+)(?:#[^"']*)?["']/gi)].map((m) => m[1]!)
        : [...text.matchAll(/(?<!!)\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\s*\)/g)].map((m) => m[1] ?? m[2]!);
      for (const href of links) {
        let link: URL;
        try {
          link = new URL(href, current);
        } catch {
          continue;
        }
        const key = canonical(link);
        // Documentation routes often have no extension, including links from HTML.
        const documentPath = /(\.html?|\/|\.mdx?)$/.test(link.pathname)
          || !/\.[^/]+$/.test(link.pathname);
        if (!inScope(link) || seen.has(key) || !documentPath) continue;
        seen.add(key);
        const preferMarkdown = (kind === "html" || (kind === "markdown" && /\.md$/i.test(current.pathname)))
          && !link.pathname.endsWith("/") && !/\.[^/]+$/.test(link.pathname);
        queue.push({ url: link, depth: depth + 1, preferMarkdown });
      }
    }
  }
  if (!docs.length) throw new Error(`no documents fetched from ${start}`);
  return docs;
}

async function readCapped(res: Response, cap: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > cap) return null;
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > cap) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

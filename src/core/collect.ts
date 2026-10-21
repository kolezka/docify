import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
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

export function collectLocal(root: string, limits: CrawlLimits = DEFAULT_LIMITS): RawDoc[] {
  const abs = resolve(root);
  const st = statSync(abs);
  const files: string[] = [];
  if (st.isFile()) files.push(abs);
  else {
    const walk = (dir: string) => {
      for (const name of readdirSync(dir).sort()) {
        if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
        const p = join(dir, name);
        const s = statSync(p);
        if (s.isDirectory()) walk(p);
        else if (kindFromPath(p)) files.push(p);
      }
    };
    walk(abs);
  }
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

  const queue: { url: URL; depth: number }[] = [{ url: startUrl, depth: 0 }];
  const seen = new Set([canonical(startUrl)]);
  const docs: RawDoc[] = [];
  let total = 0;
  while (queue.length && docs.length < limits.maxPages) {
    const { url, depth } = queue.shift()!;
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
    if (!res) continue;
    if (!res.ok) {
      if (depth === 0) throw new Error(`fetch ${current} failed: HTTP ${res.status}`);
      continue;
    }
    const type = res.headers.get("content-type") ?? "";
    const kind: DocKind | null = /text\/html|application\/xhtml/.test(type) ? "html" : /markdown/.test(type) ? "markdown" : kindFromPath(current.pathname);
    if (!kind) continue;
    const bytes = await readCapped(res, limits.maxBytesPerPage);
    if (!bytes) continue;
    total += bytes.length;
    if (total > limits.maxTotalBytes) throw new Error(`crawl exceeded ${limits.maxTotalBytes} bytes`);
    const path = current.pathname.slice(scopePath.length) || "index.html";
    docs.push({ path, url: canonical(current), kind, bytes });
    if (kind === "html" && depth < limits.maxDepth) {
      const html = new TextDecoder().decode(bytes);
      for (const m of html.matchAll(/href\s*=\s*["']([^"'#]+)(?:#[^"']*)?["']/gi)) {
        let link: URL;
        try {
          link = new URL(m[1]!, current);
        } catch {
          continue;
        }
        const key = canonical(link);
        if (!inScope(link) || seen.has(key) || !/(\.html?|\/|\.mdx?)$/.test(link.pathname)) continue;
        seen.add(key);
        queue.push({ url: link, depth: depth + 1 });
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

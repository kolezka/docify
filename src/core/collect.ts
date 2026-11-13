import { readdirSync, statSync, readFileSync, realpathSync, lstatSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { kindFromPath, type DocKind } from "./normalize.ts";
import { extractPdfText } from "./pdf.ts";

export interface RawDoc {
  path: string; // relative path or URL path, unique within the snapshot
  url: string | null;
  kind: DocKind;
  bytes: Uint8Array;
  extracted?: boolean;
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

// Progress and skip reasons for the application log. Without one, warnings go to stderr as before.
export type CollectLog = (level: "info" | "warn", text: string) => void;
const stderrWarnings: CollectLog = (level, text) => { if (level === "warn") console.error(`docify: ${text}`); };
const kb = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

// Symlinks are followed only while they resolve inside the registered root, so a link
// cannot pull files from elsewhere into the store (the UI only vets the root itself).
export function collectLocal(root: string, limits: CrawlLimits = DEFAULT_LIMITS, log: CollectLog = stderrWarnings): RawDoc[] {
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
  if (skipped.length) log("warn", `Skipped ${skipped.length} symlink(s) pointing outside ${abs}: ${skipped.slice(0, 3).join(", ")}`);
  let total = 0;
  const docs: RawDoc[] = [];
  for (const f of files) {
    if (docs.length >= limits.maxPages * 40) throw new Error(`more than ${limits.maxPages * 40} documents under ${abs}`);
    const bytes = new Uint8Array(readFileSync(f));
    if (bytes.length > limits.maxBytesPerPage) {
      log("warn", `Skipped ${f}: ${kb(bytes.length)} is over the ${kb(limits.maxBytesPerPage)} page limit`);
      continue;
    }
    total += bytes.length;
    if (total > limits.maxTotalBytes) throw new Error(`source exceeds ${limits.maxTotalBytes} bytes`);
    docs.push({ path: st.isFile() ? relative(join(abs, ".."), f) : relative(abs, f), url: null, kind: kindFromPath(f)!, bytes });
  }
  if (!docs.length) throw new Error(`no Markdown or HTML files found under ${abs}`);
  log("info", `Collected ${docs.length} files (${kb(total)}) from ${abs}`);
  return docs;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface CrawlOptions {
  // Cancels the crawl, including a fetch in flight.
  signal?: AbortSignal;
  // Probe `<route>.md` exports before linked routes (default true). Off for a rendering service,
  // where each probe costs a full browser render and plain text comes back wrapped in HTML.
  markdownExports?: boolean;
  pdfFetcher?: Fetcher;
  onAcceptedPage?: (url: string) => void;
  log?: CollectLog;
}

// Breadth-first crawl limited to the start URL's origin and directory path.
// Redirects are followed by hand so every hop is checked against the same scope.
export async function crawl(start: string, limits: CrawlLimits = DEFAULT_LIMITS, fetcher: Fetcher = fetch, options: CrawlOptions = {}): Promise<RawDoc[]> {
  const startUrl = new URL(start);
  if (!/^https?:$/.test(startUrl.protocol)) throw new Error(`only http(s) URLs are supported: ${start}`);
  const scopePath = startUrl.pathname.endsWith("/") ? startUrl.pathname : startUrl.pathname.replace(/[^/]*$/, "");
  const log = options.log ?? stderrWarnings;
  const inScope = (u: URL) => u.origin === startUrl.origin && u.pathname.startsWith(scopePath);
  const canonical = (u: URL) => {
    const c = new URL(u);
    c.hash = "";
    c.search = "";
    return c.toString();
  };

  const fetchInScope = async (url: URL, selectedFetcher: Fetcher = fetcher) => {
    let res: Response | null = null;
    let current = url;
    for (let hop = 0; hop <= limits.maxRedirects; hop++) {
      const timeout = AbortSignal.timeout(limits.timeoutMs);
      res = await selectedFetcher(current.toString(), { redirect: "manual", signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout });
      if (res.status < 300 || res.status >= 400) break;
      const loc = res.headers.get("location");
      if (!loc) break;
      const next = new URL(loc, current);
      if (!inScope(next)) {
        log("warn", `Skipped ${current}: redirects out of scope to ${next}`);
        await res.body?.cancel();
        res = null;
        break;
      }
      await res.body?.cancel();
      log("info", `Redirect ${current} -> ${next} (HTTP ${res.status})`);
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
  log("info", `Crawl ${startUrl} within ${startUrl.origin}${scopePath}: up to ${limits.maxPages} pages, depth ${limits.maxDepth}`);
  while (queue.length && docs.length < limits.maxPages) {
    const { url, depth, preferMarkdown } = queue.shift()!;
    if (collected.has(canonical(url))) continue;
    let fetched = null;
    if (preferMarkdown && options.markdownExports !== false) {
      const markdownUrl = new URL(url);
      markdownUrl.pathname += ".md";
      try {
        fetched = await fetchInScope(markdownUrl);
      } catch (error) {
        log("warn", `Markdown export probe failed for ${markdownUrl}; trying linked route: ${error instanceof Error ? error.message : error}`);
      }
      // A Markdown export can exist even when the linked HTML route is a soft 404.
      const exportType = fetched?.res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (fetched && (!fetched.res.ok || (exportType !== "" && !["text/markdown", "text/x-markdown", "text/plain"].includes(exportType)))) {
        await fetched.res.body?.cancel();
        fetched = null;
      }
    }
    const started = performance.now();
    fetched ??= await fetchInScope(url, options.pdfFetcher && /\.pdf$/i.test(url.pathname) ? options.pdfFetcher : fetcher);
    if (!fetched) continue;
    const { res, current } = fetched;
    if (collected.has(canonical(current))) {
      await res.body?.cancel();
      continue;
    }
    if (!res.ok) {
      if (depth === 0) throw new Error(`fetch ${current} failed: HTTP ${res.status}`);
      await res.body?.cancel();
      log("warn", `Skipped ${current}: HTTP ${res.status}`);
      continue;
    }
    const type = res.headers.get("content-type") ?? "";
    const isPdf = !!options.pdfFetcher && (/^application\/pdf(?:\s*;|\s*$)/i.test(type) || (/\.pdf$/i.test(current.pathname) && /^(?:application\/octet-stream)?(?:\s*;|\s*$)/i.test(type)));
    const isMarkdownIndex = /\/llms?\.txt$/i.test(current.pathname);
    const kind: DocKind | null = isPdf ? "markdown" : /text\/html|application\/xhtml/.test(type) ? "html" : /markdown/.test(type) || isMarkdownIndex ? "markdown" : kindFromPath(current.pathname);
    if (!kind) {
      await res.body?.cancel();
      log("info", `Skipped ${current}: not a document (${type || "no content type"})`);
      continue;
    }
    const bytes = await readCapped(res, limits.maxBytesPerPage);
    if (!bytes) {
      log("warn", `Skipped ${current}: over the ${kb(limits.maxBytesPerPage)} page limit`);
      continue;
    }
    total += bytes.length;
    if (total > limits.maxTotalBytes) throw new Error(`crawl exceeded ${limits.maxTotalBytes} bytes`);
    const path = current.pathname.slice(scopePath.length) || "index.html";
    collected.add(canonical(current));
    let content = bytes;
    if (isPdf) {
      try {
        content = new TextEncoder().encode(await extractPdfText(bytes));
      } catch (error) {
        throw new Error(`failed to extract PDF ${current}: ${error instanceof Error ? error.message : error}`);
      }
    }
    docs.push({ path, url: canonical(current), kind, bytes: content, ...(isPdf ? { extracted: true } : {}) });
    options.onAcceptedPage?.(current.toString());
    let queued = 0;
    // Ordinary Markdown pages also contain navigation, not just llms.txt indexes.
    if (!isPdf && depth < limits.maxDepth) {
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
          || (!!options.pdfFetcher && /\.pdf$/i.test(link.pathname))
          || !/\.[^/]+$/.test(link.pathname);
        if (!inScope(link) || seen.has(key) || !documentPath) continue;
        seen.add(key);
        const preferMarkdown = (kind === "html" || (kind === "markdown" && /\.md$/i.test(current.pathname)))
          && !link.pathname.endsWith("/") && !/\.[^/]+$/.test(link.pathname);
        queue.push({ url: link, depth: depth + 1, preferMarkdown });
        queued++;
      }
    }
    log("info", `Fetched ${current} (${docs.length}/${limits.maxPages}, ${isPdf ? "pdf" : kind}, ${kb(bytes.length)}, depth ${depth}, ${queued} new links, ${Math.round(performance.now() - started)} ms)`);
  }
  if (queue.length) log("warn", `Stopped at the ${limits.maxPages} page limit; ${queue.length} queued links were not fetched`);
  if (!docs.length) throw new Error(`no documents fetched from ${start}`);
  log("info", `Crawl finished: ${docs.length} pages, ${kb(total)}`);
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

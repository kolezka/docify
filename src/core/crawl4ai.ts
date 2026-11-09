import { NodeHtmlMarkdown } from "node-html-markdown";
import type { Fetcher } from "./collect.ts";
import { decodeCrawl4aiArtifact } from "./crawl4ai-artifacts.ts";

// Optional collection through a Crawl4AI server (Docker image, POST /crawl), for documentation
// that only renders with JavaScript. Docify keeps its own breadth-first crawl, scope checks and
// limits: the service renders exactly one URL per request and never runs a deep crawl.
// Request and response shape: https://docs.crawl4ai.com/core/self-hosting/ (v0.9.x) and
// deploy/docker/api.py handle_crawl_request: { success, results: [CrawlResult.model_dump()] }.

export interface Crawl4aiOptions {
  url: string; // service base URL, e.g. http://127.0.0.1:11235
  apiKey: string | undefined; // the value; callers resolve it from the configured variable name
  apiKeyEnv: string; // the variable name, only used in messages
  timeoutMs: number;
  maxBytesPerPage: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  capture?: {
    startUrl: string;
    screenshot?: boolean;
    pdf?: boolean;
    maxBytes: number;
    onArtifacts: (artifacts: { screenshot?: Uint8Array; pdf?: Uint8Array }) => void;
  };
}

export interface Crawl4aiRenderOptions {
  stream?: boolean;
  waitUntil?: string;
  waitFor?: string;
  delayBeforeReturnHtml?: number;
  scanFullPage?: boolean;
}

export class Crawl4aiError extends Error {}

// The JSON carries html, cleaned_html, markdown and links for one page, so it is several times
// the page itself; anything far beyond that is not a response Docify should buffer.
const jsonCap = (maxBytesPerPage: number) => maxBytesPerPage * 8 + 1_000_000;

export function crawl4aiServiceUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Crawl4aiError("crawl4aiUrl is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Crawl4aiError("crawl4aiUrl must use http or https");
  // Credentials in the URL would end up in errors and logs; the key goes in crawl4aiApiKeyEnv.
  if (url.username || url.password) throw new Crawl4aiError("crawl4aiUrl must not contain credentials; put the token in the variable named by crawl4aiApiKeyEnv");
  return url;
}

// A Fetcher for crawl(): every call renders one page through the service and is turned back into
// a plain Response, so crawl() applies the same scope, redirect, depth and size rules as always.
// A browser-side redirect becomes a synthetic 302 to redirected_url; the rendered result is kept
// for the follow-up call so the page is not rendered twice.
export function crawl4aiFetcher(opts: Crawl4aiOptions, render: Crawl4aiRenderOptions = {}): Fetcher & { acceptPage(url: string): void } {
  if (opts.capture && (!Number.isSafeInteger(opts.capture.maxBytes) || opts.capture.maxBytes <= 0 || opts.capture.maxBytes > 100_000_000)) {
    throw new Crawl4aiError("Invalid artifact byte limit");
  }
  const endpoint = new URL(render.stream ? "crawl/stream" : "crawl", crawl4aiServiceUrl(opts.url).toString().replace(/\/*$/, "/"));
  const doFetch = opts.fetchImpl ?? fetch;
  const pending = new Map<string, { html: string; status: number }>();
  const secret = opts.apiKey;
  const scrub = (s: string) => (secret ? s.split(secret).join("<redacted>") : s).slice(0, 300);

  let captured: { url: string; result: Record<string, unknown> } | undefined;
  const fetcher: Fetcher = async (target: string): Promise<Response> => {
    const cached = pending.get(target);
    if (cached) {
      pending.delete(target);
      return page(cached.html, cached.status, target);
    }
    const signals = [AbortSignal.timeout(opts.timeoutMs)];
    if (opts.signal) signals.push(opts.signal);
    const signal = AbortSignal.any(signals);
    const headers: Record<string, string> = { "content-type": "application/json", accept: render.stream ? "application/x-ndjson" : "application/json" };
    if (secret) headers.authorization = `Bearer ${secret}`;
    const capture = opts.capture && sameUrl(target, opts.capture.startUrl) === true ? opts.capture : undefined;
    const body = {
      urls: [target],
      browser_config: { type: "BrowserConfig", params: { headless: true } },
      crawler_config: { type: "CrawlerRunConfig", params: {
        cache_mode: "bypass", stream: render.stream ?? false,
        ...(capture?.screenshot && { screenshot: true }),
        ...(capture?.pdf && { pdf: true }),
        ...(render.waitUntil !== undefined && { wait_until: render.waitUntil }),
        ...(render.waitFor !== undefined && { wait_for: render.waitFor }),
        ...(render.delayBeforeReturnHtml !== undefined && { delay_before_return_html: render.delayBeforeReturnHtml }),
        ...(render.scanFullPage !== undefined && { scan_full_page: render.scanFullPage }),
      } },
    };
    let res: Response;
    let text: string;
    try {
      res = await doFetch(endpoint.toString(), { method: "POST", headers, body: JSON.stringify(body), signal, redirect: "error" });
      const artifactCap = capture ? Math.ceil(capture.maxBytes / 3) * 4 * (Number(!!capture.screenshot) + Number(!!capture.pdf)) : 0;
      text = await readTextCapped(res, jsonCap(opts.maxBytesPerPage) + artifactCap);
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? err;
      if (signal.aborted) throw new Crawl4aiError(`Crawl4AI at ${endpoint.origin} timed out after ${opts.timeoutMs} ms rendering ${target}`);
      throw new Crawl4aiError(`Crawl4AI at ${endpoint.origin} failed for ${target}: ${scrub(err instanceof Error ? err.message : String(err))}`);
    }
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? ` (check the token in ${opts.apiKeyEnv})` : "";
      throw new Crawl4aiError(`Crawl4AI at ${endpoint.origin} answered HTTP ${res.status} for ${target}${hint}: ${scrub(text)}`);
    }
    const result = render.stream ? parseStream(text, target, scrub) : parseResult(text, target);
    // Missing metadata is a service error, never a site-level 404 that drops a page.
    if (typeof result.success !== "boolean") throw new Crawl4aiError(`Crawl4AI response for ${target} has invalid success`);
    if (typeof result.html !== "string") throw new Crawl4aiError(`Crawl4AI response for ${target} has no html`);
    if (result.status_code != null && (typeof result.status_code !== "number" || !Number.isInteger(result.status_code) || result.status_code < 200 || result.status_code > 599)) {
      throw new Crawl4aiError(`Crawl4AI response for ${target} has invalid status_code`);
    }
    if (result.redirected_url != null && typeof result.redirected_url !== "string") throw new Crawl4aiError(`Crawl4AI response for ${target} has invalid redirected_url`);
    if (result.redirected_status_code != null && (typeof result.redirected_status_code !== "number" || !Number.isInteger(result.redirected_status_code) || result.redirected_status_code < 200 || result.redirected_status_code > 599)) {
      throw new Crawl4aiError(`Crawl4AI response for ${target} has invalid redirected_status_code`);
    }
    const status = typeof result.redirected_status_code === "number" ? result.redirected_status_code : typeof result.status_code === "number" ? result.status_code : 200;
    if (result.success === false) {
      // A page the site itself refuses (404 and the like) is a page result, not a service failure.
      if (status >= 400) {
        const finalUrl = typeof result.redirected_url === "string" && result.redirected_url ? result.redirected_url : target;
        if (sameUrl(finalUrl, target) === null) throw new Crawl4aiError(`Crawl4AI response for ${target} has an invalid redirected_url`);
        if (!sameUrl(finalUrl, target)) {
          pending.set(finalUrl, { html: "", status });
          return new Response(null, { status: 302, headers: { location: finalUrl } });
        }
        return page("", status, target);
      }
      const why = typeof result.error_message === "string" ? result.error_message : "no error message";
      throw new Crawl4aiError(`Crawl4AI could not render ${target}: ${scrub(why)}`);
    }
    const finalUrl = typeof result.redirected_url === "string" && result.redirected_url ? result.redirected_url : target;
    if (sameUrl(finalUrl, target) === null) throw new Crawl4aiError(`Crawl4AI response for ${target} has an invalid redirected_url`);
    if (capture) captured = { url: finalUrl, result };
    if (!sameUrl(finalUrl, target)) {
      pending.set(finalUrl, { html: result.html, status });
      return new Response(null, { status: 302, headers: { location: finalUrl } });
    }
    return page(result.html, status, target);
  };
  return Object.assign(fetcher, {
    acceptPage(url: string) {
      if (!captured || !opts.capture || sameUrl(captured.url, url) !== true) return;
      const result = captured.result;
      captured = undefined;
      const artifacts: { screenshot?: Uint8Array; pdf?: Uint8Array } = {};
      if (opts.capture.screenshot) artifacts.screenshot = decodeCrawl4aiArtifact(result.screenshot, "screenshot", opts.capture.maxBytes);
      if (opts.capture.pdf) artifacts.pdf = decodeCrawl4aiArtifact(result.pdf, "pdf", opts.capture.maxBytes);
      opts.capture.onArtifacts(artifacts);
    },
  });
}

function page(html: string, status: number, url: string) {
  const markdown = /(?:\.mdx?|\/llms?\.txt)$/i.test(new URL(url).pathname);
  // Browsers wrap text documents in <pre>; keep their Markdown links and decode entities.
  const content = markdown ? NodeHtmlMarkdown.translate(html, {}, {
    pre: ({ node }) => ({ content: node.textContent, recurse: false, noEscape: true }),
  }) : html;
  const bytes = new TextEncoder().encode(content);
  return new Response(status === 204 || status === 304 ? null : bytes, {
    status: status >= 200 && status <= 599 ? status : 502,
    headers: { "content-type": markdown ? "text/markdown; charset=utf-8" : "text/html; charset=utf-8", "content-length": String(bytes.length) },
  });
}

// null when `a` is not a URL at all.
function sameUrl(a: string, b: string): boolean | null {
  try {
    return new URL(a).toString() === new URL(b).toString();
  } catch {
    return null;
  }
}

function parseResult(text: string, target: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Crawl4aiError(`Crawl4AI response for ${target} is not JSON`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Crawl4aiError(`Crawl4AI response for ${target} is not a JSON object`);
  const d = data as Record<string, unknown>;
  if (d.success !== true) throw new Crawl4aiError(`Crawl4AI reported failure for ${target}`);
  if (!Array.isArray(d.results) || d.results.length !== 1) throw new Crawl4aiError(`Crawl4AI response for ${target} must have exactly one result`);
  const r = d.results[0];
  if (typeof r !== "object" || r === null || Array.isArray(r)) throw new Crawl4aiError(`Crawl4AI result for ${target} is not an object`);
  const result = r as Record<string, unknown>;
  if (typeof result.url !== "string" || sameUrl(result.url, target) !== true) throw new Crawl4aiError(`Crawl4AI result for ${target} is for another URL`);
  return result;
}

function parseStream(text: string, target: string, scrub: (text: string) => string): Record<string, unknown> {
  let result: unknown;
  let completed = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let item: unknown;
    try {
      item = JSON.parse(line);
    } catch {
      throw new Crawl4aiError(`Crawl4AI stream response for ${target} is not JSON`);
    }
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Crawl4aiError(`Crawl4AI stream response for ${target} is not a JSON object`);
    const record = item as Record<string, unknown>;
    if (record.status === "error" || record.error !== undefined) {
      const why = typeof record.error === "string" ? scrub(record.error) : "unknown error";
      throw new Crawl4aiError(`Crawl4AI stream failed for ${target}: ${why}`);
    }
    if (record.status === "completed") {
      if (completed) throw new Crawl4aiError(`Crawl4AI stream for ${target} has duplicate completion`);
      completed = true;
    } else {
      if (completed || result !== undefined) throw new Crawl4aiError(`Crawl4AI stream for ${target} must have exactly one result`);
      result = record;
    }
  }
  if (!completed) throw new Crawl4aiError(`Crawl4AI stream for ${target} is missing completion`);
  return parseResult(JSON.stringify({ success: true, results: result === undefined ? [] : [result] }), target);
}

async function readTextCapped(res: Response, cap: number): Promise<string> {
  if (Number(res.headers.get("content-length") ?? 0) > cap) {
    await res.body?.cancel();
    throw new Crawl4aiError(`response is larger than ${cap} bytes`);
  }
  const reader = res.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > cap) {
      await reader.cancel();
      throw new Crawl4aiError(`response is larger than ${cap} bytes`);
    }
    parts.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}

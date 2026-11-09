import type { Fetcher } from "./collect.ts";
import { NodeHtmlMarkdown } from "node-html-markdown";

// Browserless /function: https://docs.browserless.io/rest-apis/function
// Intercept later main-frame requests before they are sent. crawl() checks each returned
// Location against its scope. This is not a network sandbox: subresources, frames,
// popups, service workers and browser activity outside this page are not confined.
const code = `export default async ({ page, context }) => {
  let redirect = null;
  let firstNavigation = true;
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      if (!firstNavigation) {
        redirect = request.url();
        void request.abort();
        return;
      }
      firstNavigation = false;
    }
    void request.continue();
  });
  let response;
  try { response = await page.goto(context.url, { waitUntil: 'networkidle2', timeout: context.timeoutMs }); }
  catch (error) { if (!redirect) throw error; }
  if (redirect) return { data: { redirect }, type: 'application/json' };
  if (!response) throw new Error('navigation returned no response');
  const html = await page.content();
  return { data: { status: response.status(), url: page.url(), html }, type: 'application/json' };
}`;

export interface BrowserlessOptions {
  url: string;
  apiKey?: string;
  timeoutMs: number;
  maxBytesPerPage: number;
  signal?: AbortSignal;
  fetchImpl?: Fetcher;
}

export class BrowserlessError extends Error {}

export function browserlessFetcher(options: BrowserlessOptions): Fetcher {
  let base: URL;
  try { base = new URL(options.url); } catch { throw new BrowserlessError("Browserless URL is invalid"); }
  if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new BrowserlessError("Browserless URL must be HTTP(S) without credentials, query or fragment");
  }
  if (!Number.isSafeInteger(options.maxBytesPerPage) || options.maxBytesPerPage < 1 || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new BrowserlessError("Browserless limits must be positive integers");
  }
  const endpoint = new URL("function", base.toString().replace(/\/*$/, "/"));
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (target, init) => {
    let targetUrl: URL;
    try { targetUrl = new URL(target); } catch { throw new BrowserlessError("Invalid target URL"); }
    if (!/^https?:$/.test(targetUrl.protocol) || targetUrl.username || targetUrl.password) throw new BrowserlessError("Invalid target URL");
    const signals = [AbortSignal.timeout(options.timeoutMs)];
    if (options.signal) signals.push(options.signal);
    if (init.signal) signals.push(init.signal);
    const signal = AbortSignal.any(signals);
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(endpoint.toString(), { method: "POST", headers, redirect: "error", signal, body: JSON.stringify({ code, context: { url: targetUrl.toString(), timeoutMs: options.timeoutMs } }) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new BrowserlessError(`Browserless service returned HTTP ${response.status}`);
      }
      text = await readCapped(response, options.maxBytesPerPage * 6 + 4096);
    } catch (error) {
      if (signal.aborted) throw new BrowserlessError("Browserless request cancelled or timed out");
      if (error instanceof BrowserlessError) throw error;
      // Do not forward service or transport messages: they may contain credentials.
      throw new BrowserlessError("Browserless request failed");
    }
    let result: any;
    try { result = JSON.parse(text); } catch { throw new BrowserlessError("Browserless returned invalid JSON"); }
    if (result && typeof result === "object" && result.type === "application/json" && result.data) result = result.data;
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new BrowserlessError("Browserless returned an invalid result");
    if (typeof result.redirect === "string") {
      let redirect: URL;
      try { redirect = new URL(result.redirect); } catch { throw new BrowserlessError("Browserless returned an invalid redirect"); }
      if (!/^https?:$/.test(redirect.protocol) || redirect.username || redirect.password) throw new BrowserlessError("Browserless returned an invalid redirect");
      return new Response(null, { status: 302, headers: { location: redirect.toString() } });
    }
    if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599 || typeof result.url !== "string" || typeof result.html !== "string") throw new BrowserlessError("Browserless returned an invalid page");
    let finalUrl: URL;
    try { finalUrl = new URL(result.url); } catch { throw new BrowserlessError("Browserless returned an invalid page URL"); }
    if (!/^https?:$/.test(finalUrl.protocol) || finalUrl.username || finalUrl.password) throw new BrowserlessError("Browserless returned an invalid page URL");
    if (finalUrl.toString() !== targetUrl.toString()) return new Response(null, { status: 302, headers: { location: finalUrl.toString() } });
    const markdown = /(?:\.mdx?|\/llms?\.txt)$/i.test(targetUrl.pathname);
    const content = markdown ? NodeHtmlMarkdown.translate(result.html, {}, {
      pre: ({ node }) => ({ content: node.textContent, recurse: false, noEscape: true }),
    }) : result.html;
    const bytes = new TextEncoder().encode(content);
    if (bytes.length > options.maxBytesPerPage) throw new BrowserlessError("Browserless page exceeds size limit");
    return new Response([204, 205, 304].includes(result.status) ? null : bytes, { status: result.status, headers: { "content-type": markdown ? "text/markdown; charset=utf-8" : "text/html; charset=utf-8" } });
  };
}

async function readCapped(response: Response, cap: number): Promise<string> {
  if (Number(response.headers.get("content-length")) > cap) {
    await response.body?.cancel();
    throw new BrowserlessError("Browserless response exceeds size limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new BrowserlessError("Browserless returned an empty response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > cap) {
      await reader.cancel();
      throw new BrowserlessError("Browserless response exceeds size limit");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

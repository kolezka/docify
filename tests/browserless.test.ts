import { describe, expect, test } from "bun:test";
import { browserlessFetcher } from "../src/core/browserless.ts";
import { crawl, DEFAULT_LIMITS } from "../src/core/collect.ts";

const target = "https://docs.example.com/guide/";
const options = { url: "https://browser.example.com/", apiKey: "secret-token", timeoutMs: 1000, maxBytesPerPage: 1000 };
const result = (data: object) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });

describe("browserlessFetcher", () => {
  test("uses function API and preserves page status and rendered HTML", async () => {
    let request: RequestInit | undefined;
    const fetcher = browserlessFetcher({ ...options, fetchImpl: async (url, init) => {
      expect(url).toBe("https://browser.example.com/function");
      request = init;
      return result({ status: 404, url: target, html: "<p>missing</p>" });
    } });
    const response = await fetcher(target, {});
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("<p>missing</p>");
    expect(request?.redirect).toBe("error");
    expect((request?.headers as Record<string, string>).authorization).toBe("Bearer secret-token");
    const payload = JSON.parse(request?.body as string);
    expect(payload.context.url).toBe(target);
    expect(payload.code).toContain("setRequestInterception");
    expect(payload.code).toContain("request.abort()");
  });

  test("redirects are returned to crawl before rendering an out-of-scope URL", async () => {
    const calls: string[] = [];
    const fetcher = browserlessFetcher({ ...options, fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init!.body as string).context.url);
      return result({ redirect: "https://outside.example/secret" });
    } });
    await expect(crawl(target, DEFAULT_LIMITS, fetcher, { markdownExports: false })).rejects.toThrow("no documents fetched");
    expect(calls).toEqual([target]);
  });

  test("returns final URL as a redirect for crawl to check", async () => {
    const fetcher = browserlessFetcher({ ...options, fetchImpl: async () => result({ status: 200, url: "https://docs.example.com/guide/other", html: "ok" }) });
    const response = await fetcher(target, {});
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://docs.example.com/guide/other");
  });

  test("preserves Markdown links in browser-wrapped indexes", async () => {
    const index = "https://docs.example.com/guide/llms.txt";
    const fetcher = browserlessFetcher({ ...options, fetchImpl: async (_url, init) => {
      const url = JSON.parse(init!.body as string).context.url;
      return result({ status: 200, url, html: url === index ? "<html><body><pre># Index\n[Guide](child.md?x=1&amp;y=2)</pre></body></html>" : "<html><body><pre># Child\nDocumentation</pre></body></html>" });
    } });
    const docs = await crawl(index, DEFAULT_LIMITS, fetcher, { markdownExports: false });
    expect(docs).toHaveLength(2);
    expect(new TextDecoder().decode(docs[0]!.bytes)).toContain("[Guide](child.md?x=1&y=2)");
  });

  test("bounds service response and rendered page", async () => {
    const oversized = browserlessFetcher({ ...options, maxBytesPerPage: 3, fetchImpl: async () => result({ status: 200, url: target, html: "four" }) });
    await expect(oversized(target, {})).rejects.toThrow("page exceeds size limit");
    const huge = browserlessFetcher({ ...options, maxBytesPerPage: 3, fetchImpl: async () => new Response("x".repeat(5000)) });
    await expect(huge(target, {})).rejects.toThrow("response exceeds size limit");
  });

  test("honors per-call cancellation and hides transport and service secrets", async () => {
    const controller = new AbortController();
    const fetcher = browserlessFetcher({ ...options, fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("secret-token")));
    }) });
    const request = fetcher(target, { signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toThrow("cancelled or timed out");
    const failed = browserlessFetcher({ ...options, fetchImpl: async () => { throw new Error("secret-token"); } });
    await expect(failed(target, {})).rejects.toThrow("Browserless request failed");
    const service = browserlessFetcher({ ...options, fetchImpl: async () => new Response("secret-token", { status: 401 }) });
    await expect(service(target, {})).rejects.toThrow("HTTP 401");
  });

  test("rejects malformed results and unsafe service URLs", async () => {
    expect(() => browserlessFetcher({ ...options, url: "https://user:secret@browser.example/" })).toThrow();
    const fetcher = browserlessFetcher({ ...options, fetchImpl: async () => result({ status: 200, html: "missing URL" }) });
    await expect(fetcher(target, {})).rejects.toThrow("invalid page");
  });
});

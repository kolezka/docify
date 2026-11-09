import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { exportStore, importStore } from "../src/core/backup.ts";
import { newDocify, tempDir } from "./helpers.ts";

const homes: string[] = [];
const home = () => { const dir = tempDir(); homes.push(dir); return dir; };
const url = "http://docs.test/docs/";
const page = "<html><body><h1>Guide</h1><p>Useful documentation text.</p></body></html>";
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const pdf = Buffer.from("%PDF-1.7\nfirst");
let screenshot = png;
let failPdf = false;
const calls: string[] = [];
const service = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/api/embed") {
      const { input } = await req.json() as { input: string[] };
      return Response.json({ embeddings: input.map(() => [1, 2, 3, 4]) });
    }
    calls.push(path);
    if (path === "/crawl") {
      const { urls, crawler_config } = await req.json() as { urls: string[]; crawler_config: { params: { screenshot?: boolean; pdf?: boolean } } };
      const params = crawler_config.params;
      return Response.json({ success: true, results: [{ url: urls[0], html: page, success: true, status_code: 200, redirected_url: urls[0],
        ...(params.screenshot && { screenshot: screenshot.toString("base64") }),
        ...(params.pdf && { pdf: failPdf ? "invalid" : pdf.toString("base64") }),
      }] });
    }
    return new Response("not found", { status: 404 });
  },
});
const serviceUrl = `http://127.0.0.1:${service.port}`;
const config = { crawl4aiUrl: serviceUrl, embeddingProvider: "ollama" as const, embeddingUrl: serviceUrl, embeddingModel: "test", embeddingDims: 4, embeddingQueryPrefix: "" };
const artifactPath = (dir: string, id: string, generation: number, name: string) => join(dir, "snapshots", id, String(generation), "artifacts", name);
afterAll(() => { service.stop(true); homes.forEach((dir) => rmSync(dir, { recursive: true, force: true })); });

test("prepare persists artifacts, hashes their bytes, and preserves the active generation on capture failure", async () => {
  const dir = home();
  const d = newDocify(dir, config);
  try {
    const id = d.addSource({ library: "web", kind: "url", locator: url, crawlProvider: "crawl4ai", crawl: { maxDepth: 0 } }).id;
    d.updateSourceCrawler(id, undefined, { captureScreenshot: true, capturePdf: true });
    const first = await d.prepare(id, { graph: false });
    expect(first.status).toBe("activated");
    expect(first.stats.artifacts).toEqual(["screenshot", "pdf"]);
    expect(calls).toEqual(["/crawl"]);
    expect(readFileSync(artifactPath(dir, id, first.generationId, "screenshot.png"))).toEqual(png);
    expect(readFileSync(artifactPath(dir, id, first.generationId, "page.pdf"))).toEqual(pdf);
    const firstHash = d.getGeneration(first.generationId)!.snapshot_hash;
    expect((await d.prepare(id, { graph: false })).status).toBe("unchanged");
    screenshot = Buffer.concat([png, Buffer.from([2])]);
    const second = await d.prepare(id, { graph: false });
    expect(second.status).toBe("activated");
    expect(second.generationId).not.toBe(first.generationId);
    expect(d.getGeneration(second.generationId)!.snapshot_hash).not.toBe(firstHash);
    expect(readFileSync(artifactPath(dir, id, second.generationId, "screenshot.png"))).toEqual(screenshot);
    failPdf = true;
    await expect(d.prepare(id, { graph: false })).rejects.toThrow();
    expect(d.requireSource(id).active_generation).toBe(second.generationId);
    expect(d.getGeneration(second.generationId)!.status).toBe("active");
    expect(readFileSync(artifactPath(dir, id, second.generationId, "page.pdf"))).toEqual(pdf);

    const backup = await exportStore(d);
    const importedDir = home();
    const imported = newDocify(importedDir, config);
    try {
      await importStore(imported, backup.bytes);
      expect(imported.requireSource(id).active_generation).toBe(second.generationId);
      expect(readFileSync(artifactPath(importedDir, id, second.generationId, "screenshot.png"))).toEqual(screenshot);
      expect(readFileSync(artifactPath(importedDir, id, second.generationId, "page.pdf"))).toEqual(pdf);
      expect(existsSync(artifactPath(importedDir, id, first.generationId, "screenshot.png"))).toBe(true);
    } finally { imported.close(); }
  } finally { d.close(); screenshot = png; failPdf = false; calls.length = 0; }
});

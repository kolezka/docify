import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { search } from "../src/core/search.ts";
import { newDocify, tempDir } from "./helpers.ts";

function pdf(): Uint8Array {
  const stream = "BT /F1 12 Tf 20 700 Td (Kestrel migration patterns follow coastal winds) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let result = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(result));
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  result += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  result += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(result);
}

test("Crawl4AI linked PDF is searchable with normalized citations without a graph", async () => {
  const home = tempDir();
  const site = "http://docs.test/docs/";
  const pdfUrl = `${site}guide.pdf`;
  const rendered: string[] = [];
  const downloaded: string[] = [];
  const service = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/api/embed") {
        const { input } = await req.json() as { input: string[] };
        return Response.json({ embeddings: input.map(() => [1, 2, 3, 4]) });
      }
      const { urls } = await req.json() as { urls: string[] };
      rendered.push(urls[0]!);
      return Response.json({ success: true, results: [{ url: urls[0], html: '<html><body><a href="guide.pdf">Guide</a></body></html>', success: true, status_code: 200, redirected_url: urls[0] }] });
    },
  });
  const serviceUrl = `http://127.0.0.1:${service.port}`;
  const d = newDocify(home, { crawl4aiUrl: serviceUrl, embeddingProvider: "ollama", embeddingUrl: serviceUrl, embeddingModel: "test", embeddingDims: 4, embeddingQueryPrefix: "" });
  try {
    const id = d.addSource({ library: "web", kind: "url", locator: site, crawlProvider: "crawl4ai", crawl: { maxDepth: 1 } }).id;
    const prepared = await d.prepare(id, { graph: false, fetcher: async (url) => {
      downloaded.push(url);
      return new Response(new Uint8Array(pdf()).buffer, { headers: { "content-type": "application/pdf" } });
    } });
    expect(prepared.status).toBe("activated");
    expect(prepared.stats.collector).toBe("crawl4ai");
    expect(rendered).toEqual([site]);
    expect(downloaded).toEqual([pdfUrl]);
    const result = await search(d, { query: "kestrel migration coastal winds", library: "web", mode: "lexical" });
    expect(result.status).toBe("ok");
    expect(result.hits[0]?.excerpt).toContain("Kestrel migration patterns follow coastal winds");
    expect(result.hits[0]?.citation).toMatchObject({ document: "guide.pdf", url: pdfUrl, linesMatchRaw: false });
    expect(result.text).toMatch(/lines \d+-\d+ \(normalized\)/);
  } finally {
    d.close();
    service.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
});

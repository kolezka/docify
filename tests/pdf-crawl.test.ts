import { expect, test } from "bun:test";
import { crawl, DEFAULT_LIMITS, type Fetcher } from "../src/core/collect.ts";

function pdf(): Uint8Array {
  const stream = "BT /F1 12 Tf 20 700 Td (Meaningful PDF content) Tj ET";
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

const pdfResponse = () => new Response(new Uint8Array(pdf()).buffer, { headers: { "content-type": "application/pdf; charset=binary" } });

test("collects linked PDF directly with canonical URL and extracted text", async () => {
  const calls: string[] = [];
  const fetcher: Fetcher = async () => new Response('<a href="guide.pdf?x=1#top">Guide</a><a href="https://other.test/docs/no.pdf">outside</a>', { headers: { "content-type": "text/html" } });
  const pdfFetcher: Fetcher = async (url, init) => {
    calls.push(url);
    expect(init.redirect).toBe("manual");
    return pdfResponse();
  };
  const docs = await crawl("https://example.test/docs/", DEFAULT_LIMITS, fetcher, { pdfFetcher });
  expect(calls).toEqual(["https://example.test/docs/guide.pdf?x=1"]);
  expect(docs[1]?.path).toBe("guide.pdf");
  expect(docs[1]?.url).toBe("https://example.test/docs/guide.pdf");
  expect(docs[1]?.kind).toBe("markdown");
  expect(docs[1]?.extracted).toBe(true);
  expect(new TextDecoder().decode(docs[1]?.bytes)).toContain("Meaningful PDF content");
  expect((await crawl("https://example.test/docs/", DEFAULT_LIMITS, fetcher)).length).toBe(1);
});

test("extracts PDF links served without a PDF content type", async () => {
  for (const headers of [new Headers({ "content-type": "application/octet-stream" }), new Headers()]) {
    const docs = await crawl("https://example.test/docs/guide.pdf", DEFAULT_LIMITS, fetch, {
      pdfFetcher: async () => new Response(new Uint8Array(pdf()).buffer, { headers }),
    });
    expect(new TextDecoder().decode(docs[0]?.bytes)).toContain("Meaningful PDF content");
    expect(docs[0]?.extracted).toBe(true);
  }
});

test("follows only in-scope PDF redirects and preserves the final path", async () => {
  const calls: string[] = [];
  const pdfFetcher: Fetcher = async (url) => {
    calls.push(url);
    if (url.endsWith("start.pdf")) return new Response(null, { status: 302, headers: { location: "final.pdf" } });
    return pdfResponse();
  };
  const docs = await crawl("https://example.test/docs/start.pdf", DEFAULT_LIMITS, fetch, { pdfFetcher });
  expect(calls).toEqual(["https://example.test/docs/start.pdf", "https://example.test/docs/final.pdf"]);
  expect(docs[0]?.path).toBe("final.pdf");
  expect(docs[0]?.url).toBe("https://example.test/docs/final.pdf");
  const outside: Fetcher = async () => new Response(null, { status: 302, headers: { location: "https://evil.test/file.pdf" } });
  await expect(crawl("https://example.test/docs/start.pdf", DEFAULT_LIMITS, fetch, { pdfFetcher: outside })).rejects.toThrow("no documents fetched");
});

test("rejects invalid PDF and enforces input byte limits", async () => {
  const invalid: Fetcher = async () => new Response("not a PDF", { headers: { "content-type": "application/pdf" } });
  await expect(crawl("https://example.test/a.pdf", DEFAULT_LIMITS, fetch, { pdfFetcher: invalid })).rejects.toThrow("failed to extract PDF");
  await expect(crawl("https://example.test/a.pdf", { ...DEFAULT_LIMITS, maxBytesPerPage: 10 }, fetch, { pdfFetcher: async () => pdfResponse() })).rejects.toThrow("no documents fetched");
  await expect(crawl("https://example.test/a.pdf", { ...DEFAULT_LIMITS, maxTotalBytes: 10 }, fetch, { pdfFetcher: async () => pdfResponse() })).rejects.toThrow("crawl exceeded the 10 B total size limit");
});

import { expect, test } from "bun:test";
import { extractPdfText, PDF_MAX_BYTES, PDF_MAX_CHARS, PDF_MAX_PAGES } from "../src/core/pdf.ts";

function pdf(streams: string[]): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${streams.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${streams.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...streams.flatMap((stream, i) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ]),
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

test("extracts text across pages without consuming input", async () => {
  const data = pdf(["BT /F1 12 Tf 20 700 Td (Hello PDF) Tj ET", "BT /F1 12 Tf 20 700 Td (Second page) Tj ET"]);
  expect(await extractPdfText(data)).toBe("Hello PDF\n\nSecond page");
  expect(await extractPdfText(data)).toBe("Hello PDF\n\nSecond page");
});

test("rejects empty, scanned, and malformed files", async () => {
  await expect(extractPdfText(new Uint8Array())).rejects.toThrow("PDF is empty");
  await expect(extractPdfText(pdf([""]))).rejects.toThrow("no extractable text");
  await expect(extractPdfText(new TextEncoder().encode("not a PDF"))).rejects.toThrow();
});

test("enforces input, page, and extracted text limits", async () => {
  await expect(extractPdfText(new Uint8Array(PDF_MAX_BYTES + 1))).rejects.toThrow("bytes");
  await expect(extractPdfText(pdf(Array(PDF_MAX_PAGES + 1).fill("")))).rejects.toThrow("pages");
  const text = "x".repeat(10_000);
  const stream = `BT /F1 0.01 Tf 20 700 Td (${text}) Tj ET`;
  await expect(extractPdfText(pdf(Array(Math.ceil(PDF_MAX_CHARS / 10_000) + 1).fill(stream)))).rejects.toThrow("characters");
});

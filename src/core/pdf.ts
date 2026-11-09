import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export const PDF_MAX_BYTES = 20 * 1024 * 1024;
export const PDF_MAX_PAGES = 500;
export const PDF_MAX_CHARS = 2_000_000;

/** Extract text only. Image-only PDFs require OCR, which is not provided here. */
export async function extractPdfText(data: Uint8Array): Promise<string> {
  if (data.byteLength === 0) throw new Error("PDF is empty");
  if (data.byteLength > PDF_MAX_BYTES) throw new Error(`PDF exceeds ${PDF_MAX_BYTES} bytes`);

  const task = getDocument({ data: new Uint8Array(data), verbosity: 0, stopAtErrors: true });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > PDF_MAX_PAGES) throw new Error(`PDF exceeds ${PDF_MAX_PAGES} pages`);
    const pages: string[] = [];
    let length = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      try {
        const content = await page.getTextContent();
        let text = "";
        for (const item of content.items) {
          if (!("str" in item)) continue;
          const part = item.str + (item.hasEOL ? "\n" : " ");
          length += part.length;
          if (length > PDF_MAX_CHARS) throw new Error(`PDF text exceeds ${PDF_MAX_CHARS} characters`);
          text += part;
        }
        pages.push(text.trim());
      } finally {
        page.cleanup();
      }
    }
    const text = pages.filter(Boolean).join("\n\n");
    if (text.length > PDF_MAX_CHARS) throw new Error(`PDF text exceeds ${PDF_MAX_CHARS} characters`);
    if (!text.trim()) throw new Error("PDF contains no extractable text; it may be a scan requiring OCR");
    return text;
  } finally {
    await task.destroy();
  }
}

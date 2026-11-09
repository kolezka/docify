import { Crawl4aiError } from "./crawl4ai.ts";

export type Crawl4aiArtifactKind = "screenshot" | "pdf";

export function decodeCrawl4aiArtifact(encoded: unknown, kind: Crawl4aiArtifactKind, maxBytes: number): Uint8Array {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 100_000_000) {
    throw new Crawl4aiError("Invalid artifact byte limit");
  }
  if (typeof encoded !== "string" || !encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Crawl4aiError("Crawl4AI artifact is not valid base64");
  }
  const length = encoded.length / 4 * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
  if (length > maxBytes) throw new Crawl4aiError(`Crawl4AI artifact exceeds ${maxBytes} bytes`);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new Crawl4aiError("Crawl4AI artifact is not valid base64");
  const magic = kind === "pdf" ? Buffer.from("%PDF-") : Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < magic.length || !bytes.subarray(0, magic.length).equals(magic)) throw new Crawl4aiError(`Crawl4AI artifact is not a ${kind === "pdf" ? "PDF" : "PNG"}`);
  return bytes;
}

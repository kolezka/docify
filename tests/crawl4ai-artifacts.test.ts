import { expect, test } from "bun:test";
import { decodeCrawl4aiArtifact } from "../src/core/crawl4ai-artifacts.ts";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const pdf = Buffer.from("%PDF-1.7\n");

test.each([["screenshot", png], ["pdf", pdf]] as const)("decodes a valid %s", (kind, bytes) => {
  expect(Buffer.from(decodeCrawl4aiArtifact(bytes.toString("base64"), kind, 100))).toEqual(bytes);
});

test("rejects missing, malformed, noncanonical and wrong-signature artifacts", () => {
  for (const encoded of [undefined, null, 5, "", "abc!", "iVBORw0KGgoB=", "YR==", pdf.toString("base64")]) {
    expect(() => decodeCrawl4aiArtifact(encoded, "screenshot", 100)).toThrow();
  }
});

test("enforces decoded size and validates the limit", () => {
  expect(() => decodeCrawl4aiArtifact(pdf.toString("base64"), "pdf", 5)).toThrow("exceeds");
  for (const limit of [0, -1, Infinity, 100_000_001]) {
    expect(() => decodeCrawl4aiArtifact(pdf.toString("base64"), "pdf", limit)).toThrow("limit");
  }
});

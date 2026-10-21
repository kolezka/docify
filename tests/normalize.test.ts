import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalize } from "../src/core/normalize.ts";
import { chunk } from "../src/core/chunk.ts";
import { FIXTURES } from "./helpers.ts";

const fences = (s: string) => (s.match(/^\s*(> )?(```|~~~)/gm) ?? []).length;

test("MDX components and Markdoc callouts become quoted notes, line count preserved", () => {
  for (const [file, kind] of [
    ["bun-1.4.3/sqlite.mdx", "mdx"],
    ["bun-1.2.0/sqlite.md", "markdown"],
  ] as const) {
    const raw = readFileSync(join(FIXTURES, file), "utf8");
    const n = normalize(raw, kind);
    expect(n.linesMatchRaw).toBe(true);
    expect(n.markdown.split("\n").length).toBe(raw.split("\n").length);
    expect(n.markdown).toContain("> **Note:**");
    expect(n.markdown).not.toMatch(/^<Note>|^\{% callout/m);
    // Code inside fences is untouched, line for line.
    const rawLines = raw.split("\n");
    n.markdown.split("\n").forEach((line, i) => {
      if (/^```/.test(line)) expect(rawLines[i]).toBe(line);
    });
  }
});

test("HTML keeps fenced code, quotes Sphinx warnings, strips permalinks and records anchors", () => {
  const n = normalize(readFileSync(join(FIXTURES, "python-3.13/hashlib.html"), "utf8"), "html");
  expect(n.title).toContain("hashlib");
  expect(fences(n.markdown)).toBeGreaterThanOrEqual(20);
  expect(n.markdown).toMatch(/```python\n>>> import hashlib/);
  expect(n.markdown).toContain("> **Warning:**");
  expect(n.markdown).not.toContain("[¶]");
  expect(n.markdown).toContain("pbkdf2_hmac");
  expect(n.markdown).not.toContain("pbkdf2\\_hmac");
  expect([...n.anchors.values()]).toContain("hash-algorithms");
});

test("chunks never split a code fence and line ranges map to the exact normalized text", () => {
  for (const [file, kind] of [
    ["bun-1.4.3/sqlite.mdx", "mdx"],
    ["bun-1.4.3/hashing.mdx", "mdx"],
    ["python-3.13/hashlib.html", "html"],
  ] as const) {
    const n = normalize(readFileSync(join(FIXTURES, file), "utf8"), kind);
    const lines = n.markdown.split("\n");
    const chunks = chunk(n.markdown, n.anchors);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(fences(c.text) % 2).toBe(0);
      expect(lines.slice(c.startLine - 1, c.endLine).join("\n")).toBe(c.text);
    }
    expect(chunks.some((c) => c.hasCode)).toBe(true);
    expect(chunks.some((c) => c.hasWarning)).toBe(true);
  }
});

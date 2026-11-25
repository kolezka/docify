import { test, expect, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Tiktoken } from "js-tiktoken/lite";
import o200k from "js-tiktoken/ranks/o200k_base";
import { search } from "../src/core/search.ts";
import { countTokens } from "../src/core/tokens.ts";
import { fakeGraph, newDocify, tempDir, writeDocs } from "./helpers.ts";

const SPECIALS = Object.keys(o200k.special_tokens);
const home = tempDir();
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("the tokenizer's special tokens are counted as the plain text a document wrote", () => {
  const exact = new Tiktoken(o200k);
  expect(SPECIALS).toContain("<|endoftext|>");
  for (const special of SPECIALS) {
    const text = `Stop sequences such as ${special} end a completion.`;
    expect(countTokens(text)).toBe(exact.encode(text, [], []).length);
    expect(countTokens(text)).toBeGreaterThanOrEqual(exact.encode(text, "all").length);
    expect(countTokens("x".repeat(70) + special + "y".repeat(70))).toBeGreaterThan(0);
  }
});

test("a document that mentions a special token is prepared and found", async () => {
  const d = newDocify(home);
  try {
    const dir = writeDocs(join(tempDir("docify-src-"), "tokens"), {
      "a.md": "# Tokenizers\n\n## Stop sequences\n\nThe model emits <|endoftext|> when a completion ends, and <|endofprompt|> separates the prompt.\n",
    });
    d.addSource({ library: "tokens", version: "1", kind: "local", locator: dir });
    const prepared = await d.prepare("tokens@1", { graphRunner: fakeGraph });
    expect(prepared.status).toBe("activated");
    const r = await search(d, { query: "stop sequences <|endoftext|> completion ends", library: "tokens" });
    expect(r.status).toBe("ok");
    expect(r.text).toContain("emits <|endoftext|> when");
    expect(r.tokens).toBe(countTokens(r.text));
  } finally {
    d.close();
  }
});

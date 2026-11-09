import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "svelte/compiler";

test("Crawl4AI controls are gated by the effective crawler", () => {
  const source = readFileSync(new URL("../src/web/views/SourceCard.svelte", import.meta.url), "utf8");
  const ast = parse(source, { modern: true });
  const blocks: any[] = [];
  function visit(node: any) {
    if (!node || typeof node !== "object") return;
    if (node.type === "IfBlock") blocks.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  visit(ast.fragment);
  const gate = blocks.find((block) => source.slice(block.test.start, block.test.end) === 's.effectiveCrawlProvider === "crawl4ai"');
  expect(gate).toBeDefined();
  const gated = source.slice(gate.start, gate.end);
  expect(gated).toContain("Crawl4AI settings");
  expect(gated).toContain("onsubmit={saveCrawl4ai}");
});

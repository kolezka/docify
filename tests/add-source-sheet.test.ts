import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The add request can be slow; what happens after it must be what the user chose when submitting,
// not what the switches say once the request returns.
test("the add sheet fixes its prepare choices before the request and locks them while it runs", () => {
  const source = readFileSync(new URL("../src/web/views/AddSourceSheet.svelte", import.meta.url), "utf8");
  const submit = source.slice(source.indexOf("async function submit("));
  const firstAwait = submit.indexOf("await ");
  expect(firstAwait).toBeGreaterThan(0);
  const beforeAwait = submit.slice(0, firstAwait);
  expect(beforeAwait).toContain("= buildGraph;");
  expect(beforeAwait).toContain("= prepareAfter;");
  expect(submit.slice(firstAwait)).not.toMatch(/=\s*(buildGraph|prepareAfter);/);

  expect(source).toMatch(/<Switch bind:checked=\{prepareAfter\}[^>]*disabled=\{submitting\}/);
  expect(source).toMatch(/<Switch bind:checked=\{buildGraph\}[^>]*disabled=\{submitting \|\|/);
});

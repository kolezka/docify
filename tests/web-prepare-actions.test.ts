import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "svelte/compiler";

const source = readFileSync(new URL("../src/web/views/SourcePage.svelte", import.meta.url), "utf8");
const ast = parse(source);
const prepare = ast.instance!.content.body.find((node: any) => node.type === "FunctionDeclaration" && node.id.name === "prepare")!;
const handler = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(prepare.start, prepare.end));

function invoke(graph: boolean, graphOnly = false, force = false) {
  const requests: unknown[] = [];
  const run = (action: () => unknown) => action();
  const api = (path: string, options: unknown) => requests.push({ path, options });
  const call = new Function("api", "run", "graph", "graphOnly", "force", `let menuOpen = true; const path = '/api/sources/docs'; ${handler}; prepare(graph, graphOnly, force); return menuOpen;`);
  expect(call(api, run, graph, graphOnly, force)).toBe(false);
  return requests;
}

test("preparation actions preserve ordinary requests and force only the explicit cache bypass", () => {
  expect(invoke(true)).toEqual([{ path: "/api/sources/docs/prepare", options: { method: "POST", body: { graph: true } } }]);
  expect(invoke(false)).toEqual([{ path: "/api/sources/docs/prepare", options: { method: "POST", body: { graph: false } } }]);
  expect(invoke(true, true)).toEqual([{ path: "/api/sources/docs/prepare", options: { method: "POST", body: { graphOnly: true } } }]);
  expect(invoke(true, true, true)).toEqual([{ path: "/api/sources/docs/prepare", options: { method: "POST", body: { graphOnly: true, force: true } } }]);
});

test("the cache bypass is an explicit graph retry menu action", () => {
  expect(source).toContain('onclick={() => prepare(true, true, true)}>Retry Graph Only without Cache</button');
});

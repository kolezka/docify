import { expect, test } from "bun:test";
import { createGraphSearch, fold, isEmptyQuery, matchRanges, parseQuery, type SearchNode } from "../src/web/lib/graph-search.ts";

const node = (over: Partial<SearchNode> & { label: string }): SearchNode => ({
  id: over.label.toLowerCase().replace(/\W+/g, "_"),
  type: "concept",
  page: null,
  group: null,
  grounded: true,
  degree: 1,
  text: "",
  ...over,
});

const nodes: SearchNode[] = [
  node({ label: "Search", page: "guide/search.md", degree: 9 }),
  node({ label: "Search modes", page: "guide/search.md", group: "Retrieval", degree: 4 }),
  node({ label: "Vector search", type: "code", page: "api/vector.md", group: "Retrieval", degree: 6 }),
  node({ label: "Research notes", type: "document", page: "notes.md", grounded: false, degree: 2 }),
  node({ label: "Embeddings", page: "api/embed.md", text: "Models > Setup\nEmbeddings feed the vector search index.", degree: 3 }),
  node({ label: "Zażółć gęślą jaźń", type: "document", page: "pl/łódź.md", degree: 0 }),
];
const labels = (query: string, limit?: number) => createGraphSearch(nodes).search(query, limit).map((h) => nodes[h.index]!.label);

test("an empty query, or one with only a half-typed filter, matches nothing rather than everything", () => {
  for (const q of ["", "   ", "type:", "is:", "links:>", 'group:""']) {
    expect(isEmptyQuery(parseQuery(q))).toBe(true);
    expect(labels(q)).toEqual([]);
  }
});

test("label matches rank exact, then prefix, then word start, then inside a word, then other fields", () => {
  expect(labels("search")).toEqual(["Search", "Search modes", "Vector search", "Research notes", "Embeddings"]);
  const hits = createGraphSearch(nodes).search("search");
  expect(hits.map((h) => h.field)).toEqual(["label", "label", "label", "label", "text"]);
});

test("every term must match somewhere, and the hit names its weakest field", () => {
  expect(labels("vector search")).toEqual(["Vector search", "Embeddings"]);
  expect(labels("search nothing-like-this")).toEqual([]);
  const [hit] = createGraphSearch(nodes).search("modes guide");
  expect(nodes[hit!.index]!.label).toBe("Search modes");
  expect(hit!.field).toBe("page");
});

test("filters narrow the set: same key is either-or, different keys must all hold", () => {
  expect(labels("type:code")).toEqual(["Vector search"]);
  expect(labels("type:code type:document").sort()).toEqual(["Research notes", "Vector search", "Zażółć gęślą jaźń"]);
  expect(labels("group:retrieval")).toEqual(["Vector search", "Search modes"]);
  expect(labels("group:retrieval type:code")).toEqual(["Vector search"]);
  expect(labels("page:api")).toEqual(["Vector search", "Embeddings"]);
  expect(labels("is:ungrounded")).toEqual(["Research notes"]);
  expect(labels("is:grounded search")).not.toContain("Research notes");
  expect(labels("links:>4")).toEqual(["Search", "Vector search"]);
  expect(labels("links:4")).toEqual(["Search", "Vector search", "Search modes"]);
  // A filter prefix works while it is being typed.
  expect(labels("type:doc")).toEqual(labels("type:document"));
  expect(labels("is:un")).toEqual(["Research notes"]);
});

test("quotes keep spaces together, in terms and in filter values", () => {
  expect(parseQuery('"vector search" group:"Setup steps"')).toMatchObject({ terms: ["vector search"], groups: ["setup steps"] });
  expect(labels('"vector search"')).toEqual(["Vector search", "Embeddings"]);
  expect(labels('"search vector"')).toEqual([]);
});

test("a colon that is not a filter stays part of the term", () => {
  expect(parseQuery("std::vector https://x.dev").terms).toEqual(["std::vector", "https://x.dev"]);
  expect(parseQuery("is:maybe").terms).toEqual(["is:maybe"]);
});

test("matching ignores case and accents, including letters NFD leaves alone", () => {
  expect(fold("Zażółć GĘŚLĄ")).toBe("zazolc gesla");
  expect(labels("zazolc")).toEqual(["Zażółć gęślą jaźń"]);
  expect(labels("JAŹŃ")).toEqual(["Zażółć gęślą jaźń"]);
  expect(labels("page:lodz")).toEqual(["Zażółć gęślą jaźń"]);
});

test("the limit keeps the best hits", () => {
  expect(labels("search", 2)).toEqual(["Search", "Search modes"]);
});

test("match ranges index the original text and merge overlaps", () => {
  expect(matchRanges("Vector search", ["search"])).toEqual([[7, 13]]);
  expect(matchRanges("Search research", ["search", "sea"])).toEqual([[0, 6], [9, 15]]);
  const text = "Zażółć gęślą";
  const [range] = matchRanges(text, ["gesla"]);
  expect(text.slice(range![0], range![1])).toBe("gęślą");
  expect(matchRanges("anything", [])).toEqual([]);
});

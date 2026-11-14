import { expect, test } from "bun:test";
import { graphCoverage } from "../src/web/lib/format.ts";
import { isPatternField, patternError, patternLines } from "../src/web/lib/ui.ts";

test("the graph row tells ignored pages apart from pages Graphify missed", () => {
  expect(graphCoverage("ok", 0, 0)).toBe("Every page has graph nodes");
  expect(graphCoverage("ok", 0, 1)).toBe("1 page left out by ignore patterns. Every other page has graph nodes");
  expect(graphCoverage("ok", 0, 12)).toBe("12 pages left out by ignore patterns. Every other page has graph nodes");
  expect(graphCoverage("partial", 1, 0)).toBe("1 page has no graph nodes");
  expect(graphCoverage("partial", 3, 2)).toBe("3 pages have no graph nodes. 2 pages left out by ignore patterns");
  expect(graphCoverage("skipped", 0, 4)).toBe("Every page matches the ignore patterns, so no graph was built");
  // Prepared without a graph, failed or not built: the chip says it, the row adds nothing.
  for (const status of ["skipped", "failed", null]) expect(graphCoverage(status, 0, 0)).toBeUndefined();
});

test("a pattern error is shown at its field without the option name", () => {
  expect(isPatternField("ignore")).toBe(true);
  expect(isPatternField("graphIgnore")).toBe(true);
  for (const field of ["locator", "crawl", "", null]) expect(isPatternField(field)).toBe(false);
  expect(patternError('graphIgnore: "(" is not a valid regular expression (missing ))')).toBe('"(" is not a valid regular expression (missing ))');
  expect(patternError("ignore: at most 100 patterns are accepted")).toBe("at most 100 patterns are accepted");
  // Only a leading option name is removed.
  expect(patternError('ignore: "x ignore: y" is not a valid regular expression (z)')).toBe('"x ignore: y" is not a valid regular expression (z)');
  expect(patternError("source lib@1 is being prepared")).toBe("source lib@1 is being prepared");
});

test("one pattern per line, blank lines and outer spaces dropped", () => {
  expect(patternLines("  ^changelog/  \n\n^blog/\\d{4}/\r\n")).toEqual(["^changelog/", "^blog/\\d{4}/"]);
  expect(patternLines(" \n ")).toEqual([]);
});

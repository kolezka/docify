import { expect, test } from "bun:test";
import { parseCollapsed, sidebarSections } from "../src/web/lib/sidebar-groups.ts";

const src = (id: string, groups: string[] = []) => ({ id, groups });
const ids = (sections: ReturnType<typeof sidebarSections<{ id: string; groups: string[] }>>) =>
  sections.map((s) => [s.group, s.sources.map((x) => x.id)]);

test("sources are listed under each of their groups, sorted, with ungrouped ones last", () => {
  const list = [src("otter@1"), src("walrus@1", ["arctic"]), src("narwhal@1", ["whales", "arctic"]), src("seal@1")];
  expect(ids(sidebarSections(list))).toEqual([
    ["arctic", ["walrus@1", "narwhal@1"]],
    ["whales", ["narwhal@1"]],
    [null, ["otter@1", "seal@1"]],
  ]);
});

test("without any groups there is one ungrouped section, and no sources gives none", () => {
  expect(ids(sidebarSections([src("a@1"), src("b@1")]))).toEqual([[null, ["a@1", "b@1"]]]);
  expect(sidebarSections([])).toEqual([]);
});

test("stored collapsed groups are read back; damaged values read as none collapsed", () => {
  expect([...parseCollapsed('["arctic",""]')]).toEqual(["arctic", ""]);
  expect([...parseCollapsed('["arctic",5]')]).toEqual(["arctic"]);
  expect(parseCollapsed(null).size).toBe(0);
  expect(parseCollapsed("{not json").size).toBe(0);
  expect(parseCollapsed('{"arctic":true}').size).toBe(0);
});

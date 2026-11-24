import { expect, spyOn, test } from "bun:test";
import { refreshDueSources } from "../src/core/refresh.ts";
import { newDocify, tempDir } from "./helpers.ts";

test("serve ticks use persisted per-source schedules, skip missed times and pick up edits", () => {
  const home = tempDir();
  const writer = newDocify(home);
  const reader = newDocify(home);
  const prepare = spyOn(reader, "prepare").mockImplementation(async sourceId => ({ sourceId, generationId: 1, status: "unchanged", stats: {} }));
  try {
    for (const id of ["one", "two", "manual"]) writer.addSource({ id, library: id, kind: "url", locator: "https://example.com/docs", title: id });
    writer.setRefreshCron("one", "15 3 * * *");
    writer.setRefreshCron("two", "30 3 * * *");
    expect(() => writer.setRefreshCron("one", "75 * * * *")).toThrow("five-field cron");
    const tick = (minute: number) => refreshDueSources(reader, new Date(2026, 0, 9, 3, minute, 2).getTime());
    tick(15);
    tick(31);
    expect(prepare.mock.calls.map(([id]) => id)).toEqual(["one"]);
    writer.setRefreshCron("one", null);
    writer.setRefreshCron("two", "15 3 * * *");
    tick(15);
    expect(prepare.mock.calls.map(([id]) => id)).toEqual(["one", "two"]);
    expect(JSON.parse(reader.requireSource("one").options).title).toBe("one");
  } finally {
    reader.close();
    writer.close();
  }
});

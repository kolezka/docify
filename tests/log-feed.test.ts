import { expect, test } from "bun:test";
import { LogFeed } from "../src/web/lib/log-feed.ts";

const line = (seq: number) => ({ seq, ts: "2026-11-09T00:00:00.000Z", source: "fixture", stream: "stdout", level: "info", text: `line ${seq}` });

test("feed paginates, bounds memory, keeps history on error and retries from the last cursor", async () => {
  const requests: number[] = [];
  let fail = false;
  const feed = new LogFeed(async (after) => {
    requests.push(after);
    if (fail) throw new Error("fixture disconnected");
    return { lines: Array.from({ length: after < 1000 ? 1000 : after === 1000 ? 1 : 0 }, (_, i) => line(after + i + 1)), cursor: after < 1000 ? 1000 : after === 1000 ? 1001 : after, capped: after === 0 };
  }, () => {}, 1000);
  await feed.refresh();
  expect(requests).toEqual([0, 1000]);
  expect(feed.state.lines).toHaveLength(1000);
  expect(feed.state.lines[0]?.seq).toBe(2);
  expect(feed.state.capped).toBe(true);
  expect(feed.state.live).toBe(true);
  fail = true;
  await feed.refresh();
  expect(feed.state.error).toContain("fixture disconnected");
  expect(feed.state.live).toBe(false);
  expect(feed.state.lines).toHaveLength(1000);
  fail = false;
  await feed.refresh();
  expect(requests.at(-1)).toBe(1001);
  expect(feed.state.error).toBe("");
});

test("feed rejects malformed responses instead of publishing empty successful history", async () => {
  for (const malformed of [null, {}, { lines: [], cursor: 0 }, { lines: [line(1)], cursor: 0, capped: false }, { lines: [{ ...line(1), stream: "oops" }], cursor: 1, capped: false }, { lines: [line(2), line(1)], cursor: 1, capped: false }]) {
    const feed = new LogFeed(async () => malformed, () => {});
    await feed.refresh();
    expect(feed.state.error).toContain("Invalid log response");
    expect(feed.state.live).toBe(false);
  }
  const positive = new LogFeed(async () => ({ lines: [line(1)], cursor: 1, capped: false }), () => {});
  await positive.refresh();
  expect(positive.state.lines[0]?.text).toBe("line 1");
  expect(positive.state.error).toBe("");
});

test("overlapping refresh and disposal cannot publish a stale pending response", async () => {
  let release!: (value: unknown) => void;
  let calls = 0;
  const states: unknown[] = [];
  const feed = new LogFeed((_after, signal) => {
    calls++;
    expect(signal.aborted).toBe(false);
    return new Promise((resolve) => { release = resolve; });
  }, (state) => states.push(state));
  const first = feed.refresh();
  const second = feed.refresh();
  expect(calls).toBe(1);
  feed.dispose();
  const count = states.length;
  release({ lines: [line(1)], cursor: 1, capped: false });
  await Promise.all([first, second]);
  expect(states).toHaveLength(count);
  expect(feed.state.lines).toEqual([]);
});

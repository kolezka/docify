import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOffsets,
  computeVariableWindow,
  computeWindow,
  findRowAt,
  rowSpan,
} from "../src/web/lib/log-viewer/virtual.ts";

// 20px rows in a 400px viewport: 20 rows fit, so a window covers 21 rows plus overscan.
const ROW = 20;
const VIEWPORT = 400;

test("first window starts at row zero and does not overscan below it", () => {
  const window = computeWindow({
    scrollTop: 0,
    viewportHeight: VIEWPORT,
    rowHeight: ROW,
    count: 50_000,
    overscan: 10,
  });
  assert.equal(window.start, 0);
  assert.equal(window.end, 31);
  assert.equal(window.offsetTop, 0);
  assert.equal(window.totalHeight, 50_000 * ROW);
});

test("middle window is centred on the scrolled row", () => {
  const window = computeWindow({
    scrollTop: 10_000,
    viewportHeight: VIEWPORT,
    rowHeight: ROW,
    count: 50_000,
    overscan: 10,
  });
  // Row 500 is the first visible one; 10 rows of overscan sit above it.
  assert.equal(window.start, 490);
  assert.equal(window.end, 531);
  assert.equal(window.offsetTop, 490 * ROW);
  assert.equal(window.end - window.start, 41);
});

test("middle window keeps its offset aligned to the rendered slice", () => {
  const window = computeWindow({
    scrollTop: 10_010,
    viewportHeight: VIEWPORT,
    rowHeight: ROW,
    count: 50_000,
    overscan: 0,
  });
  // A half scrolled row still counts as the first visible row.
  assert.equal(window.start, 500);
  assert.equal(window.offsetTop, 10_000);
  assert.equal(window.end, 521);
});

test("end window stops at the last row", () => {
  const count = 50_000;
  const maxScroll = count * ROW - VIEWPORT;
  const window = computeWindow({
    scrollTop: maxScroll,
    viewportHeight: VIEWPORT,
    rowHeight: ROW,
    count,
    overscan: 10,
  });
  assert.equal(window.end, count);
  assert.equal(window.start, count - 20 - 10);
  assert.equal(window.offsetTop, window.start * ROW);
});

test("a scrollTop past the end clamps to the last window", () => {
  const count = 1000;
  const window = computeWindow({
    scrollTop: 9_999_999,
    viewportHeight: VIEWPORT,
    rowHeight: ROW,
    count,
    overscan: 4,
  });
  assert.equal(window.end, count);
  assert.equal(window.start, count - 20 - 4);
  assert.ok(window.offsetTop <= window.totalHeight);
});

test("overscan is clamped at both edges and never leaves the list", () => {
  const top = computeWindow({
    scrollTop: 40,
    viewportHeight: VIEWPORT,
    rowHeight: ROW,
    count: 100,
    overscan: 500,
  });
  assert.equal(top.start, 0);
  assert.equal(top.end, 100);

  const short = computeWindow({
    scrollTop: 0,
    viewportHeight: VIEWPORT,
    rowHeight: ROW,
    count: 3,
    overscan: 12,
  });
  assert.equal(short.start, 0);
  assert.equal(short.end, 3);
  assert.equal(short.totalHeight, 60);
});

test("negative and non finite inputs degrade to the first window", () => {
  const negative = computeWindow({
    scrollTop: -500,
    viewportHeight: VIEWPORT,
    rowHeight: ROW,
    count: 100,
    overscan: 2,
  });
  assert.equal(negative.start, 0);
  assert.equal(negative.offsetTop, 0);

  const broken = computeWindow({
    scrollTop: Number.NaN,
    viewportHeight: VIEWPORT,
    rowHeight: 0,
    count: 10,
    overscan: 1,
  });
  assert.equal(broken.start, 0);
  assert.equal(broken.totalHeight, 10);
});

test("an empty list renders nothing", () => {
  const window = computeWindow({
    scrollTop: 0,
    viewportHeight: VIEWPORT,
    rowHeight: ROW,
    count: 0,
  });
  assert.deepEqual(window, { start: 0, end: 0, offsetTop: 0, totalHeight: 0 });
});

test("rowSpan counts the wrapped rows of a line", () => {
  assert.equal(rowSpan(0, 80), 1);
  assert.equal(rowSpan(80, 80), 1);
  assert.equal(rowSpan(81, 80), 2);
  assert.equal(rowSpan(240, 80), 3);
  assert.equal(rowSpan(240, 0), 1);
});

test("buildOffsets turns line lengths into a prefix sum", () => {
  const offsets = buildOffsets([10, 100, 30], 40, ROW);
  assert.deepEqual([...offsets], [0, 20, 80, 100]);
  assert.equal(findRowAt(offsets, 0), 0);
  assert.equal(findRowAt(offsets, 25), 1);
  assert.equal(findRowAt(offsets, 79), 1);
  assert.equal(findRowAt(offsets, 80), 2);
  assert.equal(findRowAt(offsets, 9999), 2);
});

test("the wrapped window covers the viewport and clamps its overscan", () => {
  // 1000 lines, every third one twice as tall.
  const lengths = Array.from({ length: 1000 }, (_, index) => (index % 3 === 0 ? 90 : 10));
  const offsets = buildOffsets(lengths, 80, ROW);

  const first = computeVariableWindow({
    scrollTop: 0,
    viewportHeight: VIEWPORT,
    offsets,
    overscan: 5,
  });
  assert.equal(first.start, 0);
  assert.equal(first.offsetTop, 0);
  assert.ok(offsets[first.end]! >= VIEWPORT, "the window reaches past the viewport");

  const last = computeVariableWindow({
    scrollTop: offsets[1000]!,
    viewportHeight: VIEWPORT,
    offsets,
    overscan: 5,
  });
  assert.equal(last.end, 1000);
  assert.ok(last.offsetTop <= offsets[1000]! - VIEWPORT);
  assert.equal(last.totalHeight, offsets[1000]);
});

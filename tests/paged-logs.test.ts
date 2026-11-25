import { expect, test } from 'bun:test';
import { PagedLogs } from '../src/web/lib/paged-logs.ts';
import type { LogEntry } from '../src/core/logs.ts';

const line = (seq: number): LogEntry => ({ seq, ts: '2026-01-01T00:00:00Z', source: 'test', stream: 'system', level: 'info', text: String(seq) });
const page = (lines: LogEntry[], hasOlder: boolean) => ({ lines, cursor: lines.at(-1)?.seq ?? 0, capped: false, hasOlder });

test('full initial page stops; concurrent scrolls share a request and live delivery keeps its cursor', async () => {
  const requests: (number | null)[] = [];
  const next = Promise.withResolvers<unknown>();
  const feed = new PagedLogs(async before => {
    requests.push(before);
    return before === null ? page(Array.from({ length: 1000 }, (_, i) => line(i + 101)), true) : next.promise;
  }, () => {});
  await feed.load();
  expect(requests).toEqual([null]);
  const older = feed.load();
  expect(feed.load()).toBe(older);
  feed.append([line(1101)]);
  next.resolve(page(Array.from({ length: 100 }, (_, i) => line(i + 1)), false));
  await older;
  await feed.load();
  expect(requests).toEqual([null, 101]);
  expect(feed.after).toBe(1101);
  expect(feed.state.lines.map(l => l.seq)).toEqual(Array.from({ length: 1101 }, (_, i) => i + 1));
  feed.dispose();
});

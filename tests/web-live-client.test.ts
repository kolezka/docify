import { expect, test } from "bun:test";
import { LiveClient, type SourceDelta } from "../src/web/lib/live-client.ts";
import { SourceFeed } from "../src/web/lib/source-feed.ts";
import type { SourceInfo } from "../src/web/lib/api.ts";
import { LogFeed } from "../src/web/lib/log-feed.ts";

class Socket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: unknown[] = [];
  closed = false;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; }
  receive(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
}
const row = (id: string, title = id) => ({ id, title } as SourceInfo);
const entry = (seq: number) => ({ seq, ts: '2026-11-09T00:00:00Z', source: 'fixture', level: 'info' as const, stream: 'stdout' as const, text: `line ${seq}` });
const reset: SourceDelta = { type: 'sources', upserts: [row('z')], removed: [], reset: true };

test('sources and mounted logs share a socket, resume from applied entries, and reject late events', async () => {
  const sockets: Socket[] = [], notices: string[] = [], updates: SourceDelta[] = [];
  let retry: (() => void) | undefined, token = 'first';
  const client = new LiveClient(() => { const s = new Socket(); sockets.push(s); return s as unknown as WebSocket; }, () => token, msg => notices.push(msg), cb => { retry = cb; return () => { retry = undefined; }; });
  const stop = client.start(d => updates.push(d));
  const first = sockets[0]!;
  first.onopen!();
  const subscription = (logsAfter: number | null) => ({ type: 'subscribe', token, sources: true, logsAfter });
  expect(first.sent).toEqual([subscription(null)]);
  first.receive(reset);
  const feed = new LogFeed(async () => ({ lines: [entry(1)], cursor: 1, capped: false }), () => {});
  await feed.refresh();
  const leave = client.logs(() => feed.after, entries => feed.append(entries));
  expect(first.sent.at(-1)).toEqual(subscription(1));
  first.receive({ type: 'logs', entries: [entry(2)] });
  first.onclose!();
  expect(notices.at(-1)).toContain('disconnected');
  token = 'second';
  retry!();
  const next = sockets[1]!;
  next.onopen!();
  expect(next.sent).toEqual([subscription(2)]);
  first.receive(reset);
  expect(updates).toEqual([reset]);
  next.receive(reset);
  expect(notices.at(-1)).toBe('');
  next.receive({ type: 'logs', entries: [entry(2), entry(4)] });
  expect(feed.state.lines.map(e => e.seq)).toEqual([1, 2, 4]);
  expect(feed.state.capped).toBe(true);
  leave();
  expect(next.sent.at(-1)).toEqual(subscription(null));
  next.receive({ type: 'logs', entries: [entry(5)] });
  expect(feed.after).toBe(4);
  stop();
  expect(next.closed).toBe(true);
  next.onclose?.();
  expect(sockets.length).toBe(2);
});

test('a diff before the snapshot or a malformed live log cannot advance state; teardown cancels retry', () => {
  const sockets: Socket[] = [], notices: string[] = [];
  let retry: (() => void) | undefined;
  const client = new LiveClient(() => { const s = new Socket(); sockets.push(s); return s as unknown as WebSocket; }, () => '', s => notices.push(s), cb => { retry = cb; return () => { retry = undefined; }; });
  let applied = 0;
  const stop = client.start(() => { applied++; });
  sockets[0]!.onopen!();
  sockets[0]!.receive({ ...reset, reset: false });
  expect(applied).toBe(0);
  expect(sockets[0]!.closed).toBe(true);
  expect(notices.at(-1)).toContain('Could not read');
  retry!();
  const second = sockets[1]!;
  second.onopen!(); second.receive(reset);
  const feed = new LogFeed(async () => ({}), () => {});
  client.logs(() => feed.after, rows => feed.append(rows));
  second.receive({ type: 'logs', entries: [entry(1), { ...entry(2), text: null }] });
  expect(feed.after).toBe(0);
  expect(feed.state.lines).toEqual([]);
  expect(second.closed).toBe(true);
  stop();
  expect(retry).toBeUndefined();
});

test('an HTTP mutation refresh retains concurrent live upserts and removals; a live reset wins outright', async () => {
  let resolve!: (rows: SourceInfo[]) => void;
  let list: SourceInfo[] = [];
  const feed = new SourceFeed(() => new Promise(r => { resolve = r; }), rows => { list = rows; }, msg => { throw Error(String(msg)); });
  feed.apply(reset);
  const pending = feed.refresh();
  feed.apply({ type: 'sources', reset: false, upserts: [row('b', 'live')], removed: ['z'] });
  resolve([row('a', 'local edit'), row('z'), row('b', 'stale')]);
  await pending;
  expect(list).toEqual([row('a', 'local edit'), row('b', 'live')]);
  const stale = feed.refresh();
  feed.apply(reset);
  resolve([row('old')]);
  await stale;
  expect(list).toEqual([row('z')]);
});

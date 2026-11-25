import type { LogEntry } from '../../core/logs.ts';
import { LogFeed, type LogFeedState } from './log-feed.ts';

/** History pages move the oldest cursor; only the tail and live entries move the subscription cursor. */
export class PagedLogs {
  private readonly live: LogFeed;
  private readonly controller = new AbortController();
  private pending?: Promise<void>;
  private initialized = false;
  hasOlder = false;
  constructor(private readonly fetchHistory: (before: number | null, signal: AbortSignal) => Promise<unknown>, private readonly changed: (state: LogFeedState) => void) {
    this.live = new LogFeed(async () => { throw Error('Unexpected forward history request'); }, changed);
  }
  get state() { return this.live.state; }
  get after() { return this.live.after; }
  append(entries: LogEntry[]) { this.live.append(entries); }
  load() {
    if (this.initialized && !this.hasOlder) return Promise.resolve();
    this.pending ??= this.page().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async page() {
    const before = this.initialized ? this.state.lines[0]?.seq : null;
    try {
      const raw = await this.fetchHistory(before ?? null, this.controller.signal);
      if (this.controller.signal.aborted) return;
      const page = parseHistory(raw, before ?? null);
      this.hasOlder = page.hasOlder;
      if (!this.initialized) {
        this.live.seed(page.lines);
        this.initialized = true;
      } else {
        this.live.prepend(page.lines);
      }
    } catch (err) {
      if (!this.controller.signal.aborted) this.live.historyError(err);
    }
  }
  dispose() { this.controller.abort(); this.live.dispose(); }
}

import { logPage } from './log-feed.ts';
function parseHistory(value: unknown, before: number | null) {
  const page = logPage(value, 0);
  if (!('hasOlder' in page) || typeof page.hasOlder !== 'boolean' || (before !== null && page.lines.some(line => line.seq >= before)) || (page.hasOlder && !page.lines.length)) throw Error('Invalid log history page.');
  return { lines: page.lines, hasOlder: page.hasOlder };
}

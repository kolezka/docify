import type { LogEntry, LogPage } from "../../core/logs.ts";

export interface LogFeedState {
  lines: LogEntry[];
  loading: boolean;
  live: boolean;
  capped: boolean;
  error: string;
}

function logPage(value: unknown, after: number): LogPage {
  const fail = () => { throw new Error("Invalid log response. History could not be read."); };
  if (!value || typeof value !== "object") return fail();
  const page = value as LogPage;
  if (!Array.isArray(page.lines) || page.lines.length > 1000 || typeof page.capped !== "boolean" || !Number.isSafeInteger(page.cursor)) return fail();
  let previous = after;
  for (const line of page.lines) {
    if (!line || !Number.isSafeInteger(line.seq) || line.seq <= previous || typeof line.text !== "string" || typeof line.source !== "string" ||
      typeof line.ts !== "string" || !Number.isFinite(Date.parse(line.ts)) || !["stdout", "stderr", "system"].includes(line.stream) || !["info", "warn", "error"].includes(line.level)) return fail();
    previous = line.seq;
  }
  if (page.cursor !== previous) return fail();
  return page;
}

export class LogFeed {
  state: LogFeedState = { lines: [], loading: true, live: false, capped: false, error: "" };
  private cursor = 0;
  private pending?: Promise<void>;
  private stopped = false;
  private readonly controller = new AbortController();

  constructor(private readonly fetchPage: (after: number, signal: AbortSignal) => Promise<unknown>, private readonly changed: (state: LogFeedState) => void, private readonly maxLines = 10_000) {}

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.pending ??= this.load().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private publish(patch: Partial<LogFeedState>) {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }

  private async load() {
    try {
      // Yield after a bounded batch so a busy producer cannot starve rendering or retry controls.
      for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
        const page = logPage(await this.fetchPage(this.cursor, this.controller.signal), this.cursor);
        if (this.stopped) return;
        const lines = [...this.state.lines, ...page.lines];
        this.cursor = page.cursor;
        this.publish({ lines: lines.slice(-this.maxLines), capped: this.state.capped || page.capped || lines.length > this.maxLines, error: "", live: true, loading: false });
        if (page.lines.length < 1000) break;
      }
    } catch (err) {
      if (!this.stopped) this.publish({ loading: false, live: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  dispose() { this.stopped = true; this.controller.abort(); }
}

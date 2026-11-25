import type { SourceInfo } from './api.ts';
import type { LogEntry } from '../../core/logs.ts';

export interface SourceDelta { type: 'sources'; upserts: SourceInfo[]; removed: string[]; reset: boolean }
type Retry = (callback: () => void, delay: number) => () => void;
const later: Retry = (callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); };

// The app owns the connection; entering/leaving Logs only changes its subscription.
export class LiveClient {
  private socket?: WebSocket;
  private opened = false;
  private snapshot = false;
  private attempts = 0;
  private cancelRetry?: () => void;
  private sources?: (delta: SourceDelta) => void;
  private log?: { cursor: () => number; append: (entries: LogEntry[]) => void };

  constructor(private readonly connect: () => WebSocket, private readonly token: () => string,
    private readonly status: (message: string) => void, private readonly retry = later) {}

  start(sources: (delta: SourceDelta) => void) {
    this.sources = sources;
    this.open();
    return () => {
      this.sources = undefined;
      this.cancelRetry?.();
      this.attempts = 0;
      this.close();
    };
  }

  logs(cursor: () => number, append: (entries: LogEntry[]) => void) {
    const log = this.log = { cursor, append };
    this.subscribe();
    return () => { if (this.log === log) { this.log = undefined; this.subscribe(); } };
  }

  private subscribe() {
    if (!this.opened || !this.socket) return;
    try { this.socket.send(JSON.stringify({ type: 'subscribe', token: this.token(), sources: !!this.sources, logsAfter: this.log?.cursor() ?? null })); }
    catch { this.failed(); }
  }

  private close() {
    const old = this.socket;
    this.socket = undefined;
    this.opened = this.snapshot = false;
    old?.close();
  }

  private failed(reason = 'Live updates disconnected.') {
    this.close();
    this.status(`${reason} Reconnecting…`);
    this.cancelRetry = this.retry(() => this.open(), Math.min(30_000, 1000 * 2 ** Math.min(5, this.attempts++)));
  }

  private open() {
    if (!this.sources) return;
    let ws: WebSocket;
    try { ws = this.socket = this.connect(); } catch { this.failed(); return; }
    ws.onopen = () => { if (this.socket === ws) { this.opened = true; this.subscribe(); } };
    ws.onerror = () => { if (this.socket === ws) this.failed(); };
    ws.onclose = event => {
      if (this.socket !== ws) return;
      if (event?.code === 1008) {
        this.close();
        this.status(`Live updates stopped: ${event.reason || 'access denied'}. Reload after checking your access.`);
      } else this.failed(event?.reason ? `Live updates disconnected: ${event.reason}.` : undefined);
    };
    ws.onmessage = event => {
      if (this.socket !== ws) return;
      try {
        const frame = JSON.parse(event.data);
        if (frame.type === 'sources' && typeof frame.reset === 'boolean' && (this.snapshot || frame.reset) &&
          Array.isArray(frame.upserts) && frame.upserts.every((s: SourceInfo) => s && typeof s.id === 'string') &&
          Array.isArray(frame.removed) && frame.removed.every((id: unknown) => typeof id === 'string')) {
          this.sources?.(frame);
          this.snapshot = true;
          this.attempts = 0;
          this.status('');
        } else if (frame.type === 'logs' && Array.isArray(frame.entries)) {
          this.log?.append(frame.entries);
        } else throw Error('Invalid live update.');
      } catch { this.failed('Could not read live updates.'); }
    };
  }
}

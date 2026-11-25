import type { SourceInfo } from './api.ts';
import type { SourceDelta } from './live-client.ts';
import { Refresher } from './refresher.ts';

function merge(current: SourceInfo[], delta: SourceDelta) {
  const rows = new Map((delta.reset ? [] : current).map(s => [s.id, s]));
  for (const id of delta.removed) rows.delete(id);
  for (const row of delta.upserts) rows.set(row.id, row);
  return [...rows.values()];
}

export class SourceFeed {
  private list: SourceInfo[] = [];
  private duringRead?: SourceDelta[];
  private active = true;
  private readonly reads = new Refresher(async () => {
    if (!this.active) return;
    const deltas: SourceDelta[] = this.duringRead = [];
    try {
      const rows = await this.read();
      if (this.active) this.changed(this.list = deltas.reduce(merge, rows));
    } catch (err) {
      if (this.active && !deltas.some(d => d.reset)) this.failed(err);
    } finally { this.duringRead = undefined; }
  });

  constructor(private readonly read: () => Promise<SourceInfo[]>, private readonly changed: (rows: SourceInfo[]) => void,
    private readonly failed: (err: unknown) => void) {}

  refresh() { return this.reads.run(); }
  apply(delta: SourceDelta) {
    if (!this.active) return;
    this.duringRead?.push(delta);
    this.changed(this.list = merge(this.list, delta));
  }
  dispose() { this.active = false; }
}

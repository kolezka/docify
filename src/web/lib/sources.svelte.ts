import { api, errorText, webToken, type SourceInfo } from "./api.ts";
import { SourceFeed } from "./source-feed.ts";
import { LiveClient } from "./live-client.ts";

class SourceStore {
  list = $state<SourceInfo[] | null>(null);
  error = $state("");
  liveNotice = $state("");
  #feed?: SourceFeed;
  readonly live = new LiveClient(
    () => new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/live`),
    webToken, message => { this.liveNotice = message; },
  );

  start() {
    const feed = this.#feed = new SourceFeed(() => api('/api/sources', { signal: AbortSignal.timeout(15_000) }), rows => { this.list = rows; this.error = ''; }, err => { this.error = errorText(err); });
    void feed.refresh();
    const stop = this.live.start(delta => feed.apply(delta));
    return () => {
      stop();
      feed.dispose();
      this.#feed = undefined;
      this.list = null;
      this.error = this.liveNotice = '';
    };
  }

  refresh = () => this.#feed?.refresh() ?? Promise.resolve();

  byId(id: string | null): SourceInfo | undefined {
    return id ? this.list?.find((s) => s.id === id) : undefined;
  }
}

export const sources = new SourceStore();

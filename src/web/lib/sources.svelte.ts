import { api, errorText, type SourceInfo } from "./api.ts";
import { Refresher } from "./refresher.ts";

// One source list shared by the sidebar, the source pages and the search scope picker.
// It polls every second while any source is preparing.
class SourceStore {
  list = $state<SourceInfo[] | null>(null);
  error = $state("");
  #timer: ReturnType<typeof setTimeout> | undefined;
  #reads = new Refresher(async () => {
    try {
      this.list = await api<SourceInfo[]>("/api/sources");
      this.error = "";
    } catch (err) {
      this.error = errorText(err);
    }
    clearTimeout(this.#timer);
    if (this.list?.some((s) => s.state === "preparing")) this.#timer = setTimeout(this.refresh, 1000);
  });

  // After a mutation, awaiting this gives a list read after the mutation, never an older one in flight.
  refresh = (): Promise<void> => {
    clearTimeout(this.#timer);
    return this.#reads.run();
  };

  byId(id: string | null): SourceInfo | undefined {
    return id ? this.list?.find((s) => s.id === id) : undefined;
  }
}

export const sources = new SourceStore();

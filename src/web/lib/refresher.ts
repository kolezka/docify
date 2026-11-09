// Runs one read at a time. A call made while a read is running waits for a new read that starts after
// that one, so a refresh asked for after a mutation never settles on data loaded before it.
// Calls made during the same read share that one follow-up read.
export class Refresher {
  #running: Promise<void> | null = null;
  #queued: Promise<void> | null = null;

  constructor(private readonly read: () => Promise<void>) {}

  run(): Promise<void> {
    if (!this.#running) return this.#start();
    this.#queued ??= this.#running
      .catch(() => {})
      .then(() => {
        this.#queued = null;
        return this.#start();
      });
    return this.#queued;
  }

  #start(): Promise<void> {
    const current = this.read().finally(() => {
      if (this.#running === current) this.#running = null;
    });
    this.#running = current;
    return current;
  }
}

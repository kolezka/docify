interface Job {
  hosts: string[];
  start(): void;
}

// A source that receives a slot moves behind the other waiting sources.
export class CrawlPool {
  private queues = new Map<symbol, Job[]>();
  private hosts = new Map<string, number>();
  private active = 0;

  constructor(readonly capacity = 12, readonly perHost = 6) {
    for (const n of [capacity, perHost]) if (!Number.isSafeInteger(n) || n < 1) throw new RangeError('Invalid crawl concurrency');
  }

  run<T>(source: symbol, host: string | string[], signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const queue = this.queues.get(source) ?? [];
      const cancel = () => {
        queue.splice(queue.indexOf(job), 1);
        if (!queue.length) this.queues.delete(source);
        reject(signal.reason);
      };
      const hosts = typeof host === 'string' ? [host] : [...new Set(host)];
      const job = { hosts, start: () => {
        signal.removeEventListener('abort', cancel);
        Promise.resolve().then(work).then(resolve, reject).finally(() => {
          this.active--;
          for (const key of hosts) {
            const remaining = this.hosts.get(key)! - 1;
            if (remaining) this.hosts.set(key, remaining); else this.hosts.delete(key);
          }
          this.drain();
        });
      }};
      queue.push(job);
      this.queues.set(source, queue);
      signal.addEventListener('abort', cancel, { once: true });
      this.drain();
    });
  }

  private drain() {
    while (this.active < this.capacity) {
      let started = false;
      for (const [source, queue] of this.queues) {
        const job = queue[0]!;
        if (job.hosts.some(key => (this.hosts.get(key) ?? 0) >= this.perHost)) continue;
        this.queues.delete(source);
        queue.shift();
        if (queue.length) this.queues.set(source, queue);
        this.active++;
        for (const key of job.hosts) this.hosts.set(key, (this.hosts.get(key) ?? 0) + 1);
        job.start();
        started = true;
        break;
      }
      if (!started) break;
    }
  }
}

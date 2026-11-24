import type { Docify } from "./docify.ts";

// Called once each minute by serve. Read the current rows so edits, removals and
// store imports take effect without keeping a second registry of schedules.
export function refreshDueSources(docify: Docify, now = Date.now()): void {
  const minute = Math.floor(now / 60000) * 60000;
  for (const source of docify.listSourceRows()) {
    try {
      const cron = JSON.parse(source.options).refreshCron;
      if (cron === undefined) continue;
      const next = Bun.cron.parse(cron, new Date(minute - 1000));
      if (!next) throw new Error("cron has no future occurrence");
      if (next.getTime() !== minute) continue;
      void docify.prepare(source.id).catch(err => docify.logs.append(source.id, `Scheduled refresh: ${err.message}`, "system", "warn"));
    } catch (err) {
      docify.logs.append(source.id, `Invalid refresh schedule: ${String(err)}`, "system", "warn");
    }
  }
}

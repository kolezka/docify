import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Docify } from "../core/docify.ts";

type Options = { graph?: boolean; graphOnly?: boolean; force?: boolean };
type Job = { id: string; config: Docify["config"]; options: Options };

export function launchPrepare(job: Job, signal: AbortSignal) {
  const started = Promise.withResolvers<void>();
  const child = fork(fileURLToPath(import.meta.url), [], { execPath: process.execPath, execArgv: [], stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const cancel = () => { if (child.connected) child.send("cancel", () => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const done = new Promise<void>((resolve, reject) => {
    let failure: Error | undefined;
    let finished = false;
    child.on("message", (msg) => {
      if (msg === "started") started.resolve();
      else if (msg === "finished") { finished = true; started.resolve(); }
      else if (msg && typeof msg === "object" && "error" in msg) failure = new Error(String(msg.error));
    });
    child.once("error", reject);
    child.once("exit", (code, sig) => {
      if (code === 0 && finished) resolve();
      else reject(failure ?? new Error(`prepare worker exited (${sig ?? code})`));
    });
    child.send(job, err => { if (err) { child.kill(); reject(err); } });
  }).finally(() => signal.removeEventListener("abort", cancel));
  void done.catch(started.reject);
  return { started: started.promise, done };
}

if (import.meta.main) {
  const controller = new AbortController();
  process.once("disconnect", () => controller.abort());
  process.on("message", async (message: Job | "cancel") => {
    if (message === "cancel") { controller.abort(); return; }
    let store: Docify | undefined;
    try {
      store = new Docify(message.config);
      let started = false;
      await store.prepare(message.id, { ...message.options, signal: controller.signal, onPhase() {
        if (!started && process.connected) process.send!("started");
        started = true;
      } });
      if (process.connected) process.send!("finished");
    } catch (err) {
      process.exitCode = 1;
      if (process.connected) process.send!({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      store?.close();
      if (process.connected) process.disconnect!();
    }
  });
}

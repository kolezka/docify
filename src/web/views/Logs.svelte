<script lang="ts">
  import { onMount } from "svelte";
  import { LogViewer } from "svelte-log-viewer";
  import { api } from "../lib/api.ts";
  import { LogFeed, type LogFeedState } from "../lib/log-feed.ts";

  let state = $state<LogFeedState>({ lines: [], loading: true, live: false, capped: false, error: "" });
  let feed: LogFeed | undefined;
  const lines = $derived(state.lines.map((line) => ({ ...line, text: `[${line.level.toUpperCase()}] ${line.text}` })));

  onMount(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    feed = new LogFeed((after, signal) => api(`/api/logs?after=${after}&limit=1000`, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }), (next) => { state = next; });
    const poll = async () => {
      await feed!.refresh();
      if (!stopped) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); feed?.dispose(); };
  });
</script>

<main class="mx-auto flex min-h-0 w-full max-w-[1440px] flex-1 flex-col gap-4 overflow-y-auto p-5">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div>
      <h2 class="text-[18px] font-semibold tracking-tight">Application logs</h2>
      <p class="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">Docify activity and Graphify output from CLI and web preparations. The latest 10,000 lines are kept.</p>
    </div>
    <span class="text-[13px] text-zinc-500 dark:text-zinc-400" role="status">{state.loading ? "Loading history..." : state.live ? "Updating every second" : "Disconnected"}</span>
  </div>
  {#if state.error}
    <div role="alert" class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
      <span>{state.error} Previously loaded lines remain visible.</span>
      <button type="button" class="font-medium underline underline-offset-2" onclick={() => feed?.refresh()}>Retry</button>
    </div>
  {/if}
  <div class="docify-logs min-h-0 flex-1">
    <LogViewer {lines} live={state.live} loading={state.loading} capped={state.capped} showSource={true} labelOf={(source: string) => source}
      fill={true} height="max(280px, calc(100dvh - 280px))"
      labels={{ cappedNotice: "Older lines were dropped. Only the latest 10,000 lines are retained." }}
      emptyTitle="No application logs yet"
      emptyDescription="Add or prepare a source to see progress, warnings and Graphify output here. Earlier runs were not recorded." />
  </div>
</main>

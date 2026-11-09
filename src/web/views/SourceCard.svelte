<script lang="ts">
  import StatusChip from "../components/StatusChip.svelte";
  import { api, errorText, type SourceInfo } from "../lib/api.ts";
  import { ago, fraction } from "../lib/format.ts";
  import { button, panel, sourceTone } from "../lib/ui.ts";

  let { source: s, onchanged, onerror }: { source: SourceInfo; onchanged: () => void; onerror: (message: string) => void } = $props();

  let busy = $state(false);
  let confirmRemove = $state(false);
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;

  const path = $derived(`/api/sources/${encodeURIComponent(s.id)}`);
  const g = $derived(s.activeGeneration);
  const preparing = $derived(s.state === "preparing");
  const progressText = $derived(preparing ? [s.latest?.phase, s.latest?.progress].filter(Boolean).join(" ") : "");
  const progress = $derived(fraction(s.latest?.progress));
  const failure = $derived(s.latest?.status === "failed" ? (s.latest.error ?? "failed") : null);
  const passages = $derived(typeof g?.stats.passages === "number" ? g.stats.passages : null);

  async function run(action: () => Promise<unknown>) {
    busy = true;
    try {
      await action();
    } catch (err) {
      onerror(errorText(err));
    } finally {
      busy = false;
    }
    onchanged();
  }

  function remove() {
    if (!confirmRemove) {
      confirmRemove = true;
      confirmTimer = setTimeout(() => (confirmRemove = false), 4000);
      return;
    }
    clearTimeout(confirmTimer);
    confirmRemove = false;
    run(() => api(path, { method: "DELETE", body: {} }));
  }
</script>

<article class={panel({ class: "flex flex-col gap-2 p-3" })} data-source={s.id}>
  <div class="flex items-start justify-between gap-2">
    <div class="flex min-w-0 flex-wrap items-center gap-2">
      <span class="font-mono text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{s.id}</span>
      <span class="rounded bg-zinc-100 px-1.5 py-0.5 text-[12px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">{s.kind}</span>
      <StatusChip tone={sourceTone(s.state)} label={s.state.replace("_", " ")} />
    </div>
    <div class="flex shrink-0 flex-wrap justify-end gap-1">
      {#if preparing}
        <button type="button" class={button({ size: "xs" })} disabled={busy} onclick={() => run(() => api(`${path}/cancel`, { method: "POST", body: {} }))}>Cancel</button>
      {:else}
        <button type="button" class={button({ intent: "accent", size: "xs" })} disabled={busy} onclick={() => run(() => api(`${path}/prepare`, { method: "POST", body: { graph: true } }))}
          >Prepare</button
        >
        <button
          type="button"
          class={button({ size: "xs" })}
          title="Prepare without building the semantic graph"
          disabled={busy}
          onclick={() => run(() => api(`${path}/prepare`, { method: "POST", body: { graph: false } }))}>No graph</button
        >
        <button type="button" class={button({ intent: confirmRemove ? "confirm" : "danger", size: "xs" })} disabled={busy} onclick={remove}
          >{confirmRemove ? "Confirm remove" : "Remove"}</button
        >
      {/if}
    </div>
  </div>

  <p class="truncate font-mono text-[12px] text-zinc-400 dark:text-zinc-500" title={s.locator}>{s.locator}</p>

  {#if preparing}
    <div class="text-[12px] text-zinc-500 dark:text-zinc-400">{progressText || "starting"}</div>
    <div class="h-1 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800" role="progressbar" aria-label="Preparation progress">
      {#if progress !== null}
        <div class="h-full rounded-full bg-indigo-500 transition-[width] duration-300" style:width={`${Math.round(progress * 100)}%`}></div>
      {:else}
        <div class="h-full w-1/3 animate-pulse rounded-full bg-indigo-500/70"></div>
      {/if}
    </div>
  {:else if g}
    <div class="flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-zinc-500 dark:text-zinc-400">
      {#if passages !== null}<span><span class="font-medium text-zinc-700 dark:text-zinc-300">{passages}</span> passages</span>{/if}
      <span>gen {g.id}</span>
      {#if g.embeddingModel}<span class="font-mono">{g.embeddingModel}</span>{/if}
      <span>graph {g.graphStatus ?? "none"}</span>
      <span title={g.downloadedAt ?? undefined}>downloaded {ago(g.downloadedAt)}</span>
    </div>
  {:else if !failure}
    <div class="text-[12px] text-zinc-500 dark:text-zinc-400">Not prepared yet.</div>
  {/if}

  {#if failure}
    <p class="font-mono text-[12px] break-words text-rose-600 dark:text-rose-400">{failure}</p>
  {/if}
</article>

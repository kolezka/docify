<script lang="ts">
  import { onMount } from "svelte";
  import SourceCard from "./SourceCard.svelte";
  import { api, errorText, type SourceInfo } from "../lib/api.ts";
  import { button, cn, input, panel } from "../lib/ui.ts";

  let { class: className = "" }: { class?: string } = $props();

  let list = $state<SourceInfo[] | null>(null);
  let error = $state("");
  let library = $state("");
  let version = $state("");
  let locator = $state("");
  let adding = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function refresh() {
    clearTimeout(timer);
    try {
      list = await api<SourceInfo[]>("/api/sources");
    } catch (err) {
      error = errorText(err);
    }
    if (list?.some((s) => s.state === "preparing")) timer = setTimeout(refresh, 1000);
  }

  onMount(() => {
    refresh();
    return () => clearTimeout(timer);
  });

  async function add(ev: SubmitEvent) {
    ev.preventDefault();
    error = "";
    adding = true;
    const loc = locator.trim();
    try {
      await api("/api/sources", { method: "POST", body: { library, version, locator: loc, kind: /^https?:\/\//.test(loc) ? "url" : "local" } });
      library = version = locator = "";
    } catch (err) {
      error = errorText(err);
    } finally {
      adding = false;
    }
    await refresh();
  }
</script>

<section class={cn("flex min-h-0 flex-col gap-4", className)} aria-labelledby="sources-title">
  <div class="flex items-baseline justify-between">
    <h2 id="sources-title" class="text-[14px] font-semibold">Sources</h2>
    {#if list}<span class="text-[12px] text-zinc-500 dark:text-zinc-400">{list.length} {list.length === 1 ? "source" : "sources"}</span>{/if}
  </div>

  <form class={panel({ class: "flex shrink-0 flex-wrap items-center gap-2 p-3" })} onsubmit={add}>
    <input class={input({ class: "w-24 flex-none" })} name="library" placeholder="library" aria-label="Library" required bind:value={library} />
    <input class={input({ class: "w-20 flex-none" })} name="version" placeholder="version" aria-label="Version" bind:value={version} />
    <input class={input({ class: "flex-1 basis-48" })} name="locator" placeholder="local path or https:// URL" aria-label="Local path or URL" required bind:value={locator} />
    <button type="submit" class={button({ intent: "primary" })} disabled={adding}>Add</button>
  </form>
  {#if error}<p class="-mt-2 text-[12px] break-words whitespace-pre-wrap text-rose-600 dark:text-rose-400" role="alert">{error}</p>{/if}

  <div class="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1 pb-4">
    {#if list === null}
      <p class="text-[13px] text-zinc-500 dark:text-zinc-400">Loading sources...</p>
    {:else if list.length === 0}
      <p class="text-[13px] text-zinc-500 dark:text-zinc-400">No sources yet. Add a local folder or a documentation URL above, then prepare it.</p>
    {:else}
      {#each list as s (s.id)}
        <SourceCard source={s} onchanged={refresh} onerror={(m) => (error = m)} />
      {/each}
    {/if}
  </div>
</section>

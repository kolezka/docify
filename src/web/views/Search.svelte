<script lang="ts">
  import Segmented from "../components/Segmented.svelte";
  import StatusChip from "../components/StatusChip.svelte";
  import { api, errorText, type Mode, type ReadResult, type SearchHit, type SearchResult } from "../lib/api.ts";
  import { button, cn, input, panel, searchTone } from "../lib/ui.ts";

  let { class: className = "" }: { class?: string } = $props();

  let query = $state("");
  let library = $state("");
  let version = $state("");
  let mode = $state<Mode>("combined");
  let maxTokens = $state(1500);
  let graphWeight = $state(0);

  let searching = $state(false);
  let error = $state("");
  let result = $state<SearchResult | null>(null);
  let tab = $state<"agent" | "passage">("agent");
  let passage = $state<{ id: string; text: string } | null>(null);
  let reading = $state<string | null>(null);

  const modes: { value: Mode; label: string }[] = [
    { value: "combined", label: "combined" },
    { value: "lexical", label: "lexical" },
    { value: "vector", label: "vector" },
    { value: "graph", label: "graph" },
  ];
  const usage = $derived(result ? Math.min(1, result.tokens / Math.max(1, result.maxTokens)) : 0);
  const totalMs = $derived(result ? Math.round(result.timings.totalMs ?? 0) : 0);

  async function submit(ev: SubmitEvent) {
    ev.preventDefault();
    searching = true;
    error = "";
    try {
      result = await api<SearchResult>("/api/search", { method: "POST", body: { query, library, version, mode, maxTokens: Number(maxTokens), graphWeight: Number(graphWeight) } });
      tab = "agent";
      passage = null;
    } catch (err) {
      error = errorText(err);
    } finally {
      searching = false;
    }
  }

  async function open(hit: SearchHit) {
    reading = hit.id;
    tab = "passage";
    try {
      passage = { id: hit.id, text: (await api<ReadResult>(`/api/read/${hit.id}`)).text };
    } catch (err) {
      passage = { id: hit.id, text: errorText(err) };
    } finally {
      reading = null;
    }
  }

  const tabClass = (active: boolean) =>
    cn(
      "-mb-px border-b-2 px-4 py-2.5 text-[13px] font-medium transition-colors",
      active ? "border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400" : "border-transparent text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
    );
</script>

<section class={cn("flex min-h-0 flex-col gap-4 lg:overflow-y-auto lg:pr-1", className)} aria-labelledby="search-title">
  <h2 id="search-title" class="text-[14px] font-semibold">Search</h2>

  <form class={panel({ class: "flex shrink-0 flex-col gap-3 p-4" })} onsubmit={submit}>
    <div class="relative">
      <input
        class={input({ class: "h-10 pr-24 text-[14px] font-medium placeholder:font-normal" })}
        name="query"
        placeholder="question, API symbol or error"
        aria-label="Query"
        required
        bind:value={query}
      />
      <button type="submit" class={button({ intent: "primary", class: "absolute top-1 right-1 h-8" })} disabled={searching}>{searching ? "Searching" : "Search"}</button>
    </div>
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] font-medium text-zinc-600 dark:text-zinc-400">
      <label class="flex items-center gap-2">Library <input class={input({ class: "h-7 w-24 font-normal" })} bind:value={library} /></label>
      <label class="flex items-center gap-2">Version <input class={input({ class: "h-7 w-20 font-normal" })} bind:value={version} /></label>
      <div class="flex items-center gap-2">Mode <Segmented options={modes} bind:value={mode} label="Search mode" size="xs" /></div>
      <label class="flex items-center gap-2">Max tokens <input type="number" min="200" max="20000" step="100" class={input({ class: "h-7 w-20 font-normal" })} bind:value={maxTokens} /></label>
      <label class="flex items-center gap-2"
        >Graph weight <input type="number" min="0" max="1" step="0.05" class={input({ class: "h-7 w-16 font-normal" })} bind:value={graphWeight} /></label
      >
    </div>
  </form>

  {#if error}<p class="text-[12px] break-words whitespace-pre-wrap text-rose-600 dark:text-rose-400" role="alert">{error}</p>{/if}

  <div class="flex min-h-0 flex-1 flex-col gap-4">
    {#if result}
      <div class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-1 text-[13px]">
        <StatusChip tone={searchTone(result.status)} label={result.status.replace("_", " ")} dot={false} />
        <div class="flex w-44 items-center gap-2 text-zinc-500 dark:text-zinc-400" title="Tokens of the text handed to agents">
          <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
            <div class="h-full rounded-full bg-zinc-400 dark:bg-zinc-500" style:width={`${Math.round(usage * 100)}%`}></div>
          </div>
          <span class="font-mono text-[12px]">{result.tokens} / {result.maxTokens}</span>
        </div>
        <div class="text-zinc-500 dark:text-zinc-400">
          <span class="font-medium text-zinc-700 dark:text-zinc-200">{result.hits.length}</span>
          {result.hits.length === 1 ? "hit" : "hits"}
          {#if result.omitted}<span> ({result.omitted} omitted)</span>{/if}
          &middot; <span class="font-medium text-zinc-700 dark:text-zinc-200">{totalMs}</span> ms
        </div>
      </div>

      {#if result.warnings.length}
        <ul class="flex shrink-0 flex-col gap-1 px-1 text-[12px] text-amber-700 dark:text-amber-300">
          {#each result.warnings as w, i (i)}<li>{w}</li>{/each}
        </ul>
      {/if}

      {#if result.hits.length}
        <div class="flex max-h-52 shrink-0 flex-col gap-1 overflow-y-auto px-1">
          {#each result.hits as hit (hit.id)}
            <button
              type="button"
              onclick={() => open(hit)}
              class={cn(
                "flex items-center gap-2 rounded-md border p-2 text-left text-[13px] transition-colors",
                passage?.id === hit.id && tab === "passage"
                  ? "border-zinc-200 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800"
                  : "border-transparent hover:border-zinc-200 hover:bg-zinc-100 dark:hover:border-zinc-800 dark:hover:bg-zinc-900",
              )}
            >
              <span class="w-6 shrink-0 font-mono text-[12px] text-zinc-400 dark:text-zinc-500">[{hit.rank}]</span>
              <span class="shrink-0 font-mono text-[12px] text-zinc-600 dark:text-zinc-400">{hit.citation.source}</span>
              <span class="min-w-0 flex-1 truncate text-zinc-800 dark:text-zinc-200">
                {hit.citation.url ?? hit.citation.document}
                {#each hit.citation.headingPath as h, i (i)}<span class="mx-1 text-zinc-400 dark:text-zinc-600">&gt;</span>{h}{/each}
              </span>
              <span class="shrink-0 text-[12px] text-zinc-500 dark:text-zinc-400"
                >lines {hit.citation.lines[0]}-{hit.citation.lines[1]}{hit.truncated ? ", truncated" : ""}</span
              >
            </button>
          {/each}
        </div>
      {/if}
    {/if}

    <div class={panel({ class: "flex min-h-72 flex-1 flex-col overflow-hidden" })}>
      <div class="flex shrink-0 border-b border-zinc-200 bg-zinc-50/50 px-2 dark:border-zinc-800 dark:bg-zinc-900" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "agent"} class={tabClass(tab === "agent")} onclick={() => (tab = "agent")}>Agent text</button>
        <button type="button" role="tab" aria-selected={tab === "passage"} class={tabClass(tab === "passage")} onclick={() => (tab = "passage")}>Passage</button>
      </div>
      <div class="flex-1 overflow-y-auto bg-zinc-50 p-4 dark:bg-zinc-950">
        {#if tab === "agent"}
          {#if result}
            <pre class="font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap text-zinc-800 dark:text-zinc-200">{result.text}</pre>
          {:else}
            <p class="text-[13px] text-zinc-500 dark:text-zinc-400">Run a search to see the exact text an agent receives.</p>
          {/if}
        {:else if reading}
          <p class="text-[13px] text-zinc-500 dark:text-zinc-400">Loading passage...</p>
        {:else if passage}
          <pre class="font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap text-zinc-800 dark:text-zinc-200">{passage.text}</pre>
        {:else}
          <p class="text-[13px] text-zinc-500 dark:text-zinc-400">Click a citation to read its passage with surrounding context.</p>
        {/if}
      </div>
    </div>
  </div>
</section>

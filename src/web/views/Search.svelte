<script lang="ts">
  import { Check, Copy, ExternalLink, Search as SearchIcon, SlidersHorizontal } from "@lucide/svelte";
  import Segmented from "../components/Segmented.svelte";
  import StatusChip from "../components/StatusChip.svelte";
  import StatusIcon from "../components/StatusIcon.svelte";
  import Toolbar from "../components/Toolbar.svelte";
  import { api, errorText, type Mode, type ReadResult, type SearchHit, type SearchResult } from "../lib/api.ts";
  import { nav } from "../lib/nav.svelte.ts";
  import { sources } from "../lib/sources.svelte.ts";
  import { button, capsule, capsuleButton, cn, footnote, input, notice, panel, popup, searchStatusLabel, searchTone } from "../lib/ui.ts";

  let query = $state("");
  let scope = $state("");
  let mode = $state<Mode>("combined");
  let maxTokens = $state(1500);
  let graphWeight = $state(0);
  let showOptions = $state(false);

  let searching = $state(false);
  let error = $state("");
  let result = $state<SearchResult | null>(null);
  // The reader shows the agent text or one hit's passage.
  let selected = $state<SearchHit | null>(null);
  let passage = $state<{ id: string; read: ReadResult | null; error: string } | null>(null);
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  const modes: { value: Mode; label: string }[] = [
    { value: "combined", label: "Combined" },
    { value: "lexical", label: "Lexical" },
    { value: "vector", label: "Vector" },
    { value: "graph", label: "Graph" },
  ];
  const prepared = $derived((sources.list ?? []).filter((s) => s.activeGeneration));
  const scopeSource = $derived(prepared.find((s) => s.id === scope));
  const noPrepared = $derived(sources.list !== null && prepared.length === 0);
  const usage = $derived(result ? Math.min(1, result.tokens / Math.max(1, result.maxTokens)) : 0);
  const totalMs = $derived(result ? Math.round(result.timings.totalMs ?? 0) : 0);
  const fmt = (n: number) => n.toLocaleString("en-US");

  async function submit(ev: SubmitEvent) {
    ev.preventDefault();
    if (!query.trim() || searching) return;
    searching = true;
    error = "";
    // A scope names one source by id, which is exact even when two sources share a library and version.
    const body: Record<string, unknown> = { query, mode, maxTokens: Number(maxTokens), graphWeight: Number(graphWeight) };
    if (scopeSource) body.sources = [scopeSource.id];
    try {
      result = await api<SearchResult>("/api/search", { method: "POST", body });
      selected = null;
      passage = null;
    } catch (err) {
      error = errorText(err);
    } finally {
      searching = false;
    }
  }

  async function open(hit: SearchHit) {
    selected = hit;
    copied = false;
    if (passage?.id === hit.id && passage.read) return;
    passage = { id: hit.id, read: null, error: "" };
    try {
      const read = await api<ReadResult>(`/api/read/${hit.id}`);
      if (passage?.id === hit.id) passage = { id: hit.id, read, error: "" };
    } catch (err) {
      if (passage?.id === hit.id) passage = { id: hit.id, read: null, error: errorText(err) };
    }
  }

  async function copyId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 1500);
    } catch (err) {
      error = `Could not copy the passage id: ${errorText(err)}`;
    }
  }

  const title = (hit: SearchHit) => hit.citation.headingPath.at(-1) ?? hit.citation.document;
  const parents = (hit: SearchHit) => hit.citation.headingPath.slice(0, -1);
  const lines = (hit: SearchHit) => `lines ${hit.citation.lines[0]}–${hit.citation.lines[1]}`;
</script>

<section class="flex min-h-0 flex-1 flex-col" aria-label="Search">
  <Toolbar class="h-[60px]">
    <form class={capsule({ class: "h-[34px] max-w-[640px] min-w-0 flex-1 gap-2 pr-1 pl-3 focus-within:ring-[3px] focus-within:ring-accent-soft" })} onsubmit={submit} role="search">
      <SearchIcon size={16} strokeWidth={1.75} class="shrink-0 text-label2" aria-hidden="true" />
      <input
        class="h-full min-w-0 flex-1 bg-transparent text-[15px] font-medium text-label placeholder:font-normal placeholder:text-label2 focus:outline-none"
        name="query"
        placeholder="Question, API symbol or error"
        aria-label="Query"
        autocomplete="off"
        required
        bind:value={query}
      />
      <button type="submit" class={button({ intent: "primary", size: "xs", class: "rounded-full" })} disabled={searching}>{searching ? "Searching…" : "Search"}</button>
    </form>
    <select class={popup({ class: "h-[30px] max-w-48 rounded-full" })} aria-label="Search scope" bind:value={scope}>
      <option value="">All Sources</option>
      {#each prepared as s (s.id)}<option value={s.id}>{s.library}{s.version ? ` ${s.version}` : ""}</option>{/each}
    </select>
    <span class="flex-1"></span>
    <span class={capsule()}>
      <button
        type="button"
        class={capsuleButton({ class: cn("px-0", showOptions && "text-accent-text") })}
        title="Search options"
        aria-label="Search options"
        aria-expanded={showOptions}
        aria-controls="search-options"
        onclick={() => (showOptions = !showOptions)}><SlidersHorizontal size={16} strokeWidth={1.75} /></button
      >
    </span>
  </Toolbar>

  {#if showOptions}
    <div id="search-options" class="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 px-5 pb-3 text-[13px] text-label">
      <label class="flex items-center gap-2"
        >Max tokens <input type="number" min="200" max="20000" step="100" class={input({ mono: true, class: "w-24" })} bind:value={maxTokens} /></label
      >
      <label class="flex items-center gap-2"
        >Graph weight <input type="number" min="0" max="1" step="0.05" class={input({ mono: true, class: "w-20" })} bind:value={graphWeight} /></label
      >
      <span class={footnote}>Graph weight applies to Combined mode.</span>
    </div>
  {/if}

  <div class="flex shrink-0 flex-wrap items-center gap-x-3.5 gap-y-2 px-5 pb-3">
    <Segmented options={modes} bind:value={mode} label="Search mode" />
    {#if result}
      <StatusChip tone={searchTone(result.status)} label={searchStatusLabel(result.status)} />
      <span class={footnote}>
        {result.hits.length}
        {result.hits.length === 1 ? "passage" : "passages"} in {fmt(totalMs)} ms{#if result.omitted > 0}&nbsp;· {result.omitted} more did not fit{/if}
      </span>
      <span class={cn(footnote, "ml-auto flex items-center gap-2")} title="Tokens of the text handed to agents">
        <span class="h-1.5 w-24 overflow-hidden rounded-full bg-fill" aria-hidden="true">
          <span class="block h-full rounded-full bg-accent" style:width={`${Math.round(usage * 100)}%`}></span>
        </span>
        <span class="font-mono">{fmt(result.tokens)} / {fmt(result.maxTokens)} tokens</span>
      </span>
    {/if}
  </div>

  {#if error}
    <div class="shrink-0 px-5 pb-3">
      <p class={notice({ tone: "bad", class: "break-words whitespace-pre-wrap" })} role="alert"><StatusIcon tone="bad" class="mt-0.5" />{error}</p>
    </div>
  {/if}
  {#if result?.warnings.length}
    <ul class="flex shrink-0 flex-col gap-1 px-5 pb-3">
      {#each result.warnings as w, i (i)}
        <li class="flex items-start gap-2 text-[13px] leading-[18px] text-warn-text"><StatusIcon tone="warn" class="mt-0.5" />{w}</li>
      {/each}
    </ul>
  {/if}

  <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4 md:flex-row md:overflow-hidden md:pl-5">
    {#if result}
      <ul class={panel({ class: "max-h-64 shrink-0 overflow-y-auto py-1 md:max-h-none md:w-[360px]" })} aria-label="Results">
        {#each result.hits as hit (hit.id)}
          {@const on = selected?.id === hit.id}
          {@const sub = [parents(hit).join(" › "), hit.citation.library].filter(Boolean).join(" · ")}
          <li class="relative [&+&]:before:absolute [&+&]:before:top-0 [&+&]:before:right-0 [&+&]:before:left-3.5 [&+&]:before:h-px [&+&]:before:bg-sep/60">
            <button
              type="button"
              onclick={() => open(hit)}
              aria-current={on ? "true" : undefined}
              class={cn(
                "relative block w-[calc(100%-8px)] rounded-lg px-2.5 py-2.5 text-left focus-visible:ring-[3px] focus-visible:ring-accent-soft focus-visible:outline-none",
                "mx-1",
                on ? "z-10 bg-accent text-white" : "text-label hover:bg-fill/60",
              )}
            >
              <span class="flex justify-between gap-2">
                <span class="min-w-0 truncate text-[13px] font-semibold">{title(hit)}</span>
                <span class={cn("shrink-0 font-mono text-[11px]", on ? "text-white" : "text-label2")}>{hit.rank}</span>
              </span>
              <span class={cn("mt-0.5 block truncate text-[11px] leading-[14px]", on ? "text-white" : "text-label2")}>{sub}</span>
              <span class={cn("mt-0.5 block truncate text-[11px] leading-[14px]", on ? "text-white" : "text-label2")}
                ><span class="font-mono">{lines(hit)}</span>{#if hit.truncated}&nbsp;· truncated{/if}</span
              >
            </button>
          </li>
        {/each}
        <li class="relative [&+&]:before:absolute [&+&]:before:top-0 [&+&]:before:right-0 [&+&]:before:left-3.5 [&+&]:before:h-px [&+&]:before:bg-sep/60">
          <button
            type="button"
            onclick={() => {
              selected = null;
              copied = false;
            }}
            aria-current={selected ? undefined : "true"}
            class={cn(
              "mx-1 block w-[calc(100%-8px)] rounded-lg px-2.5 py-2.5 text-left focus-visible:ring-[3px] focus-visible:ring-accent-soft focus-visible:outline-none",
              selected ? "hover:bg-fill/60" : "bg-accent text-white",
            )}
          >
            <span class={cn("block text-[13px] font-medium", selected ? "text-accent-text" : "text-white")}>Show Agent Text</span>
            <span class={cn("mt-0.5 block text-[11px] leading-[14px]", selected ? "text-label2" : "text-white")}>The exact text an agent receives for this query</span>
          </button>
        </li>
      </ul>
    {/if}

    <div class={panel({ class: "flex min-h-80 min-w-0 flex-1 flex-col overflow-hidden" })}>
      {#if result && selected}
        {@const hit = selected}
        <div class="flex shrink-0 flex-wrap items-start gap-2.5 border-b border-sep px-4 pt-3.5 pb-3">
          <div class="min-w-0 flex-1">
            <h2 class="text-[15px] leading-5 font-semibold break-words">{title(hit)}</h2>
            {#if parents(hit).length}<p class={cn(footnote, "mt-0.5")}>{parents(hit).join(" › ")}</p>{/if}
            <p class={cn(footnote, "mt-1 font-mono break-all")}>{hit.citation.source} · {lines(hit)} · {hit.id}</p>
          </div>
          <button type="button" class={button({ size: "xs" })} onclick={() => copyId(hit.id)}>
            {#if copied}<Check size={14} strokeWidth={1.75} />Copied{:else}<Copy size={14} strokeWidth={1.75} />Copy ID{/if}
          </button>
          {#if hit.citation.url}
            <a class={button({ size: "xs" })} href={hit.citation.url} target="_blank" rel="noreferrer"><ExternalLink size={14} strokeWidth={1.75} />Open Page</a>
          {/if}
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto bg-code">
          {#if passage?.id === hit.id && passage.error}
            <div class="p-4"><p class={notice({ tone: "bad", class: "break-words whitespace-pre-wrap" })} role="alert"><StatusIcon tone="bad" class="mt-0.5" />{passage.error}</p></div>
          {:else if passage?.id === hit.id && passage.read}
            <pre class="p-4 font-mono text-[12px] leading-[18px] break-words whitespace-pre-wrap text-label">{passage.read.text}</pre>
          {:else}
            <p class="p-4 text-[13px] text-label2" aria-live="polite">Loading passage…</p>
          {/if}
        </div>
      {:else if result}
        <div class="flex shrink-0 items-start gap-2.5 border-b border-sep px-4 pt-3.5 pb-3">
          <div class="min-w-0 flex-1">
            <h2 class="text-[15px] leading-5 font-semibold">Agent Text</h2>
            <p class={cn(footnote, "mt-0.5")}>The exact text an agent receives for this query</p>
          </div>
        </div>
        <pre class="min-h-0 flex-1 overflow-y-auto bg-code p-4 font-mono text-[12px] leading-[18px] break-words whitespace-pre-wrap text-label">{result.text}</pre>
      {:else if noPrepared}
        <div class="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p class="max-w-sm text-[13px] text-label2">No source is prepared yet. Add a documentation source and prepare it to search it here.</p>
          <button type="button" class={button({ intent: "primary", size: "md" })} onclick={() => (nav.addingSource = true)}>Add Source</button>
        </div>
      {:else}
        <div class="flex flex-1 items-center justify-center p-8 text-center">
          <p class="max-w-sm text-[13px] text-label2">Search your prepared documentation. The agent text shows exactly what an agent receives.</p>
        </div>
      {/if}
    </div>
  </div>
</section>

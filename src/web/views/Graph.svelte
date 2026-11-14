<script lang="ts">
  import { onMount, tick } from "svelte";
  import { Maximize, Minus, Plus, Rotate3d, RotateCcw, Search as SearchIcon, X } from "@lucide/svelte";
  import Group from "../components/Group.svelte";
  import Row from "../components/Row.svelte";
  import StatusChip from "../components/StatusChip.svelte";
  import StatusIcon from "../components/StatusIcon.svelte";
  import Toolbar from "../components/Toolbar.svelte";
  import { api, errorText, type GraphView, type SourceInfo } from "../lib/api.ts";
  import { GraphRenderer, type Theme } from "../lib/graph-renderer.ts";
  import { createGraphSearch, isEmptyQuery, matchRanges, parseQuery, type MatchField } from "../lib/graph-search.ts";
  import { isEditableTarget } from "../lib/shortcuts.ts";
  import { button, capsule, capsuleButton, cn, footnote, notice, panel, popup } from "../lib/ui.ts";

  const STORE_KEY = "docify-graph-source";
  // Legend order; each type also has its own shape in the renderer.
  const NODE_TYPES = ["concept", "document", "code"];
  const MAX_LABELS = 10;
  const MAX_HUBS = 6;
  // Widest a node label gets, in CSS pixels: the selection's, then any other.
  const LABEL_MAX_MAIN = 240;
  const LABEL_MAX = 176;
  const MAX_RESULTS = 50;
  // Filters the search field understands, offered while it is empty.
  const HINTS = ["type:concept", "type:document", "type:code", "is:ungrounded", "links:>5", "page:", "group:"];
  const FIELD_NOTE: Record<MatchField, string> = { label: "", id: "Node id", page: "Page", group: "Group", text: "Passage", filter: "" };
  const MAX_LINKS = 8;
  const MAX_MISSING = 8;

  let sources = $state<SourceInfo[] | null>(null);
  let sourceId = $state("");
  let graph = $state<GraphView | null>(null);
  let loading = $state(false);
  let error = $state("");
  let renderError = $state("");
  let selected = $state(-1);
  let showAllLinks = $state(false);
  let labels = $state<{ index: number; x: number; y: number; w: number; main: boolean }[]>([]);
  let hovered = $state(-1);
  let query = $state("");
  let searchFocused = $state(false);
  let active = $state(0);
  let hiddenTypes = $state<string[]>([]);
  let autoRotate = $state(false);
  let reduceMotion = $state(false);
  // Bumped for each new renderer, so the effects below push their state into it.
  let rendererVersion = $state(0);
  let mounts = 0;
  let searchInput = $state<HTMLInputElement>();

  let canvas = $state<HTMLCanvasElement>();
  let stage = $state<HTMLDivElement>();
  let renderer: GraphRenderer | null = null;
  let loadToken = 0;

  const hasGraph = (s: SourceInfo) => s.activeGeneration?.graphStatus === "ok" || s.activeGeneration?.graphStatus === "partial";
  const withGraph = $derived((sources ?? []).filter(hasGraph));
  const node = $derived(graph && selected >= 0 ? graph.nodes[selected] : null);
  const drawn = $derived(!!graph?.nodes.length && !renderError);
  const links = $derived.by(() => {
    if (!graph || selected < 0) return [];
    const out: { other: number; relation: string; outgoing: boolean }[] = [];
    for (const e of graph.edges) {
      if (e.source === selected) out.push({ other: e.target, relation: e.relation, outgoing: true });
      else if (e.target === selected) out.push({ other: e.source, relation: e.relation, outgoing: false });
    }
    return out.sort((a, b) => graph!.nodes[b.other]!.degree - graph!.nodes[a.other]!.degree);
  });
  // The three known types always, then any other type the graph holds (the renderer draws those as documents).
  const typeCounts = $derived.by(() => {
    const counts = new Map<string, number>(NODE_TYPES.map((t) => [t, 0]));
    for (const n of graph?.nodes ?? []) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
    return [...counts].filter(([type, count]) => NODE_TYPES.includes(type) || count > 0);
  });
  const missing = $derived(graph?.stats.missingDocuments ?? []);

  // Search runs in the browser over the graph already loaded; it never calls the server.
  const searcher = $derived(
    graph
      ? createGraphSearch(
          graph.nodes.map((n) => ({
            id: n.id,
            label: n.label,
            type: n.type,
            page: n.page,
            group: n.group >= 0 ? (graph!.groups[n.group]?.label ?? null) : null,
            grounded: n.grounding !== null,
            degree: n.degree,
            text: n.grounding ? `${n.grounding.headingPath.join(" > ")}\n${n.grounding.excerpt}` : "",
          })),
        )
      : null,
  );
  const parsed = $derived(parseQuery(query));
  const searching = $derived(!isEmptyQuery(parsed));
  // A hidden type is left out, so a result never leads to a node that is not drawn.
  const hits = $derived(searcher && graph && searching ? searcher.search(parsed).filter((h) => !hiddenTypes.includes(graph!.nodes[h.index]!.type)) : []);
  const listOpen = $derived(searchFocused && drawn);
  // Best-connected nodes first, for the labels shown when nothing else asks for one.
  const hubs = $derived(
    (graph?.nodes ?? [])
      .map((n, index) => ({ index, degree: n.degree }))
      .filter((n) => n.degree > 1)
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 40)
      .map((n) => n.index),
  );

  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  function currentTheme(): Theme {
    const root = document.documentElement;
    if (root.classList.contains("dark")) return "dark";
    if (root.classList.contains("light")) return "light";
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function duration(ms: number | null) {
    if (ms === null) return null;
    const s = Math.round(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
  }

  // Labels, in order of importance: the selection, the hovered node, then the selection's best-connected
  // neighbours, or the search matches, or the hubs in view. Any that would overlap an earlier one is skipped.
  function placeLabels(screen: Float32Array) {
    if (!graph || !stage) {
      if (labels.length) labels = [];
      return;
    }
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    const inView = (index: number) => !!screen[index * 4 + 3] && screen[index * 4]! >= 0 && screen[index * 4]! <= width && screen[index * 4 + 1]! >= 0 && screen[index * 4 + 1]! <= height;
    const ids: number[] = [];
    const add = (index: number) => {
      if (index >= 0 && !ids.includes(index)) ids.push(index);
    };
    add(selected);
    add(hovered);
    if (selected >= 0) for (const l of links.slice(0, MAX_LABELS)) add(l.other);
    else if (searching) for (const h of hits.slice(0, MAX_LABELS)) add(h.index);
    else {
      let shown = 0;
      for (const index of hubs) {
        if (shown >= MAX_HUBS) break;
        if (!inView(index)) continue;
        add(index);
        shown++;
      }
    }
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const next: typeof labels = [];
    for (const index of ids) {
      if (!inView(index)) continue;
      const main = index === selected;
      const text = graph.nodes[index]!.label;
      // An estimate, used to centre the label and to keep labels apart; the real width is capped in CSS.
      const w = Math.min(main ? LABEL_MAX_MAIN : LABEL_MAX, text.length * (main ? 7.2 : 6.5) + 16);
      const h = main ? 22 : 19;
      const x = Math.max(4, Math.min(width - w - 4, screen[index * 4]! - w / 2));
      const y = screen[index * 4 + 1]! + (main ? 12 : 8);
      if (placed.some((r) => x < r.x + r.w + 4 && x + w + 4 > r.x && y < r.y + r.h + 2 && y + h + 2 > r.y)) continue;
      placed.push({ x, y, w, h });
      next.push({ index, x, y, w, main });
    }
    labels = next;
  }

  function select(index: number, center = true) {
    // A node reached from a list must be drawn, so its type comes back if it was hidden.
    const type = index >= 0 ? graph?.nodes[index]?.type : undefined;
    if (type && hiddenTypes.includes(type)) hiddenTypes = hiddenTypes.filter((t) => t !== type);
    selected = index;
    showAllLinks = false;
    renderer?.select(index, { center });
  }

  function toggleType(type: string) {
    hiddenTypes = hiddenTypes.includes(type) ? hiddenTypes.filter((t) => t !== type) : [...hiddenTypes, type];
    if (node && hiddenTypes.includes(node.type)) select(-1);
  }

  // Text cut into plain and matched pieces, for marking the query in a result.
  function pieces(text: string): { text: string; hit: boolean }[] {
    const out: { text: string; hit: boolean }[] = [];
    let at = 0;
    for (const [start, end] of matchRanges(text, parsed.terms)) {
      if (start > at) out.push({ text: text.slice(at, start), hit: false });
      out.push({ text: text.slice(start, end), hit: true });
      at = end;
    }
    if (at < text.length) out.push({ text: text.slice(at), hit: false });
    return out;
  }

  // The part of a grounding passage around the first match, on one line.
  function passageSnippet(index: number): string {
    const text = (graph?.nodes[index]?.grounding?.excerpt ?? "").replace(/^#+\s*/, "").replace(/\s+/g, " ");
    const first = matchRanges(text, parsed.terms)[0];
    if (!first) return "";
    const start = Math.max(0, first[0] - 28);
    return (start ? "…" : "") + text.slice(start, first[1] + 70).trim() + (first[1] + 70 < text.length ? "…" : "");
  }

  async function goToHit(k: number) {
    const hit = hits[k];
    if (!hit) return;
    active = k;
    select(hit.index);
    await tick();
    document.getElementById(`graph-hit-${k}`)?.scrollIntoView({ block: "nearest" });
  }

  function searchKey(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!hits.length) return;
      e.preventDefault();
      const shown = Math.min(hits.length, MAX_RESULTS);
      const step = e.key === "ArrowDown" ? 1 : -1;
      // The first press goes to the first result; after that the keys step and wrap.
      goToHit(selected === hits[active]?.index ? (active + step + shown) % shown : active);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!hits.length) return;
      goToHit(active);
      canvas?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (query) query = "";
      else canvas?.focus();
    }
  }

  function addHint(hint: string) {
    query = query.trim() ? `${query.trim()} ${hint}` : hint;
    active = 0;
    searchInput?.focus();
  }

  function showAllHits() {
    renderer?.frameNodes(hits.map((h) => h.index));
  }

  // Highlights a hyperedge group through the search field, so there is one highlight, and brings it into view.
  function showGroup(label: string) {
    // A quote would end the filter value early; the longest piece without one still finds the group.
    const value = label.split('"').sort((a, b) => b.length - a.length)[0]!.trim();
    query = `group:"${value}"`;
    active = 0;
    select(-1);
    const ids = searcher?.search(query).map((h) => h.index) ?? [];
    if (!ids.length || !graph) return;
    // A group picked from the list must be drawn, so the types of its nodes come back if they were hidden.
    const types = new Set(ids.map((i) => graph!.nodes[i]!.type));
    if (hiddenTypes.some((t) => types.has(t))) {
      hiddenTypes = hiddenTypes.filter((t) => !types.has(t));
      renderer?.setHidden(graph.nodes.map((n) => hiddenTypes.includes(n.type)));
    }
    renderer?.frameNodes(ids);
  }

  // "/" moves to the search field from anywhere in the view, as it does in many apps.
  function viewKey(e: KeyboardEvent) {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || isEditableTarget(e.target) || !searchInput) return;
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }

  function mountRenderer() {
    renderer?.dispose();
    renderer = null;
    renderError = "";
    labels = [];
    hovered = -1;
    if (!canvas || !graph || !graph.nodes.length) return;
    try {
      renderer = new GraphRenderer(
        canvas,
        {
          nodes: graph.nodes.map((n) => ({ type: n.type, degree: n.degree, group: n.group, grounded: n.grounding !== null })),
          edges: graph.edges,
        },
        { theme: currentTheme(), onSelect: (i) => select(i, false), onHover: (i) => (hovered = i), onFrame: placeLabels },
      );
      rendererVersion = ++mounts;
    } catch (err) {
      renderError = errorText(err);
    }
  }

  async function load(id: string) {
    const token = ++loadToken;
    sourceId = id;
    selected = -1;
    error = "";
    renderError = "";
    loading = true;
    try {
      sessionStorage.setItem(STORE_KEY, id);
    } catch {
      // the choice is then not kept across reloads
    }
    try {
      const view = await api<GraphView>(`/api/sources/${encodeURIComponent(id)}/graph`);
      if (token !== loadToken) return;
      graph = view;
    } catch (err) {
      if (token !== loadToken) return;
      graph = null;
      error = errorText(err);
    } finally {
      if (token === loadToken) loading = false;
    }
  }

  // The canvas exists only once a graph with nodes is shown, so the renderer follows the graph.
  $effect(() => {
    if (canvas && graph) mountRenderer();
    return () => {
      renderer?.dispose();
      renderer = null;
    };
  });

  // What the renderer shows beyond the graph itself: matches, hidden types, auto-rotate.
  $effect(() => {
    void rendererVersion;
    renderer?.setHighlight(searching ? hits.map((h) => h.index) : null);
  });
  $effect(() => {
    void rendererVersion;
    if (graph) renderer?.setHidden(graph.nodes.map((n) => hiddenTypes.includes(n.type)));
  });
  $effect(() => {
    void rendererVersion;
    renderer?.setAutoRotate(autoRotate && !reduceMotion);
  });

  onMount(() => {
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const syncMotion = () => (reduceMotion = motion.matches);
    syncMotion();
    motion.addEventListener("change", syncMotion);

    (async () => {
      try {
        sources = await api<SourceInfo[]>("/api/sources");
      } catch (err) {
        error = errorText(err);
        sources = [];
        return;
      }
      let stored = "";
      try {
        stored = sessionStorage.getItem(STORE_KEY) ?? "";
      } catch {
        // storage blocked
      }
      const first = sources.find((s) => s.id === stored) ?? withGraph[0] ?? sources[0];
      if (first) await load(first.id);
    })();

    // Follow the theme switch and, on System, the OS setting; the renderer re-reads its colour tokens.
    const media = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => renderer?.setTheme(currentTheme());
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    media.addEventListener("change", sync);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", sync);
      motion.removeEventListener("change", syncMotion);
    };
  });
</script>

{#snippet shape(type: string)}
  <svg width="12" height="12" viewBox="0 0 12 12" class="shrink-0" aria-hidden="true">
    {#if type === "concept"}
      <circle cx="6" cy="6" r="5" class="fill-[var(--hig-node-concept)]" />
    {:else if type === "code"}
      <path d="M6 0.5 11.5 6 6 11.5 0.5 6z" class="fill-[var(--hig-node-code)]" />
    {:else}
      <rect x="1" y="1" width="10" height="10" rx="2" class="fill-[var(--hig-node-document)]" />
    {/if}
  </svg>
{/snippet}

<svelte:window onkeydown={viewKey} />

<div class="flex min-h-0 flex-1 flex-col">
  <Toolbar>
    <select
      class={popup({ class: "h-[30px] max-w-64 rounded-full pl-3.5 font-mono text-[12px]" })}
      aria-label="Source"
      value={sourceId}
      disabled={!sources?.length}
      onchange={(e) => load((e.currentTarget as HTMLSelectElement).value)}
    >
      {#each sources ?? [] as s (s.id)}
        <option value={s.id}>{s.id}{hasGraph(s) ? "" : " (no graph)"}</option>
      {/each}
    </select>
    {#if graph?.graphStatus === "ok" || graph?.graphStatus === "partial"}
      <StatusChip tone={graph.graphStatus === "ok" ? "ok" : "warn"} label={graph.graphStatus === "ok" ? "Complete" : "Partial"} />
      <span class={cn(footnote, "hidden truncate tabular-nums sm:inline")}>
        {graph.stats.nodes} nodes · {graph.stats.edges} links · {graph.stats.grounded} grounded
      </span>
    {/if}
    <span class="flex-1"></span>
    {#if drawn && graph}
      <!-- Search sits at the trailing side of the toolbar; results open under it and the inspector keeps the selection. -->
      <div class="relative w-[300px] max-w-full min-w-[120px] shrink">
        <div class={capsule({ class: "w-full gap-2 pr-1 pl-3 focus-within:ring-[3px] focus-within:ring-accent-soft" })} role="search">
          <SearchIcon size={15} strokeWidth={1.75} class="shrink-0 text-label2" aria-hidden="true" />
          <input
            bind:this={searchInput}
            class="h-full min-w-0 flex-1 bg-transparent text-[13px] text-label placeholder:text-label2 focus:outline-none"
            type="text"
            placeholder="Find nodes"
            aria-label="Find nodes"
            role="combobox"
            aria-expanded={listOpen}
            aria-controls="graph-search-results"
            aria-autocomplete="list"
            aria-activedescendant={listOpen && hits.length ? `graph-hit-${active}` : undefined}
            autocomplete="off"
            spellcheck="false"
            bind:value={query}
            oninput={() => (active = 0)}
            onfocus={() => (searchFocused = true)}
            onblur={() => (searchFocused = false)}
            onkeydown={searchKey}
          />
          {#if searching}
            <span class={cn(footnote, "shrink-0 whitespace-nowrap tabular-nums")} role="status">{hits.length ? plural(hits.length, "match", "matches") : "No matches"}</span>
          {/if}
          {#if query}
            <button type="button" class="grid size-[22px] shrink-0 place-items-center rounded-full text-label2 transition-colors hover:bg-fill hover:text-label" title="Clear search" aria-label="Clear search" onclick={() => { query = ""; searchInput?.focus(); }}>
              <X size={13} aria-hidden="true" />
            </button>
          {:else}
            <kbd class="mr-1.5 shrink-0 rounded border border-sep px-1 font-sans text-[11px] leading-4 text-label2" title="Press / to search">/</kbd>
          {/if}
        </div>
        {#if listOpen}
          <!-- mousedown is cancelled so a click here does not take focus from the field and close the list. -->
          <div
            class="absolute top-[36px] right-0 z-20 flex max-h-[min(440px,60vh)] w-[min(380px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-xl border border-sep/70 bg-surface shadow-float"
            role="presentation"
            onmousedown={(e) => e.preventDefault()}
          >
            {#if !searching}
              <div id="graph-search-results" class="px-3.5 py-3" role="listbox" aria-label="Search filters">
                <p class={footnote}>Type to search labels, pages, groups and grounding passages. Narrow the result with a filter:</p>
                <div class="mt-2 flex flex-wrap gap-1.5">
                  {#each HINTS as hint (hint)}
                    <button type="button" role="option" aria-selected="false" class="rounded-md bg-fill2 px-2 py-1 font-mono text-[12px] text-label transition-colors hover:bg-fill" onclick={() => addHint(hint)}>{hint}</button>
                  {/each}
                </div>
              </div>
            {:else if !hits.length}
              <div id="graph-search-results" role="listbox" aria-label="Matching nodes">
                <p class="px-3.5 py-3 text-[13px] text-label2">No node matches. Hidden node types are left out.</p>
              </div>
            {:else}
              <div id="graph-search-results" class="min-h-0 flex-1 overflow-y-auto py-1" role="listbox" aria-label="Matching nodes">
                {#each hits.slice(0, MAX_RESULTS) as hit, k (hit.index)}
                  {@const n = graph.nodes[hit.index]!}
                  <button
                    type="button"
                    id={`graph-hit-${k}`}
                    role="option"
                    aria-selected={k === active}
                    class={cn("flex w-full items-start gap-2 px-3.5 py-1.5 text-left transition-colors hover:bg-fill/60", k === active && "bg-accent-soft hover:bg-accent-soft")}
                    onclick={() => goToHit(k)}
                  >
                    <span class="mt-1">{@render shape(n.type)}</span>
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-[13px] text-label">
                        {#each pieces(n.label) as part, i (i)}{#if part.hit}<mark class="rounded-[3px] bg-transparent font-semibold text-accent-text">{part.text}</mark>{:else}{part.text}{/if}{/each}
                      </span>
                      {#if hit.field === "text"}
                        <span class="block truncate text-[11px] leading-[14px] text-label2">
                          {#each pieces(passageSnippet(hit.index)) as part, i (i)}{#if part.hit}<mark class="bg-transparent font-semibold text-label">{part.text}</mark>{:else}{part.text}{/if}{/each}
                        </span>
                      {:else if hit.field === "group" && n.group >= 0}
                        <span class="block truncate text-[11px] leading-[14px] text-label2">{graph.groups[n.group]?.label}</span>
                      {:else if hit.field === "id"}
                        <span class="block truncate font-mono text-[11px] leading-[14px] text-label2">{n.id}</span>
                      {:else if n.page}
                        <span class="block truncate font-mono text-[11px] leading-[14px] text-label2">{n.page}</span>
                      {/if}
                    </span>
                    {#if FIELD_NOTE[hit.field]}<span class="mt-0.5 shrink-0 text-[11px] text-label2">{FIELD_NOTE[hit.field]}</span>{/if}
                  </button>
                {/each}
              </div>
              <div class="flex shrink-0 items-center gap-3 border-t border-sep/60 px-3.5 py-2">
                <button type="button" class={button({ intent: "link", size: "xs" })} onclick={showAllHits}>Show All in View</button>
                <span class={cn(footnote, "ml-auto")}>
                  {hits.length > MAX_RESULTS ? `First ${MAX_RESULTS} of ${hits.length}` : "↑ ↓ to step, Return to go"}
                </span>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </Toolbar>

  <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-4 pb-4 pl-5 lg:flex-row lg:overflow-hidden">
    <div bind:this={stage} class={panel({ class: "relative min-h-[420px] min-w-0 flex-1 overflow-hidden" })}>
      {#if graph && drawn}
        <!-- A new canvas per graph: dispose() loses the old WebGL context, and a lost context cannot be reused. -->
        {#key `${graph.source}:${graph.generation}`}
          <canvas
            bind:this={canvas}
            tabindex="0"
            class="block size-full touch-none rounded-[10px] focus:outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
            aria-label={`Semantic graph of ${graph.source}, ${graph.stats.nodes} nodes. Arrow keys orbit, W A S D fly, plus and minus zoom.`}
          ></canvas>
        {/key}
        <div class="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
          {#each labels as l (l.index)}
            <span
              class={cn(
                "absolute truncate rounded-md px-1.5 py-0.5",
                l.main ? "bg-label text-[12px] font-semibold text-surface shadow-float" : "bg-glass text-[11px] text-label backdrop-blur-xl",
              )}
              style:left={`${l.x}px`}
              style:top={`${l.y}px`}
              style:max-width={`${l.main ? LABEL_MAX_MAIN : LABEL_MAX}px`}>{graph.nodes[l.index]?.label}</span
            >
          {/each}
        </div>

        <!-- Legend: glass is allowed here because it floats over the graph. -->
        <div class="absolute top-3 left-3 hidden rounded-xl border border-white/40 bg-glass px-1.5 py-2.5 shadow-float backdrop-blur-xl backdrop-saturate-150 sm:block dark:border-white/10">
          <div class={cn(footnote, "mx-1.5 mb-1 font-semibold")}>Node type</div>
          {#each typeCounts as [type, count] (type)}
            {@const off = hiddenTypes.includes(type)}
            <!-- Each row shows or hides its type. The state is in the wording and the strike, not only the fade. -->
            <button
              type="button"
              class="flex h-6 w-full items-center gap-2 rounded-md px-1.5 text-left text-[13px] text-label transition-colors hover:bg-fill/60 disabled:pointer-events-none"
              aria-pressed={!off}
              title={off ? `Show ${type} nodes` : `Hide ${type} nodes`}
              disabled={!count}
              onclick={() => toggleType(type)}
            >
              <span class={cn(off && "opacity-35")}>{@render shape(type)}</span>
              <span class={cn(off && "text-label2 line-through")}>{capitalize(type)}</span>
              <span class={cn(footnote, "ml-auto pl-4 font-mono tabular-nums")}>{off ? "hidden" : count}</span>
            </button>
          {/each}
          <p class={cn(footnote, "mx-1.5 mt-1.5 max-w-[190px]")}>Faded nodes have no grounding passage: no passage matched their label.</p>
        </div>

        <!-- View controls float over the graph, so they are glass like the legend. -->
        <div class={capsule({ class: "absolute right-3 bottom-3" })} role="toolbar" aria-label="View">
          <button type="button" class={capsuleButton({ class: "w-[30px] px-0" })} title="Zoom out (-)" aria-label="Zoom out" onclick={() => renderer?.zoomBy(1 / 0.7)}><Minus size={15} aria-hidden="true" /></button>
          <button type="button" class={capsuleButton({ class: "w-[30px] px-0" })} title="Zoom in (+)" aria-label="Zoom in" onclick={() => renderer?.zoomBy(0.7)}><Plus size={15} aria-hidden="true" /></button>
          <button type="button" class={capsuleButton({ class: "w-[30px] px-0" })} title="Fit graph in view (F)" aria-label="Fit graph in view" onclick={() => renderer?.frameNodes()}><Maximize size={14} aria-hidden="true" /></button>
          <button type="button" class={capsuleButton({ class: "w-[30px] px-0" })} title="Reset view (0)" aria-label="Reset view" onclick={() => renderer?.resetCamera()}><RotateCcw size={14} aria-hidden="true" /></button>
          {#if !reduceMotion}
            <button
              type="button"
              class={capsuleButton({ class: cn("w-[30px] px-0", autoRotate && "bg-accent-soft text-accent-text hover:bg-accent-soft") })}
              title={autoRotate ? "Stop rotating" : "Rotate slowly"}
              aria-label="Rotate slowly"
              aria-pressed={autoRotate}
              onclick={() => (autoRotate = !autoRotate)}><Rotate3d size={15} aria-hidden="true" /></button
            >
          {/if}
        </div>
      {:else}
        <div class="grid size-full place-items-center p-6">
          <div class="w-full max-w-md">
            {#if error}
              <div class={notice({ tone: "bad" })} role="alert"><StatusIcon tone="bad" class="mt-0.5" /><p class="min-w-0 break-words">{error}</p></div>
            {:else if renderError}
              <div class={notice({ tone: "bad" })} role="alert">
                <StatusIcon tone="bad" class="mt-0.5" />
                <div class="min-w-0"><p class="font-semibold">The graph cannot be drawn here.</p><p class="mt-1 break-words">{renderError}</p></div>
              </div>
            {:else if sources === null || loading}
              <p class="text-center text-[13px] text-label2" role="status">Loading graph…</p>
            {:else if !sources.length}
              <div class={notice({ tone: "info", class: "bg-fill2" })}><StatusIcon tone="info" class="mt-0.5" /><p>No sources yet. Add one and prepare it with a graph.</p></div>
            {:else if !graph?.generation}
              <div class={notice({ tone: "info", class: "bg-fill2" })}>
                <StatusIcon tone="info" class="mt-0.5" />
                <p class="min-w-0"><span class="font-mono text-label">{sourceId}</span> is not prepared yet. Prepare it to build its graph.</p>
              </div>
            {:else}
              <div class={notice({ tone: "info", class: "bg-fill2" })}>
                <StatusIcon tone="info" class="mt-0.5" />
                <p class="min-w-0"><span class="font-mono text-label">{sourceId}</span> was prepared without a graph. Prepare it again with a graph to see one here.</p>
              </div>
            {/if}
          </div>
        </div>
      {/if}
    </div>

    <aside class="w-full shrink-0 lg:w-[320px] lg:overflow-y-auto" aria-label="Graph inspector">
      <Group title="Selected node" class="[&>h3]:mt-1">
        {#if graph && node}
          <div class="flex items-start gap-2 px-3.5 py-2.5">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                {@render shape(node.type)}
                <h2 class="min-w-0 text-[15px] leading-5 font-semibold break-words text-label">{node.label}</h2>
              </div>
              <p class={cn(footnote, "mt-0.5")}>{capitalize(node.type)}</p>
              {#if node.page}<p class={cn(footnote, "mt-0.5 font-mono break-all")}>{node.page}</p>{/if}
              {#if node.url}<p class={cn(footnote, "mt-0.5 truncate")} title={node.url}>{node.url}</p>{/if}
            </div>
            <button type="button" class={button({ intent: "ghost", size: "sm", class: "-mr-1.5 size-7 px-0 text-label2" })} title="Clear selection" aria-label="Clear selection" onclick={() => select(-1)}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <Row label="Grounding passage" sub={node.grounding ? plural(node.grounding.passages, "passage", "passages") : undefined}>
            {#if node.grounding}
              <span class="min-w-0 truncate font-mono text-[12px] text-label2" title={node.grounding.passage}>{node.grounding.passage}</span>
            {:else}
              <span class="text-label2">None</span>
            {/if}
          </Row>
          <Row label="Links"><span class="font-mono text-label2 tabular-nums">{node.degree}</span></Row>
          <Row label="Group"><span class="min-w-0 truncate text-right text-label2">{node.group >= 0 ? graph.groups[node.group]?.label : "None"}</span></Row>
          <Row label="Node id"><span class="min-w-0 truncate font-mono text-[12px] text-label2" title={node.id}>{node.id}</span></Row>
        {:else}
          <Row>
            <p class="text-[13px] text-label2">
              {graph?.nodes.length ? "Click a node to see the page it came from, the passage that grounds it, and what it links to." : "No node selected."}
            </p>
          </Row>
        {/if}
      </Group>

      {#if graph && node}
        <Group title="Grounding">
          {#if node.grounding}
            <div class="flex flex-col gap-2 px-3.5 py-3">
              <p class={footnote}>
                {#each node.grounding.headingPath as h, i (i)}{#if i}<span class="mx-1">›</span>{/if}{h}{/each}
                {#if node.grounding.headingPath.length}<span class="mx-1">·</span>{/if}<span class="tabular-nums">lines {node.grounding.lines[0]}-{node.grounding.lines[1]}</span>
              </p>
              <!-- Excerpt text is untrusted documentation; Svelte renders it as text. -->
              <blockquote class="rounded-md bg-code px-3 py-2 font-mono text-[12px] leading-[18px] break-words whitespace-pre-wrap text-label">
                {node.grounding.excerpt.replace(/^#+\s*/, "")}
              </blockquote>
            </div>
          {:else}
            <Row>
              <p class="text-[13px] text-label2">No passage matched this label. Graph search can still reach it through its neighbours, but it adds no citation of its own.</p>
            </Row>
          {/if}
        </Group>

        <Group title={`Connections · ${plural(links.length, "link", "links")}`}>
          {#if !links.length}
            <Row><p class="text-[13px] text-label2">This node has no links.</p></Row>
          {/if}
          {#each showAllLinks ? links : links.slice(0, MAX_LINKS) as l (l.other)}
            <button type="button" class="block w-full text-left transition-colors hover:bg-fill/60 [&+&]:border-t [&+&]:border-sep/60" onclick={() => select(l.other)}>
              <span class="flex min-h-9 items-center gap-2 px-3.5 py-1.5 text-[13px]">
                <span class="w-3 shrink-0 text-label2" aria-label={l.outgoing ? "Outgoing" : "Incoming"}>{l.outgoing ? "→" : "←"}</span>
                {@render shape(graph.nodes[l.other]?.type ?? "document")}
                <span class="min-w-0 flex-1 truncate text-label">{graph.nodes[l.other]?.label}</span>
                <span class="shrink-0 text-[11px] text-label2">{l.relation}</span>
              </span>
            </button>
          {/each}
          {#if links.length > MAX_LINKS && !showAllLinks}
            <div class="border-t border-sep/60 px-3.5 py-2">
              <button type="button" class={button({ intent: "link", size: "xs" })} onclick={() => (showAllLinks = true)}>Show {links.length - MAX_LINKS} More</button>
            </div>
          {/if}
        </Group>
      {/if}

      {#if graph?.groups.length}
        <Group title="Largest groups">
          {#each graph.groups.slice(0, 6) as g (g.label)}
            <button type="button" class="block w-full text-left transition-colors hover:bg-fill/60 [&+&]:border-t [&+&]:border-sep/60" title="Highlight this group" onclick={() => showGroup(g.label)}>
              <span class="flex min-h-9 items-center gap-3 px-3.5 py-1.5 text-[13px]">
                <span class="min-w-0 flex-1 truncate text-label">{g.label}</span>
                <span class="shrink-0 font-mono text-label2 tabular-nums">{g.size}</span>
              </span>
            </button>
          {/each}
        </Group>
      {/if}

      {#if missing.length}
        <Group title="Not in the graph">
          <Row>
            <div class="min-w-0 flex-1">
              <StatusChip tone="warn" label={`${missing.length} ${missing.length === 1 ? "page has" : "pages have"} no nodes`} />
              <p class={cn(footnote, "mt-0.5")}>Graphify left them out. The next prepare retries them from the Graphify cache.</p>
            </div>
          </Row>
          {#each missing.slice(0, MAX_MISSING) as p (p)}
            <Row><span class="min-w-0 truncate font-mono text-[12px] text-label" title={p}>{p}</span></Row>
          {/each}
          {#if missing.length > MAX_MISSING}
            <Row><span class="text-[13px] text-label2">and {missing.length - MAX_MISSING} more</span></Row>
          {/if}
        </Group>
      {/if}

      {#if graph?.generation}
        <Group title="Generation">
          <Row label="Number"><span class="font-mono text-label2 tabular-nums">{graph.generation}</span></Row>
          {#if graph.stats.model}<Row label="Model"><span class="min-w-0 truncate font-mono text-[12px] text-label2" title={graph.stats.model}>{graph.stats.model}</span></Row>{/if}
          {#if graph.stats.graphMs !== null}<Row label="Build time"><span class="text-label2 tabular-nums">{duration(graph.stats.graphMs)}</span></Row>{/if}
          {#if graph.stats.costEstimate}<Row label="Cost"><span class="font-mono text-label2">{graph.stats.costEstimate}</span></Row>{/if}
        </Group>
      {/if}

      {#if drawn}
        <Group title="Moving around" hint="Keys work while the graph has focus: click it or tab to it.">
          <Row label="Orbit"><span class="text-right text-label2">Drag, arrow keys</span></Row>
          <Row label="Pan"><span class="text-right text-label2">Shift-drag, right-drag, Shift-scroll</span></Row>
          <Row label="Zoom"><span class="text-right text-label2">Scroll, pinch, + and -</span></Row>
          <Row label="Fly"><span class="text-right text-label2">W A S D, Q and E for down and up</span></Row>
          <Row label="Go to a node"><span class="text-right text-label2">Double-click it</span></Row>
          <Row label="Fit, reset, search"><span class="text-right text-label2">F, 0, /</span></Row>
        </Group>
      {/if}
    </aside>
  </div>
</div>

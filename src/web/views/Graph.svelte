<script lang="ts">
  import { onMount } from "svelte";
  import StatusChip from "../components/StatusChip.svelte";
  import { api, errorText, type GraphView, type SourceInfo } from "../lib/api.ts";
  import { GraphRenderer, type Theme } from "../lib/graph-renderer.ts";
  import { chip, cn, type ChipTone } from "../lib/ui.ts";

  const STORE_KEY = "docify-graph-source";
  const TYPE_DOT: Record<string, string> = { document: "bg-indigo-500", concept: "bg-sky-500", code: "bg-fuchsia-500" };
  const TYPE_TEXT: Record<string, string> = {
    document: "text-indigo-700 dark:text-indigo-300",
    concept: "text-sky-700 dark:text-sky-300",
    code: "text-fuchsia-700 dark:text-fuchsia-300",
  };
  const MAX_LABELS = 10;
  const MAX_LINKS = 8;

  let sources = $state<SourceInfo[] | null>(null);
  let sourceId = $state("");
  let graph = $state<GraphView | null>(null);
  let loading = $state(false);
  let error = $state("");
  let renderError = $state("");
  let selected = $state(-1);
  let showAllLinks = $state(false);
  let labels = $state<{ index: number; x: number; y: number; w: number; main: boolean }[]>([]);

  let canvas = $state<HTMLCanvasElement>();
  let stage = $state<HTMLDivElement>();
  let renderer: GraphRenderer | null = null;
  let loadToken = 0;

  const withGraph = $derived((sources ?? []).filter((s) => s.activeGeneration?.graphStatus === "ok" || s.activeGeneration?.graphStatus === "partial"));
  const node = $derived(graph && selected >= 0 ? graph.nodes[selected] : null);
  const links = $derived.by(() => {
    if (!graph || selected < 0) return [];
    const out: { other: number; relation: string; outgoing: boolean }[] = [];
    for (const e of graph.edges) {
      if (e.source === selected) out.push({ other: e.target, relation: e.relation, outgoing: true });
      else if (e.target === selected) out.push({ other: e.source, relation: e.relation, outgoing: false });
    }
    return out.sort((a, b) => graph!.nodes[b.other]!.degree - graph!.nodes[a.other]!.degree);
  });
  const typeCounts = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const n of graph?.nodes ?? []) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]);
  });
  const statusTone = (status: string | null): ChipTone => (status === "ok" ? "ok" : status === "partial" ? "warn" : "neutral");

  function currentTheme(): Theme {
    const root = document.documentElement;
    if (root.classList.contains("dark")) return "dark";
    if (root.classList.contains("light")) return "light";
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function duration(ms: number | null) {
    if (ms === null) return null;
    const s = Math.round(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)} m ${s % 60} s` : `${s} s`;
  }

  // Labels for the selection and its best-connected neighbours, skipping any that would overlap.
  function placeLabels(screen: Float32Array) {
    if (!graph || selected < 0 || !stage) {
      if (labels.length) labels = [];
      return;
    }
    const width = stage.clientWidth;
    const ids = [selected, ...links.slice(0, MAX_LABELS).map((l) => l.other)];
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const next: typeof labels = [];
    ids.forEach((index, k) => {
      if (!screen[index * 4 + 3]) return;
      const main = k === 0;
      const text = graph!.nodes[index]!.label;
      const w = Math.min(main ? 240 : 176, text.length * (main ? 6.9 : 6.1) + 14);
      const h = main ? 22 : 19;
      const x = Math.max(4, Math.min(width - w - 4, screen[index * 4]! - w / 2));
      const y = screen[index * 4 + 1]! + (main ? 12 : 8);
      if (placed.some((r) => x < r.x + r.w + 4 && x + w + 4 > r.x && y < r.y + r.h + 2 && y + h + 2 > r.y)) return;
      placed.push({ x, y, w, h });
      next.push({ index, x, y, w, main });
    });
    labels = next;
  }

  function select(index: number, center = true) {
    selected = index;
    showAllLinks = false;
    renderer?.select(index, { center });
  }

  function mountRenderer() {
    renderer?.dispose();
    renderer = null;
    renderError = "";
    labels = [];
    if (!canvas || !graph || !graph.nodes.length) return;
    try {
      renderer = new GraphRenderer(
        canvas,
        {
          nodes: graph.nodes.map((n) => ({ type: n.type, degree: n.degree, group: n.group, grounded: n.grounding !== null })),
          edges: graph.edges,
        },
        { theme: currentTheme(), onSelect: (i) => select(i, false), onFrame: placeLabels },
      );
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

  onMount(() => {
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

    // Follow the theme switch and, on System, the OS setting.
    const media = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => renderer?.setTheme(currentTheme());
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    media.addEventListener("change", sync);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", sync);
    };
  });
</script>

<main class="flex min-h-0 flex-1 flex-col lg:flex-row">
  <div bind:this={stage} class="relative min-h-[420px] flex-1 overflow-hidden bg-zinc-50 dark:bg-zinc-950">
    {#if graph && graph.nodes.length && !renderError}
      <!-- A new canvas per graph: dispose() loses the old WebGL context, and a lost context cannot be reused. -->
      {#key `${graph.source}:${graph.generation}`}
        <canvas bind:this={canvas} class="block size-full touch-none" aria-label={`Semantic graph of ${graph.source}, ${graph.stats.nodes} nodes`}></canvas>
      {/key}
      <div class="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        {#each labels as l (l.index)}
          <span
            class={cn(
              "absolute truncate rounded px-1.5 py-0.5",
              l.main ? "bg-zinc-900 text-[12px] font-semibold text-white shadow-sm dark:bg-white dark:text-zinc-900" : "bg-white/85 text-[11px] text-zinc-700 dark:bg-zinc-900/85 dark:text-zinc-300",
            )}
            style:left={`${l.x}px`}
            style:top={`${l.y}px`}
            style:max-width={`${l.w}px`}>{graph.nodes[l.index]?.label}</span
          >
        {/each}
      </div>
    {:else}
      <div class="grid size-full place-items-center p-6">
        <div class="max-w-md text-center text-[13px] text-zinc-500 dark:text-zinc-400">
          {#if error}
            <p class="break-words text-rose-600 dark:text-rose-400" role="alert">{error}</p>
          {:else if renderError}
            <p class="font-medium text-zinc-700 dark:text-zinc-200">The graph cannot be drawn here.</p>
            <p class="mt-1 break-words">{renderError}</p>
          {:else if sources === null || loading}
            <p>Loading graph...</p>
          {:else if !sources.length}
            <p>No sources yet. Add one in the Workspace and prepare it with a graph.</p>
          {:else if !graph?.generation}
            <p><span class="font-mono">{sourceId}</span> is not prepared yet. Prepare it in the Workspace to build its graph.</p>
          {:else}
            <p><span class="font-mono">{sourceId}</span> was prepared without a graph. Prepare it again with a graph to see one here.</p>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Source picker and counts. -->
    <div class="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start justify-between gap-3 p-4">
      <div class="pointer-events-auto flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200/80 bg-white/90 p-1.5 pr-3 text-[13px] shadow-sm backdrop-blur dark:border-zinc-700/80 dark:bg-zinc-900/85 dark:shadow-none">
        <select
          class="h-8 max-w-56 rounded-md border border-zinc-200 bg-white px-2 font-mono text-[12px] font-medium text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          aria-label="Source"
          value={sourceId}
          disabled={!sources?.length}
          onchange={(e) => load((e.currentTarget as HTMLSelectElement).value)}
        >
          {#each sources ?? [] as s (s.id)}
            <option value={s.id}>{s.id}{s.activeGeneration?.graphStatus === "ok" || s.activeGeneration?.graphStatus === "partial" ? "" : " (no graph)"}</option>
          {/each}
        </select>
        {#if graph?.graphStatus === "ok" || graph?.graphStatus === "partial"}
          <StatusChip tone={statusTone(graph.graphStatus)} label={graph.graphStatus} />
          <span class="text-[12px] text-zinc-500 tabular-nums dark:text-zinc-400">
            <span class="font-medium text-zinc-700 dark:text-zinc-200">{graph.stats.nodes}</span> nodes ·
            <span class="font-medium text-zinc-700 dark:text-zinc-200">{graph.stats.edges}</span> links ·
            <span class="font-medium text-zinc-700 dark:text-zinc-200">{graph.stats.grounded}</span> grounded
          </span>
        {/if}
      </div>

      {#if graph?.nodes.length}
        <div class="pointer-events-auto hidden w-52 shrink-0 flex-col gap-2 rounded-lg border border-zinc-200/80 bg-white/90 p-3 text-[12px] shadow-sm backdrop-blur sm:flex dark:border-zinc-700/80 dark:bg-zinc-900/85 dark:shadow-none">
          <div class="flex items-center justify-between font-medium text-zinc-600 dark:text-zinc-300">Node type <span class="text-zinc-400 tabular-nums dark:text-zinc-500">{graph.stats.nodes}</span></div>
          <ul class="flex flex-col gap-1.5 text-zinc-600 dark:text-zinc-400">
            {#each typeCounts as [type, count] (type)}
              <li class="flex items-center gap-2">
                <span class={cn("size-2.5 rounded-full", TYPE_DOT[type] ?? "bg-zinc-400")}></span>{type}<span class="ml-auto tabular-nums">{count}</span>
              </li>
            {/each}
          </ul>
          <p class="border-t border-zinc-200 pt-2 text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">Faded nodes have no grounding passage: no passage matched their label.</p>
        </div>
      {/if}
    </div>

    {#if graph?.nodes.length && !renderError}
      <div class="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-3 p-4">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-white/80 px-2.5 py-1.5 font-mono text-[11px] text-zinc-500 backdrop-blur dark:bg-zinc-950/70 dark:text-zinc-400">
          <span>gen {graph.generation}</span>
          {#if graph.stats.model}<span>{graph.stats.model}</span>{/if}
          {#if graph.stats.graphMs !== null}<span>{duration(graph.stats.graphMs)}</span>{/if}
          {#if graph.stats.costEstimate}<span>{graph.stats.costEstimate}</span>{/if}
          {#if graph.stats.missingDocuments.length}<span class="text-amber-700 dark:text-amber-400">{graph.stats.missingDocuments.length} {graph.stats.missingDocuments.length === 1 ? "page" : "pages"} without nodes</span>{/if}
        </div>
        <div class="flex items-center gap-3 rounded-md bg-white/80 px-2.5 py-1.5 text-[11px] text-zinc-500 backdrop-blur dark:bg-zinc-950/70 dark:text-zinc-400">
          <span>drag to orbit</span><span>scroll to zoom</span><span>click to inspect</span>
          <button type="button" class="pointer-events-auto font-medium text-indigo-600 hover:underline dark:text-indigo-400" onclick={() => renderer?.resetCamera()}>Reset view</button>
        </div>
      </div>
    {/if}
  </div>

  <aside class="flex w-full shrink-0 flex-col gap-4 overflow-y-auto border-t border-zinc-200 bg-white p-4 lg:w-[360px] lg:border-t-0 lg:border-l dark:border-zinc-800 dark:bg-zinc-900" aria-label="Selected node">
    {#if graph && node}
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="mb-1 flex items-center gap-1.5 text-[12px]">
            <span class={cn("size-2 rounded-full", TYPE_DOT[node.type] ?? "bg-zinc-400")}></span>
            <span class={cn("font-medium", TYPE_TEXT[node.type] ?? "text-zinc-600 dark:text-zinc-300")}>{node.type}</span>
          </div>
          <h2 class="text-[15px] leading-snug font-semibold break-words">{node.label}</h2>
        </div>
        <button
          type="button"
          class="grid size-7 shrink-0 place-items-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          title="Clear selection"
          aria-label="Clear selection"
          onclick={() => select(-1)}
        >
          <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>

      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
        <dt class="text-zinc-500 dark:text-zinc-400">links</dt>
        <dd class="tabular-nums">{node.degree}</dd>
        <dt class="text-zinc-500 dark:text-zinc-400">grounded</dt>
        <dd class="tabular-nums">{node.grounding ? `${node.grounding.passages} ${node.grounding.passages === 1 ? "passage" : "passages"}` : "none"}</dd>
        <dt class="text-zinc-500 dark:text-zinc-400">group</dt>
        <dd class="truncate">{node.group >= 0 ? graph.groups[node.group]?.label : "none"}</dd>
        <dt class="text-zinc-500 dark:text-zinc-400">node id</dt>
        <dd class="truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400" title={node.id}>{node.id}</dd>
      </dl>

      {#if node.page}
        <div class="rounded-md border border-zinc-200/70 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950">
          <div class="text-[11px] font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">Source page</div>
          <p class="mt-1 font-mono text-[12px] break-all text-zinc-700 dark:text-zinc-200">{node.page}</p>
          {#if node.url}<p class="mt-1 truncate text-[11px] text-zinc-500 dark:text-zinc-400" title={node.url}>{node.url}</p>{/if}
        </div>
      {/if}

      <section class="flex flex-col gap-2">
        <div class="flex items-baseline justify-between">
          <h3 class="text-[12px] font-semibold">Grounding</h3>
          {#if node.grounding}<span class="text-[11px] text-zinc-500 tabular-nums dark:text-zinc-400">lines {node.grounding.lines[0]}-{node.grounding.lines[1]}</span>{/if}
        </div>
        {#if node.grounding}
          {#if node.grounding.headingPath.length}
            <p class="text-[11px] text-zinc-500 dark:text-zinc-400">
              {#each node.grounding.headingPath as h, i (i)}{#if i}<span class="mx-1 text-zinc-300 dark:text-zinc-600">&gt;</span>{/if}{h}{/each}
            </p>
          {/if}
          <!-- Excerpt text is untrusted documentation; Svelte renders it as text. -->
          <blockquote class="rounded-md border-l-2 border-indigo-300 bg-indigo-50/50 py-2 pr-2 pl-3 text-[12px] leading-relaxed break-words text-zinc-700 dark:border-indigo-500/50 dark:bg-indigo-500/5 dark:text-zinc-300">
            {node.grounding.excerpt.replace(/^#+\s*/, "")}
          </blockquote>
          <p class="truncate font-mono text-[11px] text-zinc-400 dark:text-zinc-500">{node.grounding.passage}</p>
        {:else}
          <p class="rounded-md border border-dashed border-zinc-300 p-3 text-[12px] text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
            No passage matched this label. Graph search can still reach it through its neighbours, but it adds no citation of its own.
          </p>
        {/if}
      </section>

      <section class="flex flex-col gap-1.5">
        <div class="flex items-baseline justify-between">
          <h3 class="text-[12px] font-semibold">Connections</h3>
          <span class="text-[11px] text-zinc-500 tabular-nums dark:text-zinc-400">{links.length} {links.length === 1 ? "link" : "links"}</span>
        </div>
        {#if !links.length}
          <p class="text-[12px] text-zinc-500 dark:text-zinc-400">This node has no links.</p>
        {/if}
        {#each showAllLinks ? links : links.slice(0, MAX_LINKS) as l (l.other)}
          <button type="button" class="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left text-[12px] hover:bg-zinc-100 dark:hover:bg-zinc-800" onclick={() => select(l.other)}>
            <span class="w-3 shrink-0 font-mono text-zinc-400 dark:text-zinc-500">{l.outgoing ? "→" : "←"}</span>
            <span class="min-w-0 flex-1 truncate text-zinc-700 dark:text-zinc-200">{graph.nodes[l.other]?.label}</span>
            <span class="shrink-0 text-[11px] text-zinc-400 dark:text-zinc-500">{l.relation}</span>
          </button>
        {/each}
        {#if links.length > MAX_LINKS && !showAllLinks}
          <button type="button" class="self-start pl-5 text-[11px] font-medium text-indigo-600 hover:underline dark:text-indigo-400" onclick={() => (showAllLinks = true)}>Show {links.length - MAX_LINKS} more</button>
        {/if}
      </section>
    {:else}
      <div class="flex items-center justify-between">
        <h2 class="text-[14px] font-semibold">Inspector</h2>
        {#if graph?.nodes.length}<span class="text-[12px] text-zinc-500 dark:text-zinc-400">{graph.nodes.length} nodes</span>{/if}
      </div>
      <p class="text-[13px] text-zinc-500 dark:text-zinc-400">Click a node to see the page it came from, the passage that grounds it, and what it links to.</p>
      {#if graph?.groups.length}
        <section class="flex flex-col gap-2">
          <h3 class="text-[12px] font-semibold">Largest groups</h3>
          {#each graph.groups.slice(0, 6) as g (g.label)}
            <div class="flex items-baseline justify-between gap-2 text-[13px]">
              <span class="truncate text-zinc-700 dark:text-zinc-200">{g.label}</span>
              <span class="shrink-0 text-[12px] text-zinc-500 tabular-nums dark:text-zinc-400">{g.size}</span>
            </div>
          {/each}
        </section>
      {/if}
      {#if graph?.stats.missingDocuments.length}
        <section class={chip({ tone: "warn" }).base({ class: "flex-col items-start gap-1 rounded-md px-3 py-2 whitespace-normal" })}>
          <span class="font-semibold">{graph.stats.missingDocuments.length} {graph.stats.missingDocuments.length === 1 ? "page has" : "pages have"} no nodes</span>
          <span class="font-normal">Graphify left them out. The next prepare retries them.</span>
          <ul class="mt-1 flex w-full flex-col gap-0.5 font-mono text-[11px] font-normal">
            {#each graph.stats.missingDocuments.slice(0, 8) as p (p)}<li class="truncate" title={p}>{p}</li>{/each}
            {#if graph.stats.missingDocuments.length > 8}<li>and {graph.stats.missingDocuments.length - 8} more</li>{/if}
          </ul>
        </section>
      {/if}
    {/if}
  </aside>
</main>

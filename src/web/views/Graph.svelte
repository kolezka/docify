<script lang="ts">
  import { onMount } from "svelte";
  import { X } from "@lucide/svelte";
  import Group from "../components/Group.svelte";
  import Row from "../components/Row.svelte";
  import StatusChip from "../components/StatusChip.svelte";
  import StatusIcon from "../components/StatusIcon.svelte";
  import Toolbar from "../components/Toolbar.svelte";
  import { api, errorText, type GraphView, type SourceInfo } from "../lib/api.ts";
  import { GraphRenderer, type Theme } from "../lib/graph-renderer.ts";
  import { button, capsule, capsuleButton, cn, footnote, notice, panel, popup } from "../lib/ui.ts";

  const STORE_KEY = "docify-graph-source";
  // Legend order; each type also has its own shape in the renderer.
  const NODE_TYPES = ["concept", "document", "code"];
  const MAX_LABELS = 10;
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

    // Follow the theme switch and, on System, the OS setting; the renderer re-reads its colour tokens.
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
    {#if drawn}
      <span class={capsule()}>
        <button type="button" class={capsuleButton()} onclick={() => renderer?.resetCamera()}>Reset View</button>
      </span>
    {/if}
  </Toolbar>

  <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-4 pb-4 pl-5 lg:flex-row lg:overflow-hidden">
    <div bind:this={stage} class={panel({ class: "relative min-h-[420px] min-w-0 flex-1 overflow-hidden" })}>
      {#if graph && drawn}
        <!-- A new canvas per graph: dispose() loses the old WebGL context, and a lost context cannot be reused. -->
        {#key `${graph.source}:${graph.generation}`}
          <canvas bind:this={canvas} class="block size-full touch-none" aria-label={`Semantic graph of ${graph.source}, ${graph.stats.nodes} nodes`}></canvas>
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
              style:max-width={`${l.w}px`}>{graph.nodes[l.index]?.label}</span
            >
          {/each}
        </div>

        <!-- Legend: glass is allowed here because it floats over the graph. -->
        <div class="pointer-events-none absolute top-3 left-3 hidden rounded-xl border border-white/40 bg-glass px-3 py-2.5 shadow-float backdrop-blur-xl backdrop-saturate-150 sm:block dark:border-white/10">
          <div class={cn(footnote, "mb-1.5 font-semibold")}>Node type</div>
          {#each typeCounts as [type, count] (type)}
            <div class="flex h-5 items-center gap-2 text-[13px] text-label">
              {@render shape(type)}<span>{capitalize(type)}</span><span class={cn(footnote, "ml-auto pl-4 font-mono tabular-nums")}>{count}</span>
            </div>
          {/each}
          <p class={cn(footnote, "mt-1.5 max-w-[190px]")}>Faded nodes have no grounding passage: no passage matched their label.</p>
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
            <Row label={g.label}><span class="font-mono text-label2 tabular-nums">{g.size}</span></Row>
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
        <p class={cn(footnote, "mx-3.5 mt-3")}>Drag to orbit, scroll to zoom, click a node to inspect it.</p>
      {/if}
    </aside>
  </div>
</div>

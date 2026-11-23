<script lang="ts">
  import { tick, untrack } from "svelte";
  import { ChevronDown, ChevronRight, Circle, CircleCheck, CircleDot, ExternalLink, Link, X } from "@lucide/svelte";
  import ConfirmDialog from "../components/ConfirmDialog.svelte";
  import Group from "../components/Group.svelte";
  import Row from "../components/Row.svelte";
  import StatusChip from "../components/StatusChip.svelte";
  import StatusIcon from "../components/StatusIcon.svelte";
  import SourceTree from "../components/SourceTree.svelte";
  import Toolbar from "../components/Toolbar.svelte";
  import { api, ApiError, downloadArtifact, errorText, type SourceInfo } from "../lib/api.ts";
  import { ago, fraction, graphCoverage } from "../lib/format.ts";
  import { nav } from "../lib/nav.svelte.ts";
  import { session } from "../lib/session.svelte.ts";
  import { sources } from "../lib/sources.svelte.ts";
  import { button, capsule, capsuleButton, cn, footnote, input, isPatternField, notice, patternError, patternLines, popup, sourceStateLabel, sourceTone, textArea, type PatternField } from "../lib/ui.ts";

  type Crawl4aiSettings = NonNullable<SourceInfo["crawl4ai"]>;

  const PHASES = ["collect", "normalize", "embed", "graph", "validate", "activate"] as const;
  const PHASE_LABELS: Record<string, string> = { collect: "Collect", normalize: "Normalize", embed: "Embed", graph: "Graph", validate: "Validate", activate: "Activate" };
  const CRAWLER_LABELS: Record<string, string> = { builtin: "Built-in", crawl4ai: "Crawl4AI", browserless: "Browserless" };
  const MISSING_PREVIEW = 20;

  const s = $derived(sources.byId(nav.sourceId));

  let actionBusy = $state(false);
  // Summaries outlive a source switch, so they are tracked per source, not per page.
  let summarizingIds = $state<string[]>([]);
  const summarizing = $derived(!!nav.sourceId && summarizingIds.includes(nav.sourceId));
  const busy = $derived(actionBusy || summarizing);
  let error = $state("");
  let menuOpen = $state(false);
  let confirmRemove = $state(false);
  let showAllMissing = $state(false);
  let editingCrawl4ai = $state(false);
  let stream = $state("");
  let waitUntil = $state("");
  let waitFor = $state("");
  let delay = $state("");
  let scanFullPage = $state("");
  let captureScreenshot = $state("");
  let capturePdf = $state("");
  let editingLimits = $state(false);
  let maxPages = $state("");
  let maxDepth = $state("");
  let editingIgnore = $state(false);
  let ignoreText = $state("");
  let graphIgnoreText = $state("");
  let ignoreError = $state<{ field: PatternField; message: string } | null>(null);
  let editingLabels = $state(false);
  let titleText = $state("");
  let groupsText = $state("");
  let labelError = $state<{ field: "title" | "groups"; message: string } | null>(null);

  // Page state belongs to one source; start fresh when another one is shown.
  $effect.pre(() => {
    void nav.sourceId;
    untrack(() => {
      error = "";
      menuOpen = false;
      confirmRemove = false;
      showAllMissing = false;
      editingCrawl4ai = false;
      editingLimits = false;
      editingIgnore = false;
      ignoreError = null;
      editingLabels = false;
      labelError = null;
    });
  });

  const path = $derived(s ? `/api/sources/${encodeURIComponent(s.id)}` : "");
  const g = $derived(s?.activeGeneration ?? null);
  const preparing = $derived(s?.state === "preparing");
  const progressText = $derived(preparing ? [s?.latest?.phase, s?.latest?.progress].filter(Boolean).join(" ") : "");
  const progress = $derived(fraction(s?.latest?.progress));
  const phaseIndex = $derived(PHASES.indexOf((s?.latest?.phase ?? "") as (typeof PHASES)[number]));
  const failure = $derived(s?.latest?.status === "failed" ? (s.latest.error ?? "failed") : null);
  const crawl4ai = $derived<Crawl4aiSettings>(s?.crawl4ai ?? {});
  const crawlLimits = $derived(s?.crawl ?? {});
  const crawl4aiChanged = $derived(Object.keys(crawl4ai).length);
  const stat = (key: string): number | null => (typeof g?.stats[key] === "number" ? (g.stats[key] as number) : null);
  const graphMissing = $derived(Array.isArray(g?.stats.graphMissing) ? (g.stats.graphMissing as string[]) : []);
  const graphIgnored = $derived(typeof g?.stats.graphIgnored === "number" ? g.stats.graphIgnored : 0);
  const artifacts = $derived(Array.isArray(g?.stats.artifacts) ? (g.stats.artifacts as string[]) : []);
  // With a per-source crawler the global one is not known here, so the option then reads just "Global default".
  const globalCrawlerLabel = $derived(
    s && !s.crawlProvider && s.effectiveCrawlProvider ? `Global default (${CRAWLER_LABELS[s.effectiveCrawlProvider] ?? s.effectiveCrawlProvider})` : "Global default",
  );
  const primaryLabel = $derived(
    s?.state === "ready" ? "Update" : s?.state === "failed" ? "Retry" : s?.state === "stale" ? "Prepare Again" : "Prepare",
  );
  const noGraphLabel = $derived(s?.state === "ready" ? "Update Without Graph" : "Prepare Without Graph");

  async function run(action: () => Promise<unknown>): Promise<boolean> {
    actionBusy = true;
    error = "";
    let ok = false;
    try {
      await action();
      ok = true;
    } catch (err) {
      error = errorText(err);
    } finally {
      actionBusy = false;
    }
    await sources.refresh();
    return ok;
  }

  function prepare(graph: boolean, graphOnly = false, force = false) {
    menuOpen = false;
    const body = graphOnly ? { graphOnly, ...(force ? { force } : {}) } : { graph };
    run(() => api(`${path}/prepare`, { method: "POST", body }));
  }

  async function generateSummary() {
    const sourceId = s!.id;
    const summaryPath = `${path}/summary`;
    const force = !!s!.summary;
    summarizingIds = [...summarizingIds, sourceId];
    error = "";
    try {
      await api(summaryPath, { method: "POST", body: { force } });
    } catch (err) {
      // A cancel the user asked for is not an error, and neither is one for a page they left.
      const cancelled = err instanceof ApiError && err.code === "cancelled";
      if (!cancelled && nav.sourceId === sourceId) error = errorText(err);
    } finally {
      summarizingIds = summarizingIds.filter((id) => id !== sourceId);
      await sources.refresh();
    }
  }

  function cancel() {
    run(() => api(`${path}/cancel`, { method: "POST", body: {} }));
  }

  async function remove() {
    if (await run(() => api(path, { method: "DELETE", body: {} }))) nav.go("search");
  }

  function setCrawler(value: string) {
    run(() => api(path, { method: "PATCH", body: { crawlProvider: value || null } }));
  }

  function editLimits() {
    maxPages = crawlLimits.maxPages === undefined ? "" : String(crawlLimits.maxPages);
    maxDepth = crawlLimits.maxDepth === undefined ? "" : String(crawlLimits.maxDepth);
    editingLimits = true;
  }

  function saveLimits(event: SubmitEvent) {
    event.preventDefault();
    run(async () => {
      await api(path, { method: "PATCH", body: { crawl: { maxPages: maxPages === "" ? null : Number(maxPages), maxDepth: maxDepth === "" ? null : Number(maxDepth) } } });
      editingLimits = false;
    });
  }

  function editIgnore() {
    ignoreText = (s?.ignore ?? []).join("\n");
    graphIgnoreText = (s?.graphIgnore ?? []).join("\n");
    ignoreError = null;
    editingIgnore = true;
  }

  async function saveIgnore(event: SubmitEvent) {
    event.preventDefault();
    actionBusy = true;
    error = "";
    ignoreError = null;
    let invalid: PatternField | null = null;
    try {
      await api(path, { method: "PATCH", body: { ignore: patternLines(ignoreText), graphIgnore: patternLines(graphIgnoreText) } });
      editingIgnore = false;
    } catch (err) {
      // A bad pattern is shown at its field, and the form stays open with the text as typed.
      if (err instanceof ApiError && isPatternField(err.field)) {
        invalid = err.field;
        ignoreError = { field: invalid, message: patternError(err.message) };
      } else error = errorText(err);
    } finally {
      actionBusy = false;
    }
    if (invalid) {
      await tick();
      document.getElementById(invalid === "ignore" ? "source-ignore" : "source-graph-ignore")?.focus();
    }
    await sources.refresh();
  }

  function editLabels() {
    titleText = s?.title ?? "";
    groupsText = (s?.groups ?? []).join(", ");
    labelError = null;
    editingLabels = true;
  }

  async function saveLabels(event: SubmitEvent) {
    event.preventDefault();
    actionBusy = true;
    error = "";
    labelError = null;
    let invalid: "title" | "groups" | null = null;
    try {
      const groups = groupsText.split(/[\s,]+/).filter(Boolean);
      await api(path, { method: "PATCH", body: { title: titleText.trim() || null, groups } });
      editingLabels = false;
    } catch (err) {
      // A bad value is shown at its field, and the form stays open with the text as typed.
      if (err instanceof ApiError && (err.field === "title" || err.field === "groups")) {
        invalid = err.field;
        labelError = { field: invalid, message: err.message.replace(/^(?:title|groups): /, "") };
      } else error = errorText(err);
    } finally {
      actionBusy = false;
    }
    if (invalid) {
      await tick();
      document.getElementById(invalid === "title" ? "source-title" : "source-groups")?.focus();
    }
    await sources.refresh();
  }

  function editCrawl4ai() {
    stream = crawl4ai.stream === undefined ? "" : String(crawl4ai.stream);
    waitUntil = crawl4ai.waitUntil ?? "";
    waitFor = crawl4ai.waitFor ?? "";
    delay = crawl4ai.delayBeforeReturnHtml === undefined ? "" : String(crawl4ai.delayBeforeReturnHtml);
    scanFullPage = crawl4ai.scanFullPage === undefined ? "" : String(crawl4ai.scanFullPage);
    captureScreenshot = crawl4ai.captureScreenshot === undefined ? "" : String(crawl4ai.captureScreenshot);
    capturePdf = crawl4ai.capturePdf === undefined ? "" : String(crawl4ai.capturePdf);
    editingCrawl4ai = true;
  }

  function saveCrawl4ai(event: SubmitEvent) {
    event.preventDefault();
    const options: Crawl4aiSettings = { ...crawl4ai };
    if (stream === "") delete options.stream;
    else options.stream = stream === "true";
    if (waitUntil.trim()) options.waitUntil = waitUntil.trim() as Crawl4aiSettings["waitUntil"];
    else delete options.waitUntil;
    if (waitFor.trim()) options.waitFor = waitFor.trim();
    else delete options.waitFor;
    if (delay === "") delete options.delayBeforeReturnHtml;
    else options.delayBeforeReturnHtml = Number(delay);
    if (scanFullPage === "") delete options.scanFullPage;
    else options.scanFullPage = scanFullPage === "true";
    if (captureScreenshot === "") delete options.captureScreenshot;
    else options.captureScreenshot = captureScreenshot === "true";
    if (capturePdf === "") delete options.capturePdf;
    else options.capturePdf = capturePdf === "true";
    run(async () => {
      await api(path, { method: "PATCH", body: { crawl4ai: options } });
      editingCrawl4ai = false;
    });
  }

  async function saveArtifact(kind: "screenshot" | "pdf") {
    error = "";
    try {
      await downloadArtifact(`${path}/artifacts/${kind}`, kind === "screenshot" ? "screenshot.png" : "page.pdf");
    } catch (err) {
      error = errorText(err);
    }
  }

  let menuRoot: HTMLElement | undefined = $state();
  function closeMenuOutside(event: MouseEvent) {
    if (menuOpen && menuRoot && !menuRoot.contains(event.target as Node)) menuOpen = false;
  }
</script>

<svelte:window onclick={closeMenuOutside} onkeydown={(e) => e.key === "Escape" && (menuOpen = false)} />

{#snippet patterns(label: string, list: string[])}
  <Row {label} class="items-start">
    {#if list.length}
      <ul class="flex max-w-[60%] min-w-0 flex-col items-end gap-0.5 pt-px">
        {#each list as pattern (pattern)}<li class="max-w-full truncate font-mono text-[12px] leading-[18px] text-label2" title={pattern}>{pattern}</li>{/each}
      </ul>
    {:else}
      <span class="text-[13px] text-label2">None</span>
    {/if}
  </Row>
{/snippet}

{#snippet onOff(id: string, label: string, value: string, set: (v: string) => void)}
  <Row {label} for={id} class="pl-9">
    <select {id} class={popup()} {value} onchange={(e) => set(e.currentTarget.value)} disabled={busy || preparing}>
      <option value="">Default</option><option value="true">On</option><option value="false">Off</option>
    </select>
  </Row>
{/snippet}

{#if !s}
  <Toolbar><span class="flex-1"></span></Toolbar>
  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto max-w-[720px] px-8 pt-2 pb-10">
      <h1 class="text-[26px] leading-8 font-bold">Sources</h1>
      {#if sources.error}
        <div class={notice({ tone: "bad", class: "mt-4" })} role="alert"><StatusIcon tone="bad" class="mt-0.5" /><span class="break-words">{sources.error}</span></div>
      {/if}
      <p class="mt-2 text-[13px] leading-[18px] text-label2">
        {#if sources.list === null}
          Loading sources…
        {:else if nav.sourceId && sources.list.length}
          This source is no longer in the store. Pick another one in the sidebar{session.admin ? ", or add a new one" : ""}.
        {:else if sources.list.length}
          Pick a source in the sidebar to see its index{session.admin ? ", crawler settings and actions" : ""}.
        {:else}
          {session.admin ? "No sources yet. Add a website or a local folder, and Docify keeps a copy of its documentation for agents." : "No sources yet. An administrator adds them."}
        {/if}
      </p>
      {#if session.admin}<button type="button" class={button({ intent: "primary", size: "md", class: "mt-4" })} onclick={() => (nav.addingSource = true)}>Add Source</button>{/if}
    </div>
  </div>
{:else}
  <Toolbar>
    <span class="flex-1"></span>
    <!-- Members read a source; preparing, crawler settings and removal are for administrators. -->
    <span class={capsule({ class: cn("relative", !session.admin && "hidden") })} bind:this={menuRoot}>
      {#if preparing}
        <button type="button" class={capsuleButton()} disabled={busy} onclick={cancel}><X size={14} />Cancel</button>
      {:else}
        <button type="button" class={capsuleButton({ class: "rounded-r-none pr-2" })} disabled={busy} onclick={() => prepare(true)}>{primaryLabel}</button>
        <button
          type="button"
          class={capsuleButton({ class: "min-w-0 rounded-l-none pr-2.5 pl-1.5" })}
          aria-label="More preparation options"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={busy}
          onclick={() => (menuOpen = !menuOpen)}><ChevronDown size={12} strokeWidth={2} /></button
        >
        {#if menuOpen}
          <div role="menu" class="absolute top-[calc(100%+6px)] right-0 z-20 min-w-[220px] rounded-[10px] border border-sep bg-surface p-1 shadow-float">
            <button type="button" role="menuitem" class="flex h-7 w-full items-center rounded-md px-2.5 text-left text-[13px] text-label hover:bg-accent hover:text-white" onclick={() => prepare(false)}
              >{noGraphLabel}</button
            >
            {#if s.graphRetry}
              <button
                type="button"
                role="menuitem"
                title="Builds the graph from the {s.graphRetry.documents.toLocaleString()} documents the failed attempt already collected and indexed"
                class="flex h-7 w-full items-center rounded-md px-2.5 text-left text-[13px] text-label hover:bg-accent hover:text-white"
                onclick={() => prepare(true, true)}>Retry Graph Only</button
              >
              <button
                type="button"
                role="menuitem"
                title="Reuses the collected documents and embeddings, but calls the model again without Graphify's extraction cache. May incur additional costs. Keeps the incomplete-graph protection."
                class="flex min-h-7 w-full items-center rounded-md px-2.5 py-1 text-left text-[13px] text-label hover:bg-accent hover:text-white"
                onclick={() => prepare(true, true, true)}>Retry Graph Only without Cache</button
              >
            {/if}
          </div>
        {/if}
      {/if}
    </span>
    {#if s.kind === "url"}
      <span class={capsule()}>
        <a class={capsuleButton({ class: "px-0" })} href={s.locator} target="_blank" rel="noopener noreferrer" aria-label="Open site" title="Open site"><ExternalLink size={14} /></a>
      </span>
    {/if}
  </Toolbar>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto max-w-[720px] px-8 pt-2 pb-10">
      {#if error}
        <div class={notice({ tone: "bad", class: "mb-4" })} role="alert">
          <StatusIcon tone="bad" class="mt-0.5" />
          <span class="min-w-0 flex-1 break-words whitespace-pre-wrap">{error}</span>
          <button type="button" class="shrink-0 rounded text-bad-text" aria-label="Dismiss" onclick={() => (error = "")}><X size={14} /></button>
        </div>
      {/if}

      <h1 class="flex flex-wrap items-baseline gap-x-2 text-[26px] leading-8 font-bold break-all">
        {#if s.title}{s.title}<span class="font-mono text-[17px] font-normal text-label2">{s.id}</span>{:else}{s.library}{#if s.version}<span class="font-mono text-[17px] font-normal text-label2">{s.version}</span>{/if}{/if}
      </h1>
      <div class="mt-1.5 flex min-w-0 items-center gap-2 text-[13px] text-label2">
        <StatusChip tone={sourceTone(s.state)} label={sourceStateLabel(s.state)} />
        <span aria-hidden="true">·</span>
        {#if s.kind === "url"}
          <Link size={13} class="shrink-0 text-label3" aria-hidden="true" />
          <a class="truncate font-mono text-[12px] text-accent-text hover:underline" href={s.locator} target="_blank" rel="noopener noreferrer" title={s.locator}>{s.locator}</a>
        {:else}
          <span class="truncate font-mono text-[12px]" title={s.locator}>{s.locator}</span>
        {/if}
      </div>

      <Group title="Name and groups" hint="The name is a label; agents and citations keep using the id. A group lets agents search all its sources at once by passing its name.">
        {#if session.admin && editingLabels}
          <form onsubmit={saveLabels}>
            <Row class="flex-col items-stretch gap-1.5">
              <label for="source-title" class="text-[13px] text-label">Name</label>
              <input id="source-title" class={input({ invalid: labelError?.field === "title" })} maxlength="120" autocomplete="off" placeholder={`${s.library}${s.version ? ` ${s.version}` : ""}`} aria-invalid={labelError?.field === "title"} aria-describedby="source-title-note" bind:value={titleText} oninput={() => labelError?.field === "title" && (labelError = null)} disabled={busy} />
              {#if labelError?.field === "title"}
                <span id="source-title-note" class={cn(footnote, "font-medium break-words text-bad-text")} role="alert">{labelError.message}</span>
              {:else}
                <span id="source-title-note" class={footnote}>Leave blank to show the library and version.</span>
              {/if}
            </Row>
            <Row class="flex-col items-stretch gap-1.5">
              <label for="source-groups" class="text-[13px] text-label">Groups</label>
              <input id="source-groups" class={input({ mono: true, invalid: labelError?.field === "groups" })} autocomplete="off" spellcheck="false" placeholder="frontend, apple" aria-invalid={labelError?.field === "groups"} aria-describedby="source-groups-note" bind:value={groupsText} oninput={() => labelError?.field === "groups" && (labelError = null)} disabled={busy} />
              {#if labelError?.field === "groups"}
                <span id="source-groups-note" class={cn(footnote, "font-medium break-words text-bad-text")} role="alert">{labelError.message}</span>
              {:else}
                <span id="source-groups-note" class={footnote}>Separate names with commas. Lowercase letters, digits, dots, dashes and underscores.</span>
              {/if}
            </Row>
            <Row class="justify-end">
              <button type="button" class={button({ size: "xs" })} disabled={busy} onclick={() => (editingLabels = false)}>Cancel</button>
              <button type="submit" class={button({ intent: "primary", size: "xs" })} disabled={busy}>Save</button>
            </Row>
          </form>
        {:else}
          <Row label="Id"><span class="font-mono text-[13px] text-label2 break-all">{s.id}</span></Row>
          <Row label="Name"><span class="text-[13px] text-label2">{s.title ?? "Not set"}</span></Row>
          <Row label="Groups"><span class="font-mono text-[13px] text-label2">{s.groups.length ? s.groups.join(", ") : "None"}</span></Row>
          {#if session.admin}
            <Row class="justify-end"><button type="button" class={button({ size: "xs" })} disabled={busy} onclick={editLabels}>Edit</button></Row>
          {/if}
        {/if}
      </Group>

      <Group title="Collection summary" hint={session.admin ? "A generated discovery hint, not cited evidence. Generation sends a documentation sample to the configured OpenAI-compatible graph provider." : "A generated discovery hint, not cited evidence."}>
        <div class="px-3.5 py-3">
          {#if s.summary}
            <p class="text-[13px] leading-5 break-words whitespace-pre-wrap">{s.summary.text}</p>
            <p class="mt-2 text-[12px] text-label2" title={s.summary.generatedAt}>Generated {ago(s.summary.generatedAt)} · {s.summary.model} · generation #{s.summary.generation}</p>
          {:else}
            <p class="text-[13px] leading-5 text-label2">{!session.admin ? "No summary for this generation." : g ? "No summary for this generation. Generate one to help agents discover what this collection covers." : "Prepare this source before generating a summary."}</p>
          {/if}
          <div class={cn("mt-3 flex flex-wrap items-center gap-3", !session.admin && "hidden")}>
            <button type="button" class={button({ size: "xs" })} disabled={busy || preparing || !g} onclick={generateSummary}>{s.summary ? "Regenerate Summary" : "Generate Summary"}</button>
            {#if summarizing}
              <button type="button" class={button({ size: "xs" })} disabled={actionBusy} onclick={cancel}>Cancel</button>
              <p class="text-[12px] text-label2" role="status">Generating summary…</p>
            {/if}
          </div>
        </div>
      </Group>

      {#if preparing}
        <section class="mt-6" aria-label="Preparation progress">
          <ol class="flex flex-wrap gap-x-4 gap-y-2">
            {#each PHASES as phase, i (phase)}
              {@const state = phaseIndex < 0 ? (i === 0 ? "current" : "pending") : i < phaseIndex ? "done" : i === phaseIndex ? "current" : "pending"}
              <li class="flex items-center gap-1.5 text-[13px]" aria-current={state === "current" ? "step" : undefined}>
                {#if state === "done"}
                  <CircleCheck size={14} class="text-ok-text" aria-hidden="true" />
                  <span class="text-label2">{PHASE_LABELS[phase]}</span><span class="sr-only">, done</span>
                {:else if state === "current"}
                  <CircleDot size={14} class="text-accent-text" aria-hidden="true" />
                  <span class="font-semibold text-label">{PHASE_LABELS[phase]}</span><span class="sr-only">, in progress</span>
                {:else}
                  <Circle size={14} class="text-label3" aria-hidden="true" />
                  <span class="text-label2">{PHASE_LABELS[phase]}</span><span class="sr-only">, pending</span>
                {/if}
              </li>
            {/each}
          </ol>
          <div
            class="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-fill"
            role="progressbar"
            aria-label="Preparation progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress === null ? undefined : Math.round(progress * 100)}
            aria-valuetext={progressText || "starting"}
          >
            {#if progress !== null}
              <div class="h-full rounded-full bg-accent motion-safe:transition-[width] motion-safe:duration-300" style:width={`${Math.round(progress * 100)}%`}></div>
            {:else}
              <div class="h-full w-1/3 rounded-full bg-accent/70 motion-safe:animate-pulse"></div>
            {/if}
          </div>
          <p class="mt-1.5 font-mono text-[12px] text-label2">{progressText || "starting"}</p>
        </section>
      {:else if failure}
        <div class={notice({ tone: s.state === "stale" ? "warn" : "bad", class: "mt-6" })} role="status">
          <StatusIcon tone={s.state === "stale" ? "warn" : "bad"} class="mt-0.5" />
          <div class="min-w-0">
            <p class="font-medium">{s.state === "stale" ? "The last update stopped. The previous generation still serves searches." : "Preparation failed."}</p>
            <p class="mt-1 font-mono text-[12px] break-words whitespace-pre-wrap">{failure}</p>
          </div>
        </div>
      {/if}

      {#if g}
        {@const documents = stat("documents")}
        {@const passages = stat("passages")}
        {@const nodes = stat("graphNodes")}
        {@const edges = stat("graphEdges")}
        <Group title="Index">
          {#if documents !== null}<Row label="Documents"><span class="font-mono text-[13px] text-label2">{documents.toLocaleString()}</span></Row>{/if}
          {#if passages !== null}<Row label="Passages"><span class="font-mono text-[13px] text-label2">{passages.toLocaleString()}</span></Row>{/if}
          <Row
            label="Semantic graph"
            sub={graphCoverage(g.graphStatus, graphMissing.length, graphIgnored)}
          >
            <span class="flex items-center gap-2.5">
              {#if g.graphStatus === "ok"}
                <StatusChip tone="ok" label="Complete" />
              {:else if g.graphStatus === "partial"}
                <StatusChip tone="warn" label="Partial" />
              {:else if g.graphStatus === "failed"}
                <StatusChip tone="bad" label="Failed" />
              {:else}
                <StatusChip tone="neutral" label={g.graphStatus ? g.graphStatus : "Not built"} />
              {/if}
              {#if nodes !== null && (g.graphStatus === "ok" || g.graphStatus === "partial")}
                <span class="font-mono text-[12px] text-label2">{nodes.toLocaleString()} nodes · {(edges ?? 0).toLocaleString()} edges</span>
              {/if}
            </span>
          </Row>
          {#if g.embeddingModel}
            <Row label="Embedding model" sub="Vector search uses only this model's vectors"><span class="font-mono text-[13px] text-label2">{g.embeddingModel}</span></Row>
          {/if}
          <Row label="Generation">
            <span class="text-[13px] text-label2" title={g.downloadedAt ?? undefined}><span class="font-mono">#{g.id}</span>, downloaded {ago(g.downloadedAt)}</span>
          </Row>
        </Group>
        <SourceTree sourceId={s.id} generation={g.id} />
      {:else if !preparing && !failure}
        <div class={notice({ class: "mt-6" })}>
          <StatusIcon tone="info" class="mt-0.5" />
          <span>Not prepared yet. {primaryLabel} downloads, indexes and embeds the documentation so agents can search it.</span>
        </div>
      {/if}

      {#if graphMissing.length}
        <Group title="Not in the graph" hint="The next update retries these pages from Graphify's cache.">
          {#each showAllMissing ? graphMissing : graphMissing.slice(0, MISSING_PREVIEW) as file (file)}
            <Row><span class="min-w-0 flex-1 truncate font-mono text-[12px] text-label" title={file}>{file}</span></Row>
          {/each}
          {#if graphMissing.length > MISSING_PREVIEW}
            <Row>
              <button type="button" class={button({ intent: "link", size: "xs" })} onclick={() => (showAllMissing = !showAllMissing)}
                >{showAllMissing ? "Show Fewer" : `Show All ${graphMissing.length}`}</button
              >
            </Row>
          {/if}
        </Group>
      {/if}

      {#if session.admin}
        <Group title="Ignored paths" hint="Regular expressions matched against the document path, such as ^changelog/. Changes apply on the next update.">
          {#if editingIgnore}
            <form onsubmit={saveIgnore}>
              <Row class="flex-col items-stretch gap-1.5">
                <label for="source-ignore" class="text-[13px] text-label">Do not collect</label>
                <textarea id="source-ignore" class={textArea({ invalid: ignoreError?.field === "ignore" })} rows="3" spellcheck="false" autocomplete="off" placeholder="One pattern per line" aria-invalid={ignoreError?.field === "ignore"} aria-describedby="source-ignore-note" bind:value={ignoreText} oninput={() => ignoreError?.field === "ignore" && (ignoreError = null)} disabled={busy || preparing}></textarea>
                {#if ignoreError?.field === "ignore"}
                  <span id="source-ignore-note" class={cn(footnote, "font-medium break-words text-bad-text")} role="alert">{ignoreError.message}</span>
                {:else}
                  <span id="source-ignore-note" class={footnote}>Matching {s.kind === "url" ? "pages are not fetched" : "files are not read"} and cannot be searched.</span>
                {/if}
              </Row>
              <Row class="flex-col items-stretch gap-1.5">
                <label for="source-graph-ignore" class="text-[13px] text-label">Leave out of the graph</label>
                <textarea id="source-graph-ignore" class={textArea({ invalid: ignoreError?.field === "graphIgnore" })} rows="3" spellcheck="false" autocomplete="off" placeholder="One pattern per line" aria-invalid={ignoreError?.field === "graphIgnore"} aria-describedby="source-graph-ignore-note" bind:value={graphIgnoreText} oninput={() => ignoreError?.field === "graphIgnore" && (ignoreError = null)} disabled={busy || preparing}></textarea>
                {#if ignoreError?.field === "graphIgnore"}
                  <span id="source-graph-ignore-note" class={cn(footnote, "font-medium break-words text-bad-text")} role="alert">{ignoreError.message}</span>
                {:else}
                  <span id="source-graph-ignore-note" class={footnote}>Matching documents stay searchable but get no graph nodes.</span>
                {/if}
              </Row>
              <Row class="justify-end">
                <button type="button" class={button({ size: "xs" })} disabled={busy} onclick={() => (editingIgnore = false)}>Cancel</button>
                <button type="submit" class={button({ intent: "primary", size: "xs" })} disabled={busy || preparing}>Save</button>
              </Row>
            </form>
          {:else}
            {@render patterns("Do not collect", s.ignore)}
            {@render patterns("Leave out of the graph", s.graphIgnore)}
            <Row class="justify-end"><button type="button" class={button({ size: "xs" })} disabled={busy || preparing} onclick={editIgnore}>Edit patterns</button></Row>
          {/if}
        </Group>

      {/if}

      {#if s.kind === "url" && session.admin}
        <Group title="Crawl limits" hint="Leave a field blank to use the global setting. Changes apply on the next update.">
          {#if editingLimits}
            <form onsubmit={saveLimits}>
              <Row label="Max pages" for="source-max-pages">
                <input id="source-max-pages" class={input({ mono: true, class: "w-24" })} type="number" min="1" max="100000" step="1" placeholder="Global" value={maxPages} oninput={(e) => (maxPages = e.currentTarget.value)} disabled={busy || preparing} />
              </Row>
              <Row label="Max depth" sub="0 fetches only the start page" for="source-max-depth">
                <input id="source-max-depth" class={input({ mono: true, class: "w-24" })} type="number" min="0" max="1000" step="1" placeholder="Global" value={maxDepth} oninput={(e) => (maxDepth = e.currentTarget.value)} disabled={busy || preparing} />
              </Row>
              <Row class="justify-end">
                <button type="button" class={button({ size: "xs" })} disabled={busy} onclick={() => (editingLimits = false)}>Cancel</button>
                <button type="submit" class={button({ intent: "primary", size: "xs" })} disabled={busy || preparing}>Save</button>
              </Row>
            </form>
          {:else}
            <Row label="Max pages"><span class="font-mono text-[13px] text-label2">{crawlLimits.maxPages ?? "Global default"}</span></Row>
            <Row label="Max depth"><span class="font-mono text-[13px] text-label2">{crawlLimits.maxDepth ?? "Global default"}</span></Row>
            <Row class="justify-end"><button type="button" class={button({ size: "xs" })} disabled={busy || preparing} onclick={editLimits}>Edit limits</button></Row>
          {/if}
        </Group>
        <Group title="Crawler">
          <Row label="Fetch pages with" sub="Applies on the next update" for="source-crawler">
            <select id="source-crawler" class={popup()} value={s.crawlProvider ?? ""} disabled={busy || preparing} onchange={(e) => setCrawler(e.currentTarget.value)}>
              <option value="">{globalCrawlerLabel}</option>
              <option value="builtin">Built-in</option>
              <option value="crawl4ai">Crawl4AI</option>
              <option value="browserless">Browserless</option>
            </select>
          </Row>
          {#if s.effectiveCrawlProvider === "crawl4ai"}
            <button
              type="button"
              class="relative flex min-h-10 w-full items-center gap-1.5 px-3.5 py-2 text-left text-[13px] text-label before:absolute before:top-0 before:right-0 before:left-3.5 before:h-px before:bg-sep/60 before:content-[''] hover:bg-fill/40 disabled:opacity-60"
              aria-expanded={editingCrawl4ai}
              disabled={preparing}
              onclick={() => (editingCrawl4ai ? (editingCrawl4ai = false) : editCrawl4ai())}
            >
              <ChevronRight size={14} class={cn("shrink-0 text-label3 motion-safe:transition-transform", editingCrawl4ai && "rotate-90")} aria-hidden="true" />
              <span class="flex-1">Crawl4AI options</span>
              <span class={footnote}>{crawl4aiChanged ? `${crawl4aiChanged} changed` : "Defaults"}</span>
            </button>
            {#if editingCrawl4ai}
              <form onsubmit={saveCrawl4ai}>
                <div class="ml-3.5 h-px bg-sep/60"></div>
                {@render onOff("c4-stream", "Stream", stream, (v) => (stream = v))}
                <Row label="Wait until" for="c4-wait-until" class="pl-9">
                  <select id="c4-wait-until" class={popup()} bind:value={waitUntil} disabled={busy || preparing}>
                    <option value="">Default</option><option value="load">Load</option><option value="domcontentloaded">DOM content loaded</option><option value="networkidle">Network idle</option><option value="commit">Commit</option>
                  </select>
                </Row>
                <Row label="Wait for" sub="CSS selector or JavaScript condition" for="c4-wait-for" class="pl-9">
                  <input id="c4-wait-for" class={input({ mono: true, class: "w-[200px]" })} bind:value={waitFor} placeholder="Default" disabled={busy || preparing} />
                </Row>
                <Row label="Delay before reading" sub="Seconds" for="c4-delay" class="pl-9">
                  <input
                    id="c4-delay"
                    class={input({ mono: true, class: "w-24" })}
                    type="number"
                    min="0"
                    step="any"
                    value={delay}
                    oninput={(e) => (delay = e.currentTarget.value)}
                    placeholder="Default"
                    disabled={busy || preparing}
                  />
                </Row>
                {@render onOff("c4-scan", "Scan full page", scanFullPage, (v) => (scanFullPage = v))}
                {@render onOff("c4-screenshot", "Capture screenshot", captureScreenshot, (v) => (captureScreenshot = v))}
                {@render onOff("c4-pdf", "Capture PDF", capturePdf, (v) => (capturePdf = v))}
                <Row class="justify-end pl-9">
                  <button type="button" class={button({ size: "xs" })} disabled={busy} onclick={() => (editingCrawl4ai = false)}>Cancel</button>
                  <button type="submit" class={button({ intent: "primary", size: "xs" })} disabled={busy || preparing}>Save</button>
                </Row>
              </form>
            {/if}
          {/if}
        </Group>
      {/if}

      {#if artifacts.includes("screenshot") || artifacts.includes("pdf")}
        <Group title="Artifacts">
          {#if artifacts.includes("screenshot")}
            <Row label="Screenshot" sub="screenshot.png"><button type="button" class={button({ size: "xs" })} onclick={() => saveArtifact("screenshot")}>Download</button></Row>
          {/if}
          {#if artifacts.includes("pdf")}
            <Row label="PDF" sub="page.pdf"><button type="button" class={button({ size: "xs" })} onclick={() => saveArtifact("pdf")}>Download</button></Row>
          {/if}
        </Group>
      {/if}

      {#if session.admin}
      <Group
        class="mt-7"
        hint={preparing
          ? "Cancel the running preparation before removing this source."
          : `Removing deletes every generation and snapshot of ${s.id} from the store. It cannot be undone.`}
      >
        <button
          type="button"
          class="flex min-h-10 w-full items-center justify-center px-3.5 text-[13px] font-medium text-bad-text hover:bg-fill/40 disabled:opacity-50"
          disabled={busy || preparing}
          onclick={() => (confirmRemove = true)}>Remove Source…</button
        >
      </Group>
      {/if}
    </div>
  </div>

  <ConfirmDialog
    bind:open={confirmRemove}
    title={`Remove ${s.id}?`}
    message={`Every generation and snapshot of ${s.id} is deleted from the store. Agents can no longer search it. This cannot be undone.`}
    confirmLabel="Remove Source"
    onconfirm={remove}
  />
{/if}

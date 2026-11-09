<script lang="ts">
  import StatusChip from "../components/StatusChip.svelte";
  import { api, downloadArtifact, errorText, type SourceInfo } from "../lib/api.ts";
  import { ago, fraction } from "../lib/format.ts";
  import { button, input, panel, sourceTone } from "../lib/ui.ts";

  let { source: s, onchanged, onerror }: { source: SourceInfo; onchanged: () => void; onerror: (message: string) => void } = $props();

  let busy = $state(false);
  let confirmRemove = $state(false);
  let editingCrawl4ai = $state(false);
  let stream = $state("");
  let waitUntil = $state("");
  let waitFor = $state("");
  let delay = $state("");
  let scanFullPage = $state("");
  let captureScreenshot = $state("");
  let capturePdf = $state("");

  type Crawl4aiSettings = { stream?: boolean; waitUntil?: string; waitFor?: string; delayBeforeReturnHtml?: number; scanFullPage?: boolean; captureScreenshot?: boolean; capturePdf?: boolean };
  const crawl4ai = $derived((s as SourceInfo & { crawl4ai?: Crawl4aiSettings | null }).crawl4ai ?? {});

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
    if (stream === "") delete options.stream; else options.stream = stream === "true";
    if (waitUntil.trim()) options.waitUntil = waitUntil.trim(); else delete options.waitUntil;
    if (waitFor.trim()) options.waitFor = waitFor.trim(); else delete options.waitFor;
    if (delay === "") delete options.delayBeforeReturnHtml; else options.delayBeforeReturnHtml = Number(delay);
    if (scanFullPage === "") delete options.scanFullPage; else options.scanFullPage = scanFullPage === "true";
    if (captureScreenshot === "") delete options.captureScreenshot; else options.captureScreenshot = captureScreenshot === "true";
    if (capturePdf === "") delete options.capturePdf; else options.capturePdf = capturePdf === "true";
    run(async () => {
      await api(path, { method: "PATCH", body: { crawl4ai: options } });
      editingCrawl4ai = false;
    });
  }
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

  async function saveArtifact(kind: "screenshot" | "pdf") {
    try {
      await downloadArtifact(`${path}/artifacts/${kind}`, kind === "screenshot" ? "screenshot.png" : "page.pdf");
    } catch (err) {
      onerror(errorText(err));
    }
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

  {#if s.kind === "url"}
    <label class="flex flex-wrap items-center gap-2 text-[12px] text-zinc-500 dark:text-zinc-400">
      Crawler
      <select class={input({ class: "w-auto" })} aria-label={`Crawl provider for ${s.id}`} value={s.crawlProvider ?? ""} disabled={busy || preparing}
        onchange={(event) => run(() => api(path, { method: "PATCH", body: { crawlProvider: event.currentTarget.value || null } }))}>
        <option value="">Global default</option>
        <option value="builtin">Built-in</option>
        <option value="crawl4ai">Crawl4AI</option>
        <option value="browserless">Browserless</option>
      </select>
    </label>
    {#if editingCrawl4ai}
      <form class="flex flex-wrap items-end gap-2 text-[12px] text-zinc-500 dark:text-zinc-400" onsubmit={saveCrawl4ai}>
        <label class="flex flex-col gap-1">Stream
          <select class={input({ class: "w-auto" })} bind:value={stream} disabled={busy || preparing}>
            <option value="">Default</option><option value="true">On</option><option value="false">Off</option>
          </select>
        </label>
        <label class="flex flex-col gap-1">Wait until
          <select class={input({ class: "w-auto" })} bind:value={waitUntil} disabled={busy || preparing}>
            <option value="">Default</option><option value="load">Load</option><option value="domcontentloaded">DOM content loaded</option><option value="networkidle">Network idle</option><option value="commit">Commit</option>
          </select>
        </label>
        <label class="flex flex-col gap-1">Wait for
          <input class={input({ class: "w-40" })} bind:value={waitFor} placeholder="Default" disabled={busy || preparing} />
        </label>
        <label class="flex flex-col gap-1">Delay (seconds)
          <input class={input({ class: "w-24" })} type="number" min="0" step="any" value={delay} oninput={(event) => (delay = event.currentTarget.value)} placeholder="Default" disabled={busy || preparing} />
        </label>
        <label class="flex flex-col gap-1">Scan full page
          <select class={input({ class: "w-auto" })} bind:value={scanFullPage} disabled={busy || preparing}>
            <option value="">Default</option><option value="true">On</option><option value="false">Off</option>
          </select>
        </label>
        <label class="flex flex-col gap-1">Capture screenshot
          <select class={input({ class: "w-auto" })} bind:value={captureScreenshot} disabled={busy || preparing}>
            <option value="">Default</option><option value="true">On</option><option value="false">Off</option>
          </select>
        </label>
        <label class="flex flex-col gap-1">Capture PDF
          <select class={input({ class: "w-auto" })} bind:value={capturePdf} disabled={busy || preparing}>
            <option value="">Default</option><option value="true">On</option><option value="false">Off</option>
          </select>
        </label>
        <button type="submit" class={button({ size: "xs" })} disabled={busy || preparing}>Save</button>
        <button type="button" class={button({ size: "xs" })} disabled={busy} onclick={() => (editingCrawl4ai = false)}>Cancel</button>
      </form>
    {:else}
      <div><button type="button" class={button({ size: "xs" })} disabled={busy || preparing} onclick={editCrawl4ai}>Crawl4AI settings</button></div>
    {/if}
  {/if}

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

  {#if Array.isArray(g?.stats.artifacts)}
    <div class="flex flex-wrap gap-1">
      {#if g.stats.artifacts.includes("screenshot")}
        <button type="button" class={button({ size: "xs" })} onclick={() => saveArtifact("screenshot")}>Download screenshot</button>
      {/if}
      {#if g.stats.artifacts.includes("pdf")}
        <button type="button" class={button({ size: "xs" })} onclick={() => saveArtifact("pdf")}>Download PDF</button>
      {/if}
    </div>
  {/if}

  {#if failure}
    <p class="font-mono text-[12px] break-words text-rose-600 dark:text-rose-400">{failure}</p>
  {/if}
</article>

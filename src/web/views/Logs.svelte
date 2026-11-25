<script lang="ts">
  import { onMount } from "svelte";
  import { Check, Copy, Hash, Search, Timer, WrapText } from "@lucide/svelte";
  import { LogViewer, filterLines, toPlainText, type LogLine, type StreamFilter } from "../lib/log-viewer/index.ts";
  import { api } from "../lib/api.ts";
  import { sources } from "../lib/sources.svelte.ts";
  import type { LogFeedState } from "../lib/log-feed.ts";
  import { PagedLogs } from "../lib/paged-logs.ts";
  import type { LogEntry } from "../../core/logs.ts";
  import Toolbar from "../components/Toolbar.svelte";
  import Segmented from "../components/Segmented.svelte";
  import Switch from "../components/Switch.svelte";
  import StatusChip from "../components/StatusChip.svelte";
  import StatusIcon from "../components/StatusIcon.svelte";
  import { button, capsule, capsuleButton, cn, footnote, notice, popup, type ChipTone } from "../lib/ui.ts";

  type Level = "all" | "warn" | "error";

  let feedState = $state<LogFeedState>({ lines: [], loading: true, live: false, capped: false, error: "" });
  let retryHistory = $state<(() => Promise<void>) | undefined>();

  let follow = $state(true);
  let stream = $state("all");
  let query = $state("");
  let level = $state<Level>("all");
  let wrap = $state(false);
  let timestamps = $state(true);
  let lineNumbers = $state(true);
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  const filterId = $props.id();
  const nf = new Intl.NumberFormat();

  // "Warnings" keeps errors too: both need attention. The level word stays in the text so copy and the text filter keep it.
  const lines = $derived(
    feedState.lines
      .filter((line) => level === "all" || (level === "warn" ? line.level !== "info" : line.level === "error"))
      .map((line) => (line.level === "info" ? line : { ...line, text: `[${line.level.toUpperCase()}] ${line.text}` })),
  );
  const shown = $derived(filterLines(lines, stream as StreamFilter, query));
  // The viewer only sees the level-filtered lines, so an empty level filter would otherwise read as "no logs yet".
  const levelEmpty = $derived(lines.length === 0 && feedState.lines.length > 0);
  const filtering = $derived(level !== "all" || stream !== "all" || query.trim().length > 0);

  const status = $derived.by((): { tone: ChipTone; label: string } => {
    if (feedState.loading) return { tone: "neutral", label: "Loading history" };
    if (!feedState.live || sources.liveNotice) return { tone: "bad", label: "Disconnected" };
    return follow ? { tone: "ok", label: "Following" } : { tone: "neutral", label: "Paused" };
  });

  const levelOf = (line: LogLine) => (line as LogEntry).level;
  const toneOf = (line: LogLine) => ({ warn: "warn", error: "error" })[levelOf(line) as "warn" | "error"] ?? (line.stream === "system" ? "system" : "plain");

  async function copyVisible() {
    try {
      await navigator.clipboard.writeText(toPlainText(shown, { timestamps, seq: lineNumbers }));
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 1500);
    } catch {
      copied = false;
    }
  }

  onMount(() => {
    let stopped = false;
    let leave: (() => void) | undefined;
    const feed = new PagedLogs((before, signal) => api(`/api/logs?${before === null ? 'tail=1' : `before=${before}`}&limit=1000`, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }), (next) => { feedState = next; });
    retryHistory = async () => {
      await feed.load();
      if (!stopped && !feed.state.error) leave ??= sources.live.logs(() => feed.after, entries => feed.append(entries));
    };
    void retryHistory();
    return () => { stopped = true; leave?.(); clearTimeout(copyTimer); feed.dispose(); };
  });
</script>

<Toolbar class="h-auto min-h-[52px] flex-wrap py-2">
  <label class={capsule({ class: "w-[260px] max-w-full gap-2 px-3" })}>
    <Search size={15} class="shrink-0 text-label2" aria-hidden="true" />
    <input id={filterId} type="search" bind:value={query} placeholder="Filter lines" aria-label="Filter lines"
      class="h-full min-w-0 flex-1 bg-transparent font-mono text-[13px] text-label placeholder:font-sans placeholder:text-label2 focus:outline-none" />
    <kbd class="font-sans text-[11px] text-label2" title="Press / to filter">/</kbd>
  </label>
  <select class={popup({ class: "h-[30px] rounded-full" })} aria-label="Stream" bind:value={stream}>
    <option value="all">All Streams</option>
    <option value="stdout">stdout</option>
    <option value="stderr">stderr</option>
    <option value="system">system</option>
  </select>
  <Segmented label="Level" bind:value={level} options={[{ value: "all", label: "All" }, { value: "warn", label: "Warnings" }, { value: "error", label: "Errors" }]} />
  <span class="flex-1"></span>
  <span class={footnote} aria-live="polite">
    {filtering ? `${nf.format(shown.length)} of ${nf.format(feedState.lines.length)} lines` : `${nf.format(shown.length)} lines`}
  </span>
  <span role="status"><StatusChip tone={status.tone} label={status.label} /></span>
  <Switch bind:checked={follow} label="Follow" />
  <span class={capsule()}>
    <button type="button" class={capsuleButton({ class: cn("px-0", wrap && "bg-fill") })} aria-pressed={wrap} aria-label="Wrap long lines" title="Wrap long lines" onclick={() => (wrap = !wrap)}><WrapText size={15} /></button>
    <button type="button" class={capsuleButton({ class: cn("px-0", timestamps && "bg-fill") })} aria-pressed={timestamps} aria-label="Show timestamps" title="Show timestamps" onclick={() => (timestamps = !timestamps)}><Timer size={15} /></button>
    <button type="button" class={capsuleButton({ class: cn("px-0", lineNumbers && "bg-fill") })} aria-pressed={lineNumbers} aria-label="Show line numbers" title="Show line numbers" onclick={() => (lineNumbers = !lineNumbers)}><Hash size={15} /></button>
    <button type="button" class={capsuleButton({ class: "px-0" })} aria-label={copied ? "Copied" : "Copy visible lines"} title={copied ? "Copied" : "Copy visible lines"} onclick={copyVisible}>
      {#if copied}<Check size={15} />{:else}<Copy size={15} />{/if}
    </button>
  </span>
</Toolbar>

<div class="flex min-h-0 flex-1 flex-col gap-2 pr-4 pb-4 pl-5">
  {#if feedState.error}
    <div role="alert" class={notice({ tone: "bad", class: "items-center" })}>
      <StatusIcon tone="bad" />
      <span class="flex-1">{feedState.error} Previously loaded lines remain visible.</span>
      <button type="button" class={button({ size: "xs" })} onclick={() => retryHistory?.()}>Retry</button>
    </div>
  {/if}
  <div class="docify-logs min-h-0 flex-1 overflow-hidden rounded-[10px] bg-surface">
    <LogViewer {lines} loadOlder={retryHistory} live={feedState.live && !sources.liveNotice} loading={feedState.loading} capped={feedState.capped} showSource={true} labelOf={(source: string) => source}
      chrome={false} height="none" bind:follow bind:stream bind:query bind:wrap bind:timestamps bind:lineNumbers filterInputId={filterId} {toneOf}
      labels={{ cappedNotice: "Older lines were dropped. Only the latest 10,000 lines are retained." }}
      emptyTitle={levelEmpty ? (level === "error" ? "No errors" : "No warnings or errors") : "No application logs yet"}
      emptyDescription={levelEmpty ? "Choose All to see every line." : "Add or prepare a source to see progress, warnings and Graphify output here. Earlier runs were not recorded."}>
      {#snippet marker(line)}
        {#if levelOf(line) === "warn"}<StatusIcon tone="warn" size={13} />{:else if levelOf(line) === "error"}<StatusIcon tone="bad" size={13} />{/if}
      {/snippet}
    </LogViewer>
  </div>
  <p class={cn(footnote, "px-1")}>Docify activity and Graphify output from the CLI and the web UI. Showing the latest 1,000 lines initially. Scroll up for older entries. End returns to live updates.</p>
</div>

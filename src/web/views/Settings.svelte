<script lang="ts">
  import { onMount } from "svelte";
  import { Check, ChevronDown } from "@lucide/svelte";
  import ConfirmDialog from "../components/ConfirmDialog.svelte";
  import Group from "../components/Group.svelte";
  import Row from "../components/Row.svelte";
  import Segmented from "../components/Segmented.svelte";
  import StatusIcon from "../components/StatusIcon.svelte";
  import Switch from "../components/Switch.svelte";
  import Toolbar from "../components/Toolbar.svelte";
  import { api, ApiError, downloadBackup, errorText, uploadBackup, type ConfigDescription, type EditableConfig, type PathSetting, type PinsView } from "../lib/api.ts";
  import { graphChanges, graphErrors, graphForm, type GraphForm, type GraphKey } from "../lib/graph-settings.ts";
  import { button, cn, footnote, input, notice as noticeStyle, popup } from "../lib/ui.ts";

  type Provider = EditableConfig["embeddingProvider"];
  type Form = Omit<EditableConfig, "graph"> & { graphEnabled: boolean; graph: GraphForm };

  const SCALAR_KEYS = [
    "embeddingProvider",
    "embeddingModel",
    "embeddingDims",
    "embeddingQueryPrefix",
    "embeddingUrl",
    "embeddingBaseUrlEnv",
    "embeddingApiKeyEnv",
    "embeddingTimeoutSeconds",
    "strongVectorSim",
    "weakVectorSim",
    "lexicalWeight",
    "keepGenerations",
    "crawlProvider",
    "maxTotalMb",
    "crawl4aiUrl",
    "crawl4aiApiKeyEnv",
    "crawl4aiTimeoutSeconds",
    "browserlessUrl",
    "browserlessApiKeyEnv",
    "browserlessTimeoutSeconds",
  ] as const;
  type FieldKey = Exclude<(typeof SCALAR_KEYS)[number], "embeddingProvider" | "crawlProvider"> | "maxPages" | "maxDepth";

  const providers: { value: Provider; label: string }[] = [
    { value: "transformers", label: "Built-in" },
    { value: "ollama", label: "Ollama" },
    { value: "openai", label: "LiteLLM (OpenAI API)" },
  ];

  const crawlProviders: { value: EditableConfig["crawlProvider"]; label: string }[] = [
    { value: "builtin", label: "Built-in" },
    { value: "crawl4ai", label: "Crawl4AI server" },
  ];

  // One section at a time; the first five fit the segmented control, the rest sit behind "More".
  const SECTIONS = [
    { id: "embeddings", title: "Embeddings", description: "How documents and queries are turned into vectors. Applies to the next preparation and to vector search." },
    { id: "search", title: "Search Quality", description: "Evidence thresholds and fusion weight. Measured values are in docs/evaluation.md." },
    { id: "crawling", title: "Web Crawling", description: "How URL sources are fetched when preparing. Local folders are always read from disk." },
    { id: "graph", title: "Semantic Graph", description: "Optional Graphify knowledge graph built while preparing. It calls an LLM through the variables below." },
    { id: "storage", title: "Storage", description: "Where Docify keeps its data. Paths that run or load code can only be changed in config.json or the environment." },
    { id: "environment", title: "Environment", description: "Variables this server process started with. Change them where you start docify serve, then restart it." },
    { id: "pins", title: "Project Pins", description: "Versions used when a search names a library without a version. Saved right away to .docify.json." },
    {
      id: "backup",
      title: "Backup",
      description:
        "Export the whole store (sources, prepared snapshots, settings) to one file, or replace this store with one. Models and the Graphify runtime are not included; run docify setup on a new machine.",
    },
  ] as const;
  type SectionId = (typeof SECTIONS)[number]["id"];
  const MAIN_SECTIONS = SECTIONS.slice(0, 5).map((s) => ({ value: s.id as SectionId, label: s.title }));
  const MORE_SECTIONS = SECTIONS.slice(5);
  const inMore = $derived(MORE_SECTIONS.some((s) => s.id === section));
  let moreOpen = $state(false);
  let moreRoot: HTMLElement | undefined = $state();
  function closeMoreOutside(event: MouseEvent) {
    if (moreOpen && moreRoot && !moreRoot.contains(event.target as Node)) moreOpen = false;
  }
  function pickMore(id: SectionId) {
    moreOpen = false;
    go(id);
  }
  // Sections whose fields Save and Revert apply to.
  const CONFIG_SECTIONS: SectionId[] = ["embeddings", "search", "crawling", "graph", "storage"];
  const SECTION_KEY = "docify-settings-section";

  function loadSection(): SectionId {
    try {
      const saved = sessionStorage.getItem(SECTION_KEY);
      if (SECTIONS.some((s) => s.id === saved)) return saved as SectionId;
    } catch {
      // storage blocked: start at the first section
    }
    return "embeddings";
  }

  let section = $state<SectionId>(loadSection());
  const current = $derived(SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]);

  function go(id: SectionId) {
    section = id;
    try {
      sessionStorage.setItem(SECTION_KEY, id);
    } catch {
      // the section is then not kept across reloads
    }
  }

  // Which section shows a field, so an error elsewhere can point there.
  function sectionOf(key: string): SectionId {
    if (key.startsWith("graph")) return "graph";
    if (key.startsWith("embedding")) return "embeddings";
    if (key.startsWith("crawl") || key.startsWith("browserless") || key === "maxPages" || key === "maxDepth" || key === "maxTotalMb") return "crawling";
    if (key === "keepGenerations") return "storage";
    return "search";
  }
  const titleOf = (id: SectionId) => SECTIONS.find((s) => s.id === id)?.title ?? id;

  let desc = $state<ConfigDescription | null>(null);
  let form = $state<Form | null>(null);
  let loadError = $state("");
  let saveError = $state<{ message: string; field: string | null } | null>(null);
  let justSaved = $state(false);
  let identityNote = $state("");
  let presetNote = $state("");
  let saving = $state(false);

  let pins = $state<PinsView | null>(null);
  let pinLibrary = $state("");
  let pinVersion = $state("");
  let pinError = $state("");
  let pinBusy = $state(false);

  let backupBusy = $state(false);
  let backupNote = $state("");
  let backupError = $state("");
  let importFile = $state<File | null>(null);
  let importForce = $state(false);
  let importKeepConfig = $state(false);
  let confirmImport = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);

  async function exportBackup() {
    backupBusy = true;
    backupError = backupNote = "";
    try {
      backupNote = `Saved ${await downloadBackup()}`;
    } catch (err) {
      backupError = errorText(err);
    } finally {
      backupBusy = false;
    }
  }

  async function importBackup() {
    if (!importFile) return;
    backupBusy = true;
    backupError = backupNote = "";
    try {
      const r = await uploadBackup(importFile, { force: importForce, keepConfig: importKeepConfig });
      const aside = r.movedAside ? ` The previous store is in ${r.movedAside}.` : "";
      backupNote = `Imported ${r.sources.length} source(s) from a backup made ${new Date(r.createdAt).toLocaleString()}.${aside} Restart docify mcp clients so they read it.`;
      importFile = null;
      if (fileInput) fileInput.value = "";
      await load();
    } catch (err) {
      backupError = errorText(err);
    } finally {
      backupBusy = false;
    }
  }

  const importMessage = $derived(
    importFile ? `Replace this Docify store with ${importFile.name}?${importForce ? " The current store is moved aside, not deleted." : ""}` : "",
  );

  function toForm(d: ConfigDescription): Form {
    const values = JSON.parse(JSON.stringify(d.values)) as EditableConfig;
    return { ...values, graphEnabled: values.graph !== null, graph: graphForm(d.defaults.graph, values.graph) };
  }

  function apply(d: ConfigDescription) {
    desc = d;
    form = toForm(d);
  }

  // Same rule as embeddingIdentity() in src/core/embed.ts.
  const identity = (c: { embeddingProvider: Provider; embeddingModel: string }) =>
    c.embeddingProvider === "transformers" ? c.embeddingModel : `${c.embeddingProvider}:${c.embeddingModel}`;

  const patch = $derived.by(() => {
    const out: Record<string, unknown> = {};
    if (!form || !desc) return out;
    for (const key of SCALAR_KEYS) if (form[key] !== desc.values[key]) out[key] = form[key];
    for (const key of ["maxPages", "maxDepth"] as const) if (form[key] !== desc.values[key]) out[key] = form[key];
    const before = desc.values.graph;
    if (!form.graphEnabled) {
      if (before !== null) out.graph = null;
    } else {
      const changed = graphChanges(form.graph, before === null ? null : graphForm(desc.defaults.graph, before));
      if (Object.keys(changed).length) out.graph = changed;
    }
    return out;
  });
  const dirty = $derived(Object.keys(patch).length > 0);

  const clientErrors = $derived.by(() => {
    const e: Record<string, string> = {};
    if (!form) return e;
    for (const key of ["embeddingDims", "embeddingTimeoutSeconds", "strongVectorSim", "weakVectorSim", "lexicalWeight", "keepGenerations", "crawl4aiTimeoutSeconds", "browserlessTimeoutSeconds"] as const) {
      if (typeof form[key] !== "number" || Number.isNaN(form[key])) e[key] = "enter a number";
    }
    for (const [key, min, max] of [["maxPages", 1, 100000], ["maxDepth", 0, 1000], ["maxTotalMb", 1, 1000]] as const) {
      if (!Number.isSafeInteger(form[key]) || form[key] < min || form[key] > max) e[key] = `enter a whole number from ${min} to ${max}`;
    }
    if (form.graphEnabled) Object.assign(e, graphErrors(form.graph));
    if (!e.strongVectorSim && !e.weakVectorSim && form.weakVectorSim > form.strongVectorSim) e.weakVectorSim = "must not be above strong match similarity";
    return e;
  });
  const fieldError = (key: string) => clientErrors[key] ?? (saveError?.field === key ? saveError.message : null);
  const fieldId = (key: string) => `setting-${key.replace(".", "-")}`;

  // The first invalid field outside the shown section, so the toolbar can point to it.
  const errorElsewhere = $derived.by(() => {
    const keys = Object.keys(clientErrors);
    if (saveError?.field) keys.push(saveError.field);
    const other = keys.map(sectionOf).find((s) => s !== section);
    return other ?? null;
  });

  const pathRows = $derived(
    desc
      ? [
          { label: "Store", value: desc.paths.home, note: "" },
          { label: "Config", value: desc.paths.configFile, note: "" },
          { label: "Graphify", value: desc.paths.graphifyBin.value, note: sourceLabel(desc.paths.graphifyBin) },
          { label: "Models", value: desc.paths.modelsDir.value, note: sourceLabel(desc.paths.modelsDir) },
        ]
      : [],
  );

  const identityChanged = $derived(!!form && !!desc && identity(form) !== identity(desc.values));
  const remoteEmbeddings = $derived.by(() => {
    if (!form) return false;
    if (form.embeddingProvider === "openai") return true;
    if (form.embeddingProvider !== "ollama") return false;
    try {
      return !["localhost", "127.0.0.1", "[::1]"].includes(new URL(form.embeddingUrl).hostname);
    } catch {
      return false;
    }
  });

  function envStatus(name: string | undefined): { tone: "ok" | "warn" | null; label: string } {
    const entry = desc?.environment.find((e) => e.name === name);
    if (!name) return { tone: null, label: "No variable" };
    if (!entry) return { tone: null, label: "Save to check" };
    return entry.set ? { tone: "ok", label: "Set" } : { tone: "warn", label: "Not set" };
  }

  function sourceLabel(p: PathSetting) {
    return p.source === "environment" ? `from ${p.variable}` : p.source === "config.json" ? "from config.json" : "default";
  }

  // Starting values measured in docs/evaluation.md.
  function onProvider(p: Provider) {
    if (!form || !desc) return;
    if (p === "transformers") {
      const d = desc.defaults;
      Object.assign(form, { embeddingModel: d.embeddingModel, embeddingDims: d.embeddingDims, embeddingQueryPrefix: d.embeddingQueryPrefix, strongVectorSim: d.strongVectorSim, weakVectorSim: d.weakVectorSim });
      presetNote = `Built-in defaults applied: ${d.embeddingModel}, ${d.embeddingDims} dimensions, thresholds ${d.strongVectorSim} / ${d.weakVectorSim}.`;
    } else {
      Object.assign(form, { embeddingModel: "bge-m3", embeddingDims: 1024, embeddingQueryPrefix: "", strongVectorSim: 0.58, weakVectorSim: 0.48 });
      presetNote = "Measured bge-m3 values applied: 1024 dimensions, no prefix, thresholds 0.58 / 0.48. Change the model if your server runs another one.";
    }
  }

  async function load() {
    loadError = "";
    try {
      apply(await api<ConfigDescription>("/api/config"));
    } catch (err) {
      loadError = errorText(err);
    }
    try {
      pins = await api<PinsView>("/api/pins");
    } catch (err) {
      pinError = errorText(err);
    }
  }

  onMount(load);

  function revert() {
    if (desc) form = toForm(desc);
    saveError = null;
    presetNote = "";
  }

  async function save() {
    if (!desc || Object.keys(clientErrors).length) return;
    saving = true;
    saveError = null;
    justSaved = false;
    identityNote = "";
    const before = identity(desc.values);
    try {
      const next = await api<ConfigDescription>("/api/config", { method: "PUT", body: $state.snapshot(patch) });
      apply(next);
      presetNote = "";
      const after = identity(next.values);
      justSaved = true;
      if (after !== before) identityNote = `Embeddings changed to ${after}. Prepare every source again; until then search skips vector mode for them.`;
    } catch (err) {
      saveError = err instanceof ApiError ? { message: err.message, field: err.field } : { message: errorText(err), field: null };
    } finally {
      saving = false;
    }
  }

  async function setPin(library: string, version: string | null) {
    pinBusy = true;
    pinError = "";
    try {
      pins = await api<PinsView>("/api/pins", { method: "PUT", body: { library, version } });
      if (version) pinLibrary = pinVersion = "";
    } catch (err) {
      pinError = errorText(err);
    } finally {
      pinBusy = false;
    }
  }

  const showSave = $derived(!!form && (CONFIG_SECTIONS.includes(section) || dirty));
</script>

{#snippet errorLine(key: string)}
  {#if fieldError(key)}<p id="{fieldId(key)}-error" class="mt-1 text-[11px] leading-[14px] font-medium text-bad-text">{fieldError(key)}</p>{/if}
{/snippet}

{#snippet envTag(name: string | undefined)}
  {@const s = envStatus(name)}
  {#if s.tone}
    <span class={cn("inline-flex w-[72px] shrink-0 items-center gap-1 text-[13px] font-medium whitespace-nowrap", s.tone === "ok" ? "text-ok-text" : "text-warn-text")}>
      <StatusIcon tone={s.tone} size={13} />{s.label}
    </span>
  {:else}
    <span class="w-[72px] shrink-0 text-[11px] leading-[14px] text-label2">{s.label}</span>
  {/if}
{/snippet}

{#snippet field(f: Form, key: FieldKey, label: string, opts: { sub?: string; number?: boolean; min?: string; max?: string; step?: string; unit?: string; mono?: boolean; width?: string; placeholder?: string; env?: boolean })}
  {@const err = fieldError(key)}
  <Row {label} sub={opts.sub} for={fieldId(key)}>
    <div class={cn("flex shrink-0 flex-col items-end", opts.width ?? "w-[260px] max-w-[55%]")}>
      <div class="flex w-full items-center gap-2">
        {#if opts.number}
          <input
            id={fieldId(key)}
            type="number"
            min={opts.min}
            max={opts.max}
            step={opts.step}
            aria-invalid={!!err}
            aria-describedby={err ? `${fieldId(key)}-error` : undefined}
            class={input({ mono: true, invalid: !!err, class: "text-right" })}
            bind:value={f[key]}
          />
        {:else}
          <input
            id={fieldId(key)}
            placeholder={opts.placeholder}
            aria-invalid={!!err}
            aria-describedby={err ? `${fieldId(key)}-error` : undefined}
            class={input({ mono: opts.mono ?? true, invalid: !!err })}
            bind:value={f[key]}
          />
        {/if}
        {#if opts.unit}<span class={footnote}>{opts.unit}</span>{/if}
        {#if opts.env}{@render envTag(f[key] as string | undefined)}{/if}
      </div>
      {@render errorLine(key)}
    </div>
  </Row>
{/snippet}

{#snippet graphField(g: GraphForm, key: Exclude<GraphKey, "disableThinking" | "allowPartial">, label: string, opts: { sub?: string; number?: boolean; min?: string; max?: string; step?: string; unit?: string; width?: string; placeholder?: string; env?: boolean })}
  {@const k = `graph.${key}`}
  {@const err = fieldError(k)}
  <Row {label} sub={opts.sub} for={fieldId(k)}>
    <div class={cn("flex shrink-0 flex-col items-end", opts.width ?? "w-[260px] max-w-[55%]")}>
      <div class="flex w-full items-center gap-2">
        {#if opts.number}
          <input
            id={fieldId(k)}
            type="number"
            min={opts.min}
            max={opts.max}
            step={opts.step}
            placeholder={opts.placeholder}
            aria-invalid={!!err}
            aria-describedby={err ? `${fieldId(k)}-error` : undefined}
            class={input({ mono: true, invalid: !!err, class: "text-right" })}
            bind:value={g[key]}
          />
        {:else}
          <input id={fieldId(k)} aria-invalid={!!err} class={input({ mono: true, invalid: !!err })} bind:value={g[key]} />
        {/if}
        {#if opts.unit}<span class={footnote}>{opts.unit}</span>{/if}
        {#if opts.env}{@render envTag(g[key] as string | undefined)}{/if}
      </div>
      {@render errorLine(k)}
    </div>
  </Row>
{/snippet}

{#snippet warnLine(text: string)}
  <p class={cn(footnote, "mx-3.5 mt-2.5 flex items-start gap-1.5")}><StatusIcon tone="warn" size={12} class="mt-px" />{text}</p>
{/snippet}

<svelte:window onclick={closeMoreOutside} onkeydown={(e) => e.key === "Escape" && (moreOpen = false)} />

<div class="flex min-h-0 flex-1 flex-col">
  <Toolbar>
    <!-- Wide windows: five segments plus "More". Narrow ones: one popup with all eight. -->
    <div class="hidden xl:flex">
      <Segmented options={MAIN_SECTIONS} value={section} label="Settings section" onchange={go}>
        {#snippet trailing()}
          <div class="relative" bind:this={moreRoot}>
            <button
              type="button"
              class={cn(
                "flex h-6 items-center gap-1 rounded-md px-3 text-[13px] font-medium text-label transition-colors focus-visible:ring-[3px] focus-visible:ring-accent-soft focus-visible:outline-none",
                inMore ? "bg-seg-on shadow-[0_1px_2px_rgb(0_0_0/0.15)]" : "hover:bg-surface/50",
              )}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onclick={() => (moreOpen = !moreOpen)}
            >
              {inMore ? titleOf(section) : "More"}<ChevronDown size={12} strokeWidth={2} />
            </button>
            {#if moreOpen}
              <div role="menu" class="absolute top-[calc(100%+6px)] right-0 z-20 min-w-[200px] rounded-[10px] border border-sep bg-surface p-1 shadow-float">
                {#each MORE_SECTIONS as s (s.id)}
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={section === s.id}
                    class="flex h-7 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-label hover:bg-accent hover:text-white"
                    onclick={() => pickMore(s.id)}
                  >
                    <span class="flex w-3 shrink-0 justify-center">{#if section === s.id}<Check size={12} strokeWidth={2.5} />{/if}</span>{s.title}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/snippet}
      </Segmented>
    </div>
    <select
      aria-label="Settings section"
      class={popup({ class: "xl:hidden" })}
      value={section}
      onchange={(ev) => go((ev.currentTarget as HTMLSelectElement).value as SectionId)}
    >
      {#each SECTIONS as s (s.id)}<option value={s.id}>{s.title}</option>{/each}
    </select>

    <span class="flex-1"></span>

    <span class="flex min-w-0 items-center gap-1.5" role="status">
      {#if saveError}
        <StatusIcon tone="bad" size={12} />
        <span class={cn(footnote, "truncate text-bad-text")} title={saveError.message}>Not saved</span>
      {:else if errorElsewhere}
        <button type="button" class={button({ intent: "link", size: "xs" })} onclick={() => errorElsewhere && go(errorElsewhere)}>Check {titleOf(errorElsewhere)}</button>
      {:else if dirty}
        <span class={footnote}>Unsaved changes</span>
      {:else if justSaved}
        <StatusIcon tone="ok" size={12} /><span class={footnote}>Saved</span>
      {/if}
    </span>
    {#if showSave}
      <button type="button" class={button({ size: "md" })} disabled={!dirty || saving} onclick={revert}>Revert</button>
      <button type="button" class={button({ intent: "primary", size: "md" })} disabled={!dirty || saving || Object.keys(clientErrors).length > 0} onclick={save}
        >{saving ? "Saving" : "Save"}</button
      >
    {/if}
  </Toolbar>

  <div class="min-h-0 flex-1 overflow-y-auto px-8 pt-1 pb-10 max-sm:px-4">
    <div class="mx-auto w-full max-w-[720px]">
      <h1 class="text-[26px] leading-[32px] font-bold tracking-[-0.01em]">{current.title}</h1>
      <p class="mt-1 text-[13px] leading-[18px] text-label2">{current.description}</p>

      {#if saveError}
        <div class={noticeStyle({ tone: "bad", class: "mt-4" })} role="alert">
          <StatusIcon tone="bad" class="mt-0.5" />
          <span class="min-w-0 break-words">{saveError.message}</span>
        </div>
      {/if}
      {#if identityNote}
        <div class={noticeStyle({ tone: "warn", class: "mt-4" })} role="status">
          <StatusIcon tone="warn" class="mt-0.5" />
          <span>{identityNote}</span>
        </div>
      {/if}

      {#if section === "pins"}
        {#if pins}
          <Group title="Project">
            <Row label="Folder">
              <span class="max-w-[60%] truncate font-mono text-[12px] text-label2" title={pins.project}>{pins.project}</span>
            </Row>
            <Row label="Pin file">
              {#if pins.file}
                <span class="max-w-[60%] truncate font-mono text-[12px] text-label2" title={pins.file}>{pins.file}</span>
              {:else}
                <span class={cn(footnote, "max-w-[60%] text-right")}>None yet; the first pin creates .docify.json in the project</span>
              {/if}
            </Row>
          </Group>

          <Group title="Pins">
            {#each Object.entries(pins.pins) as [lib, ver] (lib)}
              <Row>
                {#snippet leading()}
                  <span class="min-w-0 flex-1 truncate font-mono text-[13px]">{lib}<span class="text-label2">@</span>{ver}</span>
                {/snippet}
                <button type="button" class={button({ size: "xs" })} disabled={pinBusy} onclick={() => setPin(lib, null)}>Unpin</button>
              </Row>
            {:else}
              <Row label="No pins" sub="Searches use every prepared version unless a version is given." />
            {/each}
          </Group>

          <Group title="Add pin">
            <form
              class="contents"
              onsubmit={(ev) => {
                ev.preventDefault();
                setPin(pinLibrary, pinVersion);
              }}
            >
              <Row>
                {#snippet leading()}
                  <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <input class={input({ mono: true, class: "w-40 flex-none" })} placeholder="library" aria-label="Library to pin" required bind:value={pinLibrary} />
                    <input class={input({ mono: true, class: "w-28 flex-none" })} placeholder="version" aria-label="Version to pin" required bind:value={pinVersion} />
                  </div>
                {/snippet}
                <button type="submit" class={button({ intent: "primary" })} disabled={pinBusy}>Pin</button>
              </Row>
            </form>
          </Group>
        {/if}
        {#if pinError}
          <div class={noticeStyle({ tone: "bad", class: "mt-4" })} role="alert">
            <StatusIcon tone="bad" class="mt-0.5" /><span class="min-w-0 break-words">{pinError}</span>
          </div>
        {/if}
      {:else if section === "backup"}
        <Group title="Export">
          <Row label="Export store" sub="Downloads one .tar.gz file. Fails while a source is being prepared.">
            <button type="button" class={button()} disabled={backupBusy} onclick={exportBackup}>Export Store</button>
          </Row>
        </Group>

        <Group title="Import" hint="Importing replaces this store. Restart docify mcp clients afterwards so they read it.">
          <Row label="Backup file" for="backup-file">
            <input
              id="backup-file"
              bind:this={fileInput}
              type="file"
              accept=".tar.gz,.tgz,application/gzip"
              class="max-w-[60%] min-w-0 text-[13px] text-label2 file:mr-3 file:h-6 file:rounded-md file:border file:border-sep file:bg-surface file:px-3 file:text-[13px] file:font-medium file:text-label"
              onchange={(ev) => (importFile = (ev.currentTarget as HTMLInputElement).files?.[0] ?? null)}
            />
          </Row>
          <Row label="Replace a store that already has sources" sub="The current store is moved aside, not deleted.">
            <Switch bind:checked={importForce} label="Replace a store that already has sources" hideLabel />
          </Row>
          <Row label="Keep this machine's settings">
            <Switch bind:checked={importKeepConfig} label="Keep this machine's settings" hideLabel />
          </Row>
          <Row label="">
            <button type="button" class={button({ intent: "danger" })} disabled={backupBusy || !importFile} onclick={() => (confirmImport = true)}>Import…</button>
          </Row>
        </Group>

        {#if backupNote}
          <p class={cn(footnote, "mx-3.5 mt-3 flex items-start gap-1.5 break-words")} role="status"><StatusIcon tone="ok" size={12} class="mt-px" />{backupNote}</p>
        {/if}
        {#if backupError}
          <div class={noticeStyle({ tone: "bad", class: "mt-4" })} role="alert">
            <StatusIcon tone="bad" class="mt-0.5" /><span class="min-w-0 break-words">{backupError}</span>
          </div>
        {/if}
      {:else if loadError}
        <div class={noticeStyle({ tone: "bad", class: "mt-6 flex-col gap-1" })} role="alert">
          <p class="flex items-center gap-2 font-medium"><StatusIcon tone="bad" />Settings could not be read.</p>
          <p class="font-mono text-[12px] break-words">{loadError}</p>
          <p class="mt-1">Fix or remove the file, then reload this page. Nothing was changed.</p>
        </div>
      {:else if !form || !desc}
        <p class={cn(footnote, "mt-6 text-[13px]")}>Loading settings…</p>
      {:else if section === "embeddings"}
        <Group title="Provider" hint="Changing the embedding model means every source must be prepared again; until then search skips vector mode for them.">
          <Row label="Embedding provider">
            <Segmented options={providers} bind:value={form.embeddingProvider} label="Embedding provider" onchange={onProvider} />
          </Row>
          {@render field(form, "embeddingModel", "Model", {})}
          {@render field(form, "embeddingDims", "Dimensions", { number: true, min: "1", step: "1" })}
          {@render field(form, "embeddingQueryPrefix", "Query prefix", { sub: "Added before every query", placeholder: "None" })}
          {#if form.embeddingProvider === "ollama"}
            {@render field(form, "embeddingUrl", "Ollama URL", { sub: desc.inFile.includes("embeddingUrl") ? "From config.json" : "Default, or DOCIFY_EMBED_URL when set" })}
          {/if}
          {#if form.embeddingProvider === "openai"}
            {@render field(form, "embeddingTimeoutSeconds", "Request timeout", { number: true, min: "1", unit: "seconds", width: "w-[140px]" })}
          {/if}
          {#snippet footer()}
            {#if presetNote}<p class={cn(footnote, "mx-3.5 mt-1.5")}>{presetNote}</p>{/if}
            {#if identityChanged}{@render warnLine("The model changes when you save. Prepare every source again afterwards.")}{/if}
          {/snippet}
        </Group>

        {#if form.embeddingProvider === "openai"}
          <Group title="Server environment" hint="Only variable names are stored, never values. The server reads them when it starts.">
            {@render field(form, "embeddingBaseUrlEnv", "Base URL variable", { sub: "Name only. The value stays in the environment.", env: true, width: "w-[310px] max-w-[60%]" })}
            {@render field(form, "embeddingApiKeyEnv", "API key variable", { env: true, width: "w-[310px] max-w-[60%]" })}
          </Group>
        {/if}

        {#if remoteEmbeddings}{@render warnLine("Every search sends the query to this server.")}{/if}
      {:else if section === "search"}
        <Group title="Evidence thresholds">
          {@render field(form, "strongVectorSim", "Strong match similarity", { sub: "0 to 1, measured for bge models", number: true, min: "0", max: "1", step: "0.01", width: "w-[120px]" })}
          {@render field(form, "weakVectorSim", "Weak match similarity", { sub: "0 to 1, at most the strong value", number: true, min: "0", max: "1", step: "0.01", width: "w-[120px]" })}
        </Group>
        <Group title="Fusion">
          {@render field(form, "lexicalWeight", "Lexical weight", { sub: "Weight of word matches in combined search", number: true, min: "0", step: "0.1", width: "w-[120px]" })}
        </Group>
      {:else if section === "crawling"}
        <Group title="Default crawler" hint="Used for URL sources without their own crawler selection.">
          <Row label="Crawler">
            <Segmented options={crawlProviders} bind:value={form.crawlProvider} label="Default crawl provider" />
          </Row>
        </Group>
        <Group title="Crawl limits" hint="Defaults for URL sources. Individual sources can override these limits.">
          {@render field(form, "maxPages", "Max pages", { number: true, min: "1", max: "100000", step: "1", width: "w-[140px]" })}
          {@render field(form, "maxDepth", "Max depth", { sub: "0 fetches only the start page", number: true, min: "0", max: "1000", step: "1", width: "w-[140px]" })}
          {@render field(form, "maxTotalMb", "Max total size", { sub: "Total downloaded content per URL source; larger limits use more memory", number: true, min: "1", max: "1000", step: "1", unit: "MB", width: "w-[140px]" })}
        </Group>
        <Group
          title="Crawl4AI"
          hint="Docify still decides which pages to crawl, but the server's browser loads each page with its scripts and subrequests. Pages that end up outside the source are dropped after rendering, not prevented. If the server fails, preparing fails and the previous version keeps serving."
        >
          {@render field(form, "crawl4aiUrl", "Server URL", { sub: "The server's base URL, without credentials" })}
          {@render field(form, "crawl4aiApiKeyEnv", "Token variable", { sub: "Name only. The value stays in the environment.", env: true, width: "w-[310px] max-w-[60%]" })}
          {@render field(form, "crawl4aiTimeoutSeconds", "Page timeout", { number: true, min: "1", unit: "seconds", width: "w-[140px]" })}
        </Group>
        <Group title="Browserless">
          {@render field(form, "browserlessUrl", "Server URL", { sub: "Base URL without credentials or query parameters" })}
          {@render field(form, "browserlessApiKeyEnv", "Token variable", { sub: "Name only. The value stays in the environment.", env: true, width: "w-[310px] max-w-[60%]" })}
          {@render field(form, "browserlessTimeoutSeconds", "Page timeout", { number: true, min: "1", unit: "seconds", width: "w-[140px]" })}
        </Group>
      {:else if section === "graph"}
        <Group>
          <Row label="Build a graph when preparing">
            <Switch bind:checked={form.graphEnabled} label="Build a graph when preparing" hideLabel />
          </Row>
        </Group>
        {#if form.graphEnabled}
          <Group title="Model">
            {@render graphField(form.graph, "backend", "Backend", {})}
            {@render graphField(form.graph, "model", "Model", {})}
            {@render graphField(form.graph, "baseUrlSuffix", "Base URL suffix", { sub: "Appended to the base URL" })}
          </Group>
          <Group title="Server environment" hint="Only variable names are stored, never values.">
            {@render graphField(form.graph, "baseUrlEnv", "Base URL variable", { env: true, width: "w-[310px] max-w-[60%]" })}
            {@render graphField(form.graph, "apiKeyEnv", "API key variable", { env: true, width: "w-[310px] max-w-[60%]" })}
          </Group>
          <Group title="Graphify runtime" hint="Changes apply on the next forced preparation. Use force prepare to rebuild existing graphs with these settings.">
            <Row label="Mode" for="setting-graph-mode">
              <select id="setting-graph-mode" class={popup()} bind:value={form.graph.mode}>
                <option value="standard">Standard</option>
                <option value="deep">Deep</option>
              </select>
            </Row>
            {@render graphField(form.graph, "tokenBudget", "Token budget", { sub: "Default: 60000", number: true, min: "1", step: "1", width: "w-[140px]" })}
            {@render graphField(form.graph, "apiTimeoutSeconds", "API timeout", { sub: "Default: 600 seconds", number: true, min: "1", step: "1", unit: "seconds", width: "w-[140px]" })}
            {@render graphField(form.graph, "maxWorkers", "Max workers", { sub: "Leave blank for automatic selection", number: true, min: "1", step: "1", placeholder: "Automatic", width: "w-[140px]" })}
          </Group>
          <Group title="Model requests" hint="Leave a field blank to use Graphify's default for the backend and model.">
            {@render graphField(form.graph, "maxOutputTokens", "Max output tokens", { sub: "Upper limit for one reply. Raise it if replies are cut off", number: true, min: "1", step: "1", placeholder: "Default", width: "w-[140px]" })}
            {@render graphField(form.graph, "temperature", "Temperature", { sub: "From 0 to 2. Lower is more repeatable", number: true, min: "0", max: "2", step: "0.1", placeholder: "Default", width: "w-[140px]" })}
            <Row label="Disable thinking" sub="Steadier runs on reasoning models, at the cost of extraction quality">
              <Switch bind:checked={form.graph.disableThinking} label="Disable thinking" hideLabel />
            </Row>
          </Group>
          <Group title="Retries" hint="More retries finish more documents and can cost more.">
            {@render graphField(form.graph, "maxRetries", "Request retries", { sub: "After a rate limit or network error. Default: 6", number: true, min: "0", max: "100", step: "1", width: "w-[140px]" })}
            {@render graphField(form.graph, "maxRetryDepth", "Split depth", { sub: "How many times a cut-off chunk is halved and retried. 0 sends each chunk once. Default: 3", number: true, min: "0", max: "10", step: "1", width: "w-[140px]" })}
            <Row label="Accept partial graph" sub="When some documents get no nodes, save the smaller graph anyway. Off keeps a larger graph from an earlier run">
              <Switch bind:checked={form.graph.allowPartial} label="Accept partial graph" hideLabel />
            </Row>
          </Group>
          <Group title="Limits">
            {@render graphField(form.graph, "maxConcurrency", "Max concurrency", { number: true, min: "1", step: "1", width: "w-[140px]" })}
            {@render graphField(form.graph, "timeoutSeconds", "Idle timeout", { sub: "Stops Graphify after this long without output. Default: 900 seconds", number: true, min: "1", unit: "seconds", width: "w-[140px]" })}
          </Group>
        {/if}
      {:else if section === "storage"}
        <Group title="Generations">
          {@render field(form, "keepGenerations", "Keep generations", { sub: "Active one plus older ones, so recent citations stay readable", number: true, min: "1", step: "1", width: "w-[120px]" })}
        </Group>
        <Group title="Paths" hint="Read-only here. Change them in config.json or the environment.">
          {#each pathRows as p (p.label)}
            <Row label={p.label} sub={p.note || undefined}>
              <span class="max-w-[70%] truncate font-mono text-[12px] text-label2" title={p.value}>{p.value}</span>
            </Row>
          {/each}
        </Group>
      {:else if section === "environment"}
        <Group title="Variables" hint="Secret values are never shown.">
          {#each desc.environment as e (e.name)}
            <Row>
              {#snippet leading()}
                <div class="min-w-0 flex-1">
                  <div class="truncate font-mono text-[12px] text-label">{e.name}</div>
                  <div class="mt-px text-[11px] leading-[14px] text-label2">{e.purpose}</div>
                </div>
              {/snippet}
              {#if e.value || e.set}
                <span class="max-w-[30%] truncate font-mono text-[12px] text-label2" title={e.value ?? undefined}>{e.value ?? "hidden"}</span>
              {/if}
              <!-- Most variables here are optional, so an unset one is neutral, not a warning. -->
              <span class={cn("inline-flex w-[72px] shrink-0 items-center gap-1 text-[13px] font-medium whitespace-nowrap", e.set ? "text-ok-text" : "text-label2")}>
                <StatusIcon tone={e.set ? "ok" : "info"} size={13} />{e.set ? "Set" : "Not set"}
              </span>
            </Row>
          {/each}
        </Group>
      {/if}

      {#if desc && CONFIG_SECTIONS.includes(section)}
        <p class={cn(footnote, "mx-3.5 mt-7")}>Saved to <span class="font-mono">{desc.paths.configFile}</span></p>
      {/if}
    </div>
  </div>
</div>

<ConfirmDialog bind:open={confirmImport} title="Replace Store?" message={importMessage} confirmLabel="Replace" onconfirm={importBackup} />

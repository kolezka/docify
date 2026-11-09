<script lang="ts">
  import { onMount } from "svelte";
  import Field from "../components/Field.svelte";
  import Segmented from "../components/Segmented.svelte";
  import SettingsGroup from "../components/SettingsGroup.svelte";
  import StatusChip from "../components/StatusChip.svelte";
  import Switch from "../components/Switch.svelte";
  import { api, ApiError, errorText, type ConfigDescription, type EditableConfig, type PathSetting, type PinsView } from "../lib/api.ts";
  import { button, input, notice as noticeStyle, type ChipTone } from "../lib/ui.ts";

  type Provider = EditableConfig["embeddingProvider"];
  type GraphForm = { backend: string; model: string; baseUrlEnv?: string; baseUrlSuffix?: string; apiKeyEnv?: string; maxConcurrency?: number; timeoutSeconds?: number };
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
    "crawl4aiUrl",
    "crawl4aiApiKeyEnv",
    "crawl4aiTimeoutSeconds",
  ] as const;
  const GRAPH_KEYS = ["backend", "model", "baseUrlEnv", "baseUrlSuffix", "apiKeyEnv", "maxConcurrency", "timeoutSeconds"] as const;

  const providers: { value: Provider; label: string }[] = [
    { value: "transformers", label: "Built-in" },
    { value: "ollama", label: "Ollama" },
    { value: "openai", label: "LiteLLM (OpenAI API)" },
  ];

  const crawlProviders: { value: EditableConfig["crawlProvider"]; label: string }[] = [
    { value: "builtin", label: "Built-in" },
    { value: "crawl4ai", label: "Crawl4AI server" },
  ];

  let desc = $state<ConfigDescription | null>(null);
  let form = $state<Form | null>(null);
  let loadError = $state("");
  let saveError = $state<{ message: string; field: string | null } | null>(null);
  let saved = $state("");
  let presetNote = $state("");
  let saving = $state(false);

  let pins = $state<PinsView | null>(null);
  let pinLibrary = $state("");
  let pinVersion = $state("");
  let pinError = $state("");
  let pinBusy = $state(false);

  function toForm(d: ConfigDescription): Form {
    const values = JSON.parse(JSON.stringify(d.values)) as EditableConfig;
    const graph = { ...(d.defaults.graph ?? { backend: "", model: "" }), ...(values.graph ?? {}) };
    return { ...values, graphEnabled: values.graph !== null, graph };
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
    const before = desc.values.graph;
    if (!form.graphEnabled) {
      if (before !== null) out.graph = null;
    } else {
      const changed: Record<string, unknown> = {};
      for (const k of GRAPH_KEYS) if (before === null || form.graph[k] !== before[k]) changed[k] = form.graph[k];
      if (Object.keys(changed).length) out.graph = changed;
    }
    return out;
  });
  const dirty = $derived(Object.keys(patch).length > 0);

  const clientErrors = $derived.by(() => {
    const e: Record<string, string> = {};
    if (!form) return e;
    for (const key of ["embeddingDims", "embeddingTimeoutSeconds", "strongVectorSim", "weakVectorSim", "lexicalWeight", "keepGenerations", "crawl4aiTimeoutSeconds"] as const) {
      if (typeof form[key] !== "number" || Number.isNaN(form[key])) e[key] = "enter a number";
    }
    if (!e.strongVectorSim && !e.weakVectorSim && form.weakVectorSim > form.strongVectorSim) e.weakVectorSim = "must not be above strong match similarity";
    return e;
  });
  const fieldError = (key: string) => clientErrors[key] ?? (saveError?.field === key ? saveError.message : null);
  const fieldId = (key: string) => `setting-${key.replace(".", "-")}`;

  const embeddingEnvFields = [
    { key: "embeddingBaseUrlEnv", label: "Base URL variable" },
    { key: "embeddingApiKeyEnv", label: "API key variable" },
  ] as const;
  const graphEnvFields = [
    { key: "baseUrlEnv", label: "Base URL variable" },
    { key: "apiKeyEnv", label: "API key variable" },
  ] as const;
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

  function envStatus(name: string | undefined): { tone: ChipTone; label: string } {
    const entry = desc?.environment.find((e) => e.name === name);
    if (!name) return { tone: "neutral", label: "no variable" };
    if (!entry) return { tone: "neutral", label: "save to check" };
    return entry.set ? { tone: "ok", label: "set in server environment" } : { tone: "warn", label: "not set" };
  }

  function sourceLabel(p: PathSetting) {
    return p.source === "environment" ? `from ${p.variable}` : p.source === "config.json" ? "from config.json" : "default";
  }

  // Starting values measured in docs/evaluation.md; apps/macos Settings.swift applies the same ones.
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
    saved = "";
    const before = identity(desc.values);
    try {
      const next = await api<ConfigDescription>("/api/config", { method: "PUT", body: $state.snapshot(patch) });
      apply(next);
      presetNote = "";
      const after = identity(next.values);
      saved = after !== before ? `Embeddings changed to ${after}. Prepare every source again; until then search skips vector mode for them.` : "Saved.";
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
</script>

<div class="min-h-0 flex-1 overflow-y-auto">
  <main class="mx-auto flex w-full max-w-[760px] flex-col gap-10 p-5 pt-8 pb-10">
    {#if loadError}
      <div class={noticeStyle({ tone: "bad" })} role="alert">
        <p class="font-medium">Settings could not be read.</p>
        <p class="mt-1 font-mono text-[12px] break-words">{loadError}</p>
        <p class="mt-2">Fix or remove the file, then reload this page. Nothing was changed.</p>
      </div>
    {:else if !form || !desc}
      <p class="text-[13px] text-zinc-500 dark:text-zinc-400">Loading settings...</p>
    {:else}
      <SettingsGroup title="Embeddings" description="How documents and queries are turned into vectors. Applies to the next preparation and to vector search.">
        <div>
          <span class="mb-2 block text-[12px] font-medium text-zinc-500 dark:text-zinc-400">Provider</span>
          <Segmented options={providers} bind:value={form.embeddingProvider} label="Embedding provider" onchange={onProvider} />
          {#if presetNote}<p class="mt-2 text-[12px] text-zinc-500 dark:text-zinc-400">{presetNote}</p>{/if}
        </div>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Model" id={fieldId("embeddingModel")} error={fieldError("embeddingModel")}>
            <input id={fieldId("embeddingModel")} class={input({ invalid: !!fieldError("embeddingModel") })} bind:value={form.embeddingModel} />
          </Field>
          <Field label="Dimensions" id={fieldId("embeddingDims")} error={fieldError("embeddingDims")}>
            <input id={fieldId("embeddingDims")} type="number" min="1" step="1" class={input({ invalid: !!fieldError("embeddingDims") })} bind:value={form.embeddingDims} />
          </Field>
          <Field label="Query prefix" id={fieldId("embeddingQueryPrefix")} error={fieldError("embeddingQueryPrefix")} hint="added before every query">
            <input id={fieldId("embeddingQueryPrefix")} placeholder="none" class={input()} bind:value={form.embeddingQueryPrefix} />
          </Field>
        </div>

        {#if form.embeddingProvider === "ollama"}
          <Field
            label="Ollama URL"
            id={fieldId("embeddingUrl")}
            error={fieldError("embeddingUrl")}
            hint={desc.inFile.includes("embeddingUrl") ? "from config.json" : "default, or DOCIFY_EMBED_URL when set"}
          >
            <input id={fieldId("embeddingUrl")} class={input({ mono: true, invalid: !!fieldError("embeddingUrl") })} bind:value={form.embeddingUrl} />
          </Field>
        {/if}

        {#if form.embeddingProvider === "openai"}
          <div class="flex flex-col gap-4 border-t border-zinc-100 pt-5 dark:border-zinc-800">
            <div>
              <p class="text-[13px] font-medium text-zinc-900 dark:text-zinc-100">Environment variables</p>
              <p class="mt-0.5 text-[12px] text-zinc-500 dark:text-zinc-400">Only variable names are stored, never values. The server reads them when it starts.</p>
            </div>
            {#each embeddingEnvFields as v (v.key)}
              {@const status = envStatus(form[v.key])}
              <Field label={v.label} id={fieldId(v.key)} error={fieldError(v.key)}>
                <div class="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
                  <input id={fieldId(v.key)} class={input({ mono: true, invalid: !!fieldError(v.key), class: "sm:w-60" })} bind:value={form[v.key]} />
                  <StatusChip tone={status.tone} label={status.label} />
                </div>
              </Field>
            {/each}
            <Field label="Request timeout (seconds)" id={fieldId("embeddingTimeoutSeconds")} error={fieldError("embeddingTimeoutSeconds")} class="sm:w-1/2">
              <input id={fieldId("embeddingTimeoutSeconds")} type="number" min="1" class={input({ invalid: !!fieldError("embeddingTimeoutSeconds") })} bind:value={form.embeddingTimeoutSeconds} />
            </Field>
          </div>
        {/if}

        <div class="flex flex-col gap-2">
          {#if remoteEmbeddings}
            <div class={noticeStyle({ tone: "warn" })}>Every search sends the query to this server.</div>
          {/if}
          <div class={noticeStyle({ tone: identityChanged ? "warn" : "info" })}>
            Changing the embedding model means every source must be prepared again; until then search skips vector mode for them.
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Search quality" description="Evidence thresholds and fusion weight. Measured values are in docs/evaluation.md.">
        <div class="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Strong match similarity" id={fieldId("strongVectorSim")} error={fieldError("strongVectorSim")} hint="0 to 1, measured for bge models">
            <input id={fieldId("strongVectorSim")} type="number" min="0" max="1" step="0.01" class={input({ invalid: !!fieldError("strongVectorSim") })} bind:value={form.strongVectorSim} />
          </Field>
          <Field label="Weak match similarity" id={fieldId("weakVectorSim")} error={fieldError("weakVectorSim")} hint="0 to 1, at most the strong value">
            <input id={fieldId("weakVectorSim")} type="number" min="0" max="1" step="0.01" class={input({ invalid: !!fieldError("weakVectorSim") })} bind:value={form.weakVectorSim} />
          </Field>
          <Field label="Lexical weight" id={fieldId("lexicalWeight")} error={fieldError("lexicalWeight")} hint="weight of word matches in combined search">
            <input id={fieldId("lexicalWeight")} type="number" min="0" step="0.1" class={input({ invalid: !!fieldError("lexicalWeight") })} bind:value={form.lexicalWeight} />
          </Field>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Web crawling" description="How URL sources are fetched when preparing. Local folders are always read from disk.">
        <Segmented options={crawlProviders} bind:value={form.crawlProvider} label="Crawl provider" />
        {#if form.crawlProvider === "crawl4ai"}
          {@const status = envStatus(form.crawl4aiApiKeyEnv)}
          <div class="grid grid-cols-1 gap-4 border-t border-zinc-100 pt-5 sm:grid-cols-2 dark:border-zinc-800">
            <Field label="Crawl4AI URL" id={fieldId("crawl4aiUrl")} error={fieldError("crawl4aiUrl")} hint="the server's base URL, without credentials">
              <input id={fieldId("crawl4aiUrl")} class={input({ mono: true, invalid: !!fieldError("crawl4aiUrl") })} bind:value={form.crawl4aiUrl} />
            </Field>
            <Field label="Page timeout (seconds)" id={fieldId("crawl4aiTimeoutSeconds")} error={fieldError("crawl4aiTimeoutSeconds")}>
              <input id={fieldId("crawl4aiTimeoutSeconds")} type="number" min="1" class={input({ invalid: !!fieldError("crawl4aiTimeoutSeconds") })} bind:value={form.crawl4aiTimeoutSeconds} />
            </Field>
            <Field label="Token variable" id={fieldId("crawl4aiApiKeyEnv")} error={fieldError("crawl4aiApiKeyEnv")} hint="name only; the value stays in the environment">
              <input id={fieldId("crawl4aiApiKeyEnv")} class={input({ mono: true, invalid: !!fieldError("crawl4aiApiKeyEnv") })} bind:value={form.crawl4aiApiKeyEnv} />
              <StatusChip tone={status.tone} label={status.label} class="mt-2" />
            </Field>
          </div>
          <div class={noticeStyle({ tone: "info" })}>
            Docify still decides which pages to crawl, but the server's browser loads each page with its scripts and subrequests. Pages that end up outside the source are dropped after rendering, not prevented. If the server fails, preparing fails and the previous version keeps serving.
          </div>
        {/if}
      </SettingsGroup>

      <SettingsGroup title="Semantic graph" description="Optional Graphify knowledge graph built while preparing. It calls an LLM through the variables below.">
        <Switch bind:checked={form.graphEnabled} label="Build a graph when preparing" />
        {#if form.graphEnabled}
          <div class="grid grid-cols-1 gap-4 border-t border-zinc-100 pt-5 sm:grid-cols-2 dark:border-zinc-800">
            <Field label="Backend" id={fieldId("graph.backend")} error={fieldError("graph.backend")}>
              <input id={fieldId("graph.backend")} class={input({ invalid: !!fieldError("graph.backend") })} bind:value={form.graph.backend} />
            </Field>
            <Field label="Model" id={fieldId("graph.model")} error={fieldError("graph.model")}>
              <input id={fieldId("graph.model")} class={input({ invalid: !!fieldError("graph.model") })} bind:value={form.graph.model} />
            </Field>
            {#each graphEnvFields as v (v.key)}
              {@const status = envStatus(form.graph[v.key])}
              <Field label={v.label} id={fieldId(`graph.${v.key}`)} error={fieldError(`graph.${v.key}`)}>
                <input id={fieldId(`graph.${v.key}`)} class={input({ mono: true, invalid: !!fieldError(`graph.${v.key}`) })} bind:value={form.graph[v.key]} />
                <StatusChip tone={status.tone} label={status.label} class="mt-2" />
              </Field>
            {/each}
            <Field label="Base URL suffix" id={fieldId("graph.baseUrlSuffix")} error={fieldError("graph.baseUrlSuffix")} hint="appended to the base URL">
              <input id={fieldId("graph.baseUrlSuffix")} class={input({ mono: true, invalid: !!fieldError("graph.baseUrlSuffix") })} bind:value={form.graph.baseUrlSuffix} />
            </Field>
            <div class="grid grid-cols-2 gap-4">
              <Field label="Max concurrency" id={fieldId("graph.maxConcurrency")} error={fieldError("graph.maxConcurrency")}>
                <input id={fieldId("graph.maxConcurrency")} type="number" min="1" step="1" class={input({ invalid: !!fieldError("graph.maxConcurrency") })} bind:value={form.graph.maxConcurrency} />
              </Field>
              <Field label="Timeout (s)" id={fieldId("graph.timeoutSeconds")} error={fieldError("graph.timeoutSeconds")}>
                <input id={fieldId("graph.timeoutSeconds")} type="number" min="1" class={input({ invalid: !!fieldError("graph.timeoutSeconds") })} bind:value={form.graph.timeoutSeconds} />
              </Field>
            </div>
          </div>
        {/if}
      </SettingsGroup>

      <SettingsGroup title="Storage" description="Where Docify keeps its data. Paths that run or load code can only be changed in config.json or the environment.">
        <Field label="Keep generations" id={fieldId("keepGenerations")} error={fieldError("keepGenerations")} hint="active one plus older ones, so recent citations stay readable" class="sm:w-1/2">
          <input id={fieldId("keepGenerations")} type="number" min="1" step="1" class={input({ invalid: !!fieldError("keepGenerations") })} bind:value={form.keepGenerations} />
        </Field>
        <dl class="flex flex-col gap-2 border-t border-zinc-100 pt-5 dark:border-zinc-800">
          {#each pathRows as row (row.label)}
            <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-6">
              <dt class="w-20 shrink-0 text-[12px] font-medium text-zinc-500 dark:text-zinc-400">{row.label}</dt>
              <dd class="flex min-w-0 items-center gap-2">
                <span class="truncate rounded border border-zinc-200/60 bg-zinc-50 px-2 py-1 font-mono text-[13px] text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200" title={row.value}>{row.value}</span>
                {#if row.note}<span class="shrink-0 text-[12px] text-zinc-400 dark:text-zinc-500">{row.note}</span>{/if}
              </dd>
            </div>
          {/each}
        </dl>
      </SettingsGroup>

      <SettingsGroup title="Environment" description="Variables this server process started with. Change them where you start docify serve, then restart it.">
        <div class="-mx-5 -my-5 overflow-x-auto">
          <table class="w-full text-left text-[13px]">
            <thead class="text-[12px] text-zinc-500 dark:text-zinc-400">
              <tr class="border-b border-zinc-100 dark:border-zinc-800">
                <th class="px-5 py-2.5 font-medium">Variable</th>
                <th class="px-2 py-2.5 font-medium">Used for</th>
                <th class="px-2 py-2.5 font-medium">Status</th>
                <th class="px-5 py-2.5 font-medium">Value</th>
              </tr>
            </thead>
            <tbody>
              {#each desc.environment as e (e.name)}
                <tr class="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                  <td class="px-5 py-2.5 font-mono text-[12px] whitespace-nowrap text-zinc-800 dark:text-zinc-200">{e.name}</td>
                  <td class="px-2 py-2.5 text-zinc-500 dark:text-zinc-400">{e.purpose}</td>
                  <td class="px-2 py-2.5"><StatusChip tone={e.set ? "ok" : "neutral"} label={e.set ? "set" : "not set"} /></td>
                  <td class="max-w-56 truncate px-5 py-2.5 font-mono text-[12px] text-zinc-500 dark:text-zinc-400" title={e.value ?? undefined}
                    >{e.value ?? (e.set ? "hidden" : "")}</td
                  >
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </SettingsGroup>
    {/if}

    <SettingsGroup title="Project pins" description="Versions used when a search names a library without a version. Saved right away to .docify.json.">
      {#if pins}
        <dl class="flex flex-col gap-1 text-[12px]">
          <div class="flex gap-2"><dt class="w-14 shrink-0 text-zinc-500 dark:text-zinc-400">Project</dt><dd class="truncate font-mono text-zinc-700 dark:text-zinc-300" title={pins.project}>{pins.project}</dd></div>
          <div class="flex gap-2">
            <dt class="w-14 shrink-0 text-zinc-500 dark:text-zinc-400">File</dt>
            <dd class="truncate font-mono text-zinc-700 dark:text-zinc-300">{pins.file ?? "none yet; the first pin creates .docify.json in the project"}</dd>
          </div>
        </dl>
        {#if Object.keys(pins.pins).length}
          <ul class="flex flex-col divide-y divide-zinc-100 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {#each Object.entries(pins.pins) as [lib, ver] (lib)}
              <li class="flex items-center justify-between gap-3 px-3 py-2">
                <span class="font-mono text-[13px]">{lib}<span class="text-zinc-400">@</span>{ver}</span>
                <button type="button" class={button({ intent: "ghost", size: "xs" })} disabled={pinBusy} onclick={() => setPin(lib, null)}>Unpin</button>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="text-[13px] text-zinc-500 dark:text-zinc-400">No pins. Searches use every prepared version unless a version is given.</p>
        {/if}
        <form
          class="flex flex-wrap items-center gap-2"
          onsubmit={(ev) => {
            ev.preventDefault();
            setPin(pinLibrary, pinVersion);
          }}
        >
          <input class={input({ class: "w-36 flex-none" })} placeholder="library" aria-label="Library to pin" required bind:value={pinLibrary} />
          <input class={input({ class: "w-28 flex-none" })} placeholder="version" aria-label="Version to pin" required bind:value={pinVersion} />
          <button type="submit" class={button()} disabled={pinBusy}>Pin</button>
        </form>
      {/if}
      {#if pinError}<p class="text-[12px] break-words text-rose-600 dark:text-rose-400" role="alert">{pinError}</p>{/if}
    </SettingsGroup>
  </main>

  {#if form && desc}
    <div class="sticky bottom-0 z-30 border-t border-zinc-200 bg-white/95 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/95">
      <div class="mx-auto flex max-w-[760px] flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div class="min-w-0 text-[13px]" role="status">
          {#if saveError}
            <span class="font-medium break-words text-rose-600 dark:text-rose-400">{saveError.message}</span>
          {:else if dirty}
            <span class="font-medium text-zinc-500 dark:text-zinc-400">Unsaved changes</span>
          {:else if saved}
            <span class="font-medium text-emerald-700 dark:text-emerald-300">{saved}</span>
          {:else}
            <span class="text-zinc-400 dark:text-zinc-500">Saved to {desc.paths.configFile}</span>
          {/if}
        </div>
        <div class="flex items-center gap-3">
          <button type="button" class={button()} disabled={!dirty || saving} onclick={revert}>Revert</button>
          <button type="button" class={button({ intent: "primary" })} disabled={!dirty || saving || Object.keys(clientErrors).length > 0} onclick={save}
            >{saving ? "Saving" : "Save"}</button
          >
        </div>
      </div>
    </div>
  {/if}
</div>

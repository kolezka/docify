<script lang="ts">
  import Segmented from "../components/Segmented.svelte";
  import Sheet from "../components/Sheet.svelte";
  import StatusIcon from "../components/StatusIcon.svelte";
  import Switch from "../components/Switch.svelte";
  import { api, ApiError, errorText, type ConfigDescription } from "../lib/api.ts";
  import { nav } from "../lib/nav.svelte.ts";
  import { sources } from "../lib/sources.svelte.ts";
  import { tick } from "svelte";
  import { button, footnote, input, isPatternField, notice, panel, patternError, patternLines, popup, row, textArea } from "../lib/ui.ts";

  type Kind = "url" | "git" | "local";
  const CRAWLER_LABELS: Record<string, string> = { builtin: "Built-in", crawl4ai: "Crawl4AI", browserless: "Browserless" };
  const FIELDS = ["locator", "library", "version", "crawlProvider", "ignore", "graphIgnore", "title", "groups"] as const;
  type FieldName = (typeof FIELDS)[number];

  let kind = $state<Kind>("url");
  let locator = $state("");
  let library = $state("");
  let version = $state("");
  let libraryEdited = $state(false);
  let versionEdited = $state(false);
  let crawlProvider = $state("");
  let ignoreText = $state("");
  let graphIgnoreText = $state("");
  let titleText = $state("");
  let groupsText = $state("");
  let prepareAfter = $state(true);
  let buildGraph = $state(true);
  let submitting = $state(false);
  let error = $state("");
  let fieldError = $state<{ field: FieldName; message: string } | null>(null);
  let globalCrawler = $state<string | null>(null);

  // Each time the sheet opens: clear old errors and learn the global crawler for the Default option.
  $effect(() => {
    if (!nav.addingSource) return;
    error = "";
    fieldError = null;
    api<ConfigDescription>("/api/config")
      .then((c) => (globalCrawler = c.values.crawlProvider))
      // Only labels the Default option; without it the option reads just "Default".
      .catch(() => (globalCrawler = null));
  });

  const VERSION_SEGMENT = /^v?(\d+(?:\.\d+){0,3}(?:[-+][A-Za-z0-9.]+)?)$/;
  const SKIP_HOST_LABELS = new Set(["www", "docs", "doc", "developer", "developers", "api", "dev", "learn", "help"]);

  function slug(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+|[-.]+$/g, "")
      .slice(0, 61);
  }

  // A client-side guess from the URL host and path, or the folder name. The user's own text always wins.
  function suggest(kind: Kind, text: string): { library: string; version: string } {
    const value = text.trim();
    if (!value) return { library: "", version: "" };
    if (kind !== "local") {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return { library: "", version: "" };
      }
      if (kind === "git") return { library: slug((url.pathname.split("/").filter(Boolean).at(-1) ?? "").replace(/\.git$/, "")), version: "" };
      const labels = url.hostname.split(".").filter(Boolean);
      const name = labels.slice(0, -1).find((l) => !SKIP_HOST_LABELS.has(l)) ?? labels[0] ?? "";
      const versionSegment = url.pathname.split("/").map((p) => VERSION_SEGMENT.exec(p)?.[1]).find(Boolean) ?? "";
      return { library: slug(name), version: versionSegment };
    }
    const parts = value.replace(/[/\\]+$/, "").split(/[/\\]/).filter(Boolean);
    const last = parts.at(-1) ?? "";
    const lastVersion = VERSION_SEGMENT.exec(last)?.[1];
    if (lastVersion && parts.length > 1) return { library: slug(parts.at(-2)!), version: lastVersion };
    return { library: slug(last === "~" ? "" : last), version: "" };
  }

  const suggestion = $derived(suggest(kind, locator));
  const libraryValue = $derived(libraryEdited ? library : suggestion.library);
  const versionValue = $derived(versionEdited ? version : suggestion.version);
  const suggestedNote = $derived.by(() => {
    const parts = [!libraryEdited && suggestion.library && "Library", !versionEdited && suggestion.version && "version"].filter(Boolean);
    if (!parts.length) return "";
    const what = parts.length === 2 ? "Library and version were" : parts[0] === "Library" ? "Library was" : "Version was";
    return `${what} suggested from the ${kind !== "local" ? "URL" : "folder name"}`;
  });
  const sourceId = $derived(libraryValue.trim() ? `${libraryValue.trim().toLowerCase()}@${versionValue.trim() || "unknown"}` : "");
  const canSubmit = $derived(!submitting && !!locator.trim() && !!libraryValue.trim());
  const defaultCrawlerLabel = $derived(globalCrawler ? `Default (${CRAWLER_LABELS[globalCrawler] ?? globalCrawler})` : "Default");

  const errorFor = (field: FieldName) => (fieldError?.field === field ? fieldError.message : null);

  function reset() {
    locator = library = version = crawlProvider = ignoreText = graphIgnoreText = titleText = groupsText = "";
    libraryEdited = versionEdited = false;
    prepareAfter = buildGraph = true;
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    error = "";
    fieldError = null;
    submitting = true;
    // What happens after adding is fixed at submit time; edits made while the request runs must not change it.
    const graph = buildGraph;
    const shouldPrepare = prepareAfter;
    const ignore = patternLines(ignoreText);
    const graphIgnore = patternLines(graphIgnoreText);
    const title = titleText.trim();
    const groups = groupsText.split(/[\s,]+/).filter(Boolean);
    const body = {
      library: libraryValue.trim(),
      version: versionValue.trim(),
      locator: locator.trim(),
      kind,
      ...(kind === "url" && crawlProvider ? { crawlProvider } : {}),
      ...(ignore.length ? { ignore } : {}),
      ...(graphIgnore.length ? { graphIgnore } : {}),
      ...(title ? { title } : {}),
      ...(groups.length ? { groups } : {}),
    };
    let id: string;
    try {
      const created = await api<{ id?: string }>("/api/sources", { method: "POST", body });
      id = created?.id ?? `${body.library.toLowerCase()}@${body.version || "unknown"}`;
    } catch (err) {
      const field = err instanceof ApiError ? err.field : null;
      if (field && (FIELDS as readonly string[]).includes(field)) fieldError = { field: field as FieldName, message: err instanceof ApiError ? err.message : errorText(err) };
      else error = errorText(err);
      submitting = false;
      // The pattern fields sit low in the sheet; bring the one with the error into view.
      if (isPatternField(field)) {
        await tick();
        document.getElementById(field === "ignore" ? "add-ignore" : "add-graph-ignore")?.focus();
      }
      return;
    }
    reset();
    let prepareError = "";
    if (shouldPrepare) {
      try {
        await api(`/api/sources/${encodeURIComponent(id)}/prepare`, { method: "POST", body: { graph } });
      } catch (err) {
        prepareError = errorText(err);
      }
    }
    submitting = false;
    await sources.refresh();
    nav.openSource(id);
    // The source exists either way; keep the sheet open only to say that preparing did not start.
    if (prepareError) error = `Added ${id}, but preparing did not start: ${prepareError}. Prepare it from its page.`;
    else nav.addingSource = false;
  }
</script>

<Sheet bind:open={nav.addingSource} title="New Source">
  <form id="add-source-form" onsubmit={submit} novalidate>
    <div class="flex flex-wrap items-baseline justify-between gap-3">
      <h2 class="text-[17px] leading-[22px] font-semibold">New Source</h2>
      <Segmented
        label="Source kind"
        bind:value={kind}
        options={[
          { value: "url", label: "Website" },
          { value: "git", label: "Repository" },
          { value: "local", label: "Local Folder" },
        ]}
        onchange={() => fieldError?.field === "locator" && (fieldError = null)}
      />
    </div>
    <p class={`${footnote} mt-1`}>Docify keeps a copy of the documentation and indexes it for agents.</p>

    {#if error}
      <div class={notice({ tone: "bad", class: "mt-4" })} role="alert">
        <StatusIcon tone="bad" class="mt-0.5" /><span class="min-w-0 break-words whitespace-pre-wrap">{error}</span>
      </div>
    {/if}

    <div class={panel({ class: "mt-[18px]" })}>
      <div class={row({ class: "flex-col items-stretch gap-1.5" })}>
        <label for="add-locator" class="text-[13px] text-label">{kind === "url" ? "Start URL" : kind === "git" ? "Repository URL" : "Folder"}</label>
        <input
          id="add-locator"
          class={input({ mono: true, invalid: !!errorFor("locator") })}
          type={kind !== "local" ? "url" : "text"}
          autocomplete="off"
          spellcheck="false"
          placeholder={kind === "url" ? "https://bun.sh/docs" : kind === "git" ? "https://github.com/owner/repo" : "~/Documents/docs"}
          aria-invalid={!!errorFor("locator")}
          aria-describedby="add-locator-hint"
          bind:value={locator}
        />
      </div>
    </div>
    <p id="add-locator-hint" class="mx-3.5 mt-1.5 text-[11px] leading-[14px] {errorFor('locator') ? 'font-medium text-bad-text' : 'text-label2'}">
      {errorFor("locator") ?? (kind === "url" ? "Follows links under this path on the same site." : kind === "git" ? "Indexes documentation and source code from the default branch of a public HTTPS Git repository." : "Markdown, MDX and HTML files in this folder and below.")}
    </p>

    <div class={panel({ class: "mt-3.5" })}>
      <div class={row()}>
        <label for="add-library" class="min-w-0 flex-1 text-[13px] text-label">Library</label>
        <div class="flex w-[200px] flex-col gap-1">
          <input
            id="add-library"
            class={input({ mono: true, invalid: !!errorFor("library") })}
            autocomplete="off"
            spellcheck="false"
            placeholder="bun"
            aria-invalid={!!errorFor("library")}
            value={libraryValue}
            oninput={(e) => {
              library = e.currentTarget.value;
              libraryEdited = true;
            }}
          />
          {#if errorFor("library")}<p class="text-[11px] leading-[14px] font-medium text-bad-text">{errorFor("library")}</p>{/if}
        </div>
      </div>
      <div class={row()}>
        <div class="min-w-0 flex-1">
          <label for="add-version" class="block text-[13px] text-label">Version</label>
          <div class="mt-px text-[11px] leading-[14px] text-label2">Optional. Agents can filter by it.</div>
        </div>
        <div class="flex w-[200px] flex-col gap-1">
          <input
            id="add-version"
            class={input({ mono: true, invalid: !!errorFor("version") })}
            autocomplete="off"
            spellcheck="false"
            placeholder="1.3"
            aria-invalid={!!errorFor("version")}
            value={versionValue}
            oninput={(e) => {
              version = e.currentTarget.value;
              versionEdited = true;
            }}
          />
          {#if errorFor("version")}<p class="text-[11px] leading-[14px] font-medium text-bad-text">{errorFor("version")}</p>{/if}
        </div>
      </div>
      <div class={row()}>
        <div class="min-w-0 flex-1 text-[13px] text-label">Source ID</div>
        {#if sourceId}<span class="font-mono text-[13px] text-label2">{sourceId}</span>{:else}<span class="text-[13px] text-label2">Needs a library name</span>{/if}
      </div>
      <div class={row()}>
        <div class="min-w-0 flex-1">
          <label for="add-title" class="block text-[13px] text-label">Name</label>
          <div class="mt-px text-[11px] leading-[14px] text-label2">Optional. A label; the ID stays the same.</div>
        </div>
        <div class="flex w-[200px] flex-col gap-1">
          <input id="add-title" class={input({ invalid: !!errorFor("title") })} maxlength="120" autocomplete="off" placeholder="Bun runtime docs" aria-invalid={!!errorFor("title")} bind:value={titleText} disabled={submitting} />
          {#if errorFor("title")}<p class="text-[11px] leading-[14px] font-medium text-bad-text" role="alert">{errorFor("title")}</p>{/if}
        </div>
      </div>
      <div class={row()}>
        <div class="min-w-0 flex-1">
          <label for="add-groups" class="block text-[13px] text-label">Groups</label>
          <div class="mt-px text-[11px] leading-[14px] text-label2">Optional. Comma-separated; agents can search a whole group.</div>
        </div>
        <div class="flex w-[200px] flex-col gap-1">
          <input id="add-groups" class={input({ mono: true, invalid: !!errorFor("groups") })} autocomplete="off" spellcheck="false" placeholder="frontend" aria-invalid={!!errorFor("groups")} bind:value={groupsText} disabled={submitting} />
          {#if errorFor("groups")}<p class="text-[11px] leading-[14px] font-medium text-bad-text" role="alert">{errorFor("groups")}</p>{/if}
        </div>
      </div>
      {#if kind === "url"}
        <div class={row()}>
          <div class="min-w-0 flex-1">
            <label for="add-crawler" class="block text-[13px] text-label">Fetch pages with</label>
            <div class="mt-px text-[11px] leading-[14px] text-label2">Crawl4AI or Browserless render JavaScript</div>
            {#if errorFor("crawlProvider")}<p class="mt-1 text-[11px] leading-[14px] font-medium text-bad-text">{errorFor("crawlProvider")}</p>{/if}
          </div>
          <select id="add-crawler" class={popup()} bind:value={crawlProvider}>
            <option value="">{defaultCrawlerLabel}</option>
            <option value="builtin">Built-in</option>
            <option value="crawl4ai">Crawl4AI</option>
            <option value="browserless">Browserless</option>
          </select>
        </div>
      {/if}
    </div>

    <div class={panel({ class: "mt-3.5" })}>
      <div class={row({ class: "flex-col items-stretch gap-1.5" })}>
        <label for="add-ignore" class="text-[13px] text-label">Do not collect</label>
        <textarea id="add-ignore" class={textArea({ invalid: !!errorFor("ignore") })} rows="2" spellcheck="false" autocomplete="off" placeholder="One pattern per line" aria-invalid={!!errorFor("ignore")} aria-describedby="add-ignore-hint" bind:value={ignoreText} oninput={() => fieldError?.field === "ignore" && (fieldError = null)} disabled={submitting}></textarea>
        {#if errorFor("ignore")}<span class="text-[11px] leading-[14px] font-medium break-words text-bad-text" role="alert">{patternError(errorFor("ignore") ?? "")}</span>{/if}
      </div>
      <div class={row({ class: "flex-col items-stretch gap-1.5" })}>
        <label for="add-graph-ignore" class="text-[13px] text-label">Leave out of the graph</label>
        <textarea id="add-graph-ignore" class={textArea({ invalid: !!errorFor("graphIgnore") })} rows="2" spellcheck="false" autocomplete="off" placeholder="One pattern per line" aria-invalid={!!errorFor("graphIgnore")} aria-describedby="add-ignore-hint" bind:value={graphIgnoreText} oninput={() => fieldError?.field === "graphIgnore" && (fieldError = null)} disabled={submitting}></textarea>
        {#if errorFor("graphIgnore")}<span class="text-[11px] leading-[14px] font-medium break-words text-bad-text" role="alert">{patternError(errorFor("graphIgnore") ?? "")}</span>{/if}
      </div>
    </div>
    <p id="add-ignore-hint" class="mx-3.5 mt-1.5 text-[11px] leading-[14px] text-label2">Optional. Regular expressions matched against the document path, such as ^changelog/.</p>

    <div class={panel({ class: "mt-3.5" })}>
      <div class={row()}>
        <div class="min-w-0 flex-1">
          <div class="text-[13px] text-label">Prepare after adding</div>
          <div class="mt-px text-[11px] leading-[14px] text-label2">Download, index and embed right away</div>
        </div>
        <Switch bind:checked={prepareAfter} label="Prepare after adding" hideLabel disabled={submitting} />
      </div>
      <div class={row()}>
        <div class="min-w-0 flex-1">
          <div class="text-[13px] {prepareAfter ? 'text-label' : 'text-label2'}">Build semantic graph</div>
          <div class="mt-px text-[11px] leading-[14px] text-label2">Uses the LLM from Settings. Takes several minutes.</div>
        </div>
        <Switch bind:checked={buildGraph} label="Build semantic graph" hideLabel disabled={submitting || !prepareAfter} />
      </div>
    </div>
  </form>

  {#snippet footer()}
    <span class={footnote}>{suggestedNote}</span>
    <span class="flex gap-2.5">
      <button type="button" class={button({ size: "md" })} onclick={() => (nav.addingSource = false)}>Cancel</button>
      <button type="submit" form="add-source-form" class={button({ intent: "primary", size: "md" })} disabled={!canSubmit}>{submitting ? "Adding…" : "Add Source"}</button>
    </span>
  {/snippet}
</Sheet>

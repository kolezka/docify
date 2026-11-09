<script lang="ts">
  import { onMount } from "svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import ThemeSwitch from "./components/ThemeSwitch.svelte";
  import AddSourceSheet from "./views/AddSourceSheet.svelte";
  import Graph from "./views/Graph.svelte";
  import Logs from "./views/Logs.svelte";
  import Search from "./views/Search.svelte";
  import Settings from "./views/Settings.svelte";
  import SourcePage from "./views/SourcePage.svelte";
  import { handleShortcut, nav } from "./lib/nav.svelte.ts";
  import { sources } from "./lib/sources.svelte.ts";
  import { popup } from "./lib/ui.ts";

  onMount(() => {
    sources.refresh();
  });

  // Narrow windows hide the sidebar; this picker stands in for it.
  const compactValue = $derived(nav.view === "source" && nav.sourceId ? `source:${nav.sourceId}` : nav.view);
  function pickCompact(value: string) {
    if (value === "new-source") nav.addingSource = true;
    else if (value.startsWith("source:")) nav.openSource(value.slice(7));
    else nav.go(value as "search" | "graph" | "logs" | "settings");
  }
</script>

<svelte:window onkeydown={handleShortcut} />

<div class="flex h-dvh overflow-hidden">
  <Sidebar />
  <div class="flex min-w-0 flex-1 flex-col">
    <div class="flex items-center gap-2 px-4 pt-3 md:hidden">
      <span class="text-[15px] font-semibold">Docify</span>
      <select class={popup({ class: "ml-auto" })} aria-label="View" value={compactValue} onchange={(e) => pickCompact(e.currentTarget.value)}>
        <option value="search">Search</option>
        <option value="graph">Graph</option>
        <option value="logs">Logs</option>
        <option value="settings">Settings</option>
        {#each sources.list ?? [] as s (s.id)}<option value={`source:${s.id}`}>{s.id}</option>{/each}
        <option value="new-source">New source…</option>
      </select>
      <ThemeSwitch />
    </div>
    <!-- Search stays mounted so its results survive a visit to another view. -->
    <main class="flex min-h-0 flex-1 flex-col" class:hidden={nav.view !== "search"}>
      <Search />
    </main>
    {#if nav.view === "source"}
      <main class="flex min-h-0 flex-1 flex-col"><SourcePage /></main>
    {:else if nav.view === "graph"}
      <main class="flex min-h-0 flex-1 flex-col"><Graph /></main>
    {:else if nav.view === "logs"}
      <main class="flex min-h-0 flex-1 flex-col"><Logs /></main>
    {:else if nav.view === "settings"}
      <main class="flex min-h-0 flex-1 flex-col"><Settings /></main>
    {/if}
  </div>
</div>

<AddSourceSheet />

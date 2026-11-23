<script lang="ts">
  import { onMount } from "svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import ThemeSwitch from "./components/ThemeSwitch.svelte";
  import Account from "./views/Account.svelte";
  import AddSourceSheet from "./views/AddSourceSheet.svelte";
  import Graph from "./views/Graph.svelte";
  import Logs from "./views/Logs.svelte";
  import Search from "./views/Search.svelte";
  import Settings from "./views/Settings.svelte";
  import SignIn from "./views/SignIn.svelte";
  import SourcePage from "./views/SourcePage.svelte";
  import Users from "./views/Users.svelte";
  import { handleShortcut, nav } from "./lib/nav.svelte.ts";
  import { session } from "./lib/session.svelte.ts";
  import { sources } from "./lib/sources.svelte.ts";
  import { users } from "./lib/users.svelte.ts";
  import { popup } from "./lib/ui.ts";

  onMount(session.refresh);
  // Data is asked for only once this person may see it, and again after an approval or a new sign-in.
  $effect(() => {
    if (!session.ready) return;
    sources.refresh();
    if (session.accounts && session.admin) users.refresh();
  });

  // Narrow windows hide the sidebar; this picker stands in for it.
  const compactValue = $derived(nav.shown === "source" && nav.sourceId ? `source:${nav.sourceId}` : nav.shown);
  function pickCompact(value: string) {
    if (value === "sign-out") void session.signOut().catch(session.refresh);
    else if (value === "new-source") nav.addingSource = true;
    else if (value.startsWith("source:")) nav.openSource(value.slice(7));
    else nav.go(value as "search" | "graph" | "logs" | "settings" | "users" | "account");
  }
</script>

<svelte:window onkeydown={handleShortcut} />

{#if !session.loaded}
  <div class="h-dvh" aria-busy="true"></div>
{:else if !session.ready}
  <SignIn />
{:else}
<div class="flex h-dvh overflow-hidden">
  <Sidebar />
  <div class="flex min-w-0 flex-1 flex-col">
    <div class="flex items-center gap-2 px-4 pt-3 md:hidden">
      <span class="text-[15px] font-semibold">Docify</span>
      <select class={popup({ class: "ml-auto" })} aria-label="View" value={compactValue} onchange={(e) => pickCompact(e.currentTarget.value)}>
        <option value="search">Search</option>
        <option value="graph">Graph</option>
        {#if session.admin}
          <option value="logs">Logs</option>
          <option value="settings">Settings</option>
          {#if session.accounts}<option value="users">Users</option>{/if}
        {/if}
        {#if session.user}<option value="account">Account</option>{/if}
        {#each sources.list ?? [] as s (s.id)}<option value={`source:${s.id}`}>{s.id}</option>{/each}
        {#if session.admin}<option value="new-source">New source…</option>{/if}
        <!-- The sidebar footer is hidden here, so this is the way out and the sign of who is signed in. -->
        {#if session.user}<option value="sign-out">Sign Out ({session.user.login})</option>{/if}
      </select>
      <ThemeSwitch />
    </div>
    <!-- Search stays mounted so its results survive a visit to another view. -->
    <main class="flex min-h-0 flex-1 flex-col" class:hidden={nav.shown !== "search"}>
      <Search />
    </main>
    {#if nav.shown === "source"}
      <main class="flex min-h-0 flex-1 flex-col"><SourcePage /></main>
    {:else if nav.shown === "graph"}
      <main class="flex min-h-0 flex-1 flex-col"><Graph /></main>
    {:else if nav.shown === "logs"}
      <main class="flex min-h-0 flex-1 flex-col"><Logs /></main>
    {:else if nav.shown === "settings"}
      <main class="flex min-h-0 flex-1 flex-col"><Settings /></main>
    {:else if nav.shown === "users"}
      <main class="flex min-h-0 flex-1 flex-col"><Users /></main>
    {:else if nav.shown === "account"}
      <main class="flex min-h-0 flex-1 flex-col"><Account /></main>
    {/if}
  </div>
</div>

{#if session.admin}<AddSourceSheet />{/if}
{/if}

<script lang="ts">
  import { Logs, Network, Plus, Search, Settings, Users } from "@lucide/svelte";
  import StatusDot from "./StatusDot.svelte";
  import ThemeSwitch from "./ThemeSwitch.svelte";
  import type { SourceInfo } from "../lib/api.ts";
  import { ADMIN_VIEWS, nav, shortcuts } from "../lib/nav.svelte.ts";
  import { session } from "../lib/session.svelte.ts";
  import { sources } from "../lib/sources.svelte.ts";
  import { users } from "../lib/users.svelte.ts";
  import { cn, sourceStateLabel, sourceTone } from "../lib/ui.ts";

  // Glass sidebar: the navigation layer above content (HIG Materials > Liquid Glass).
  const ALL_ITEMS = [
    { view: "search", label: "Search", icon: Search, key: "⌥1" },
    { view: "graph", label: "Graph", icon: Network, key: "⌥2" },
    { view: "logs", label: "Logs", icon: Logs, key: "⌥3" },
    { view: "settings", label: "Settings", icon: Settings, key: "⌥4" },
    { view: "users", label: "Users", icon: Users, key: "⌥5" },
  ] as const;
  // Members get Search and Graph; Users exists only on a server with accounts.
  const items = $derived(ALL_ITEMS.filter((it) => (session.admin || !ADMIN_VIEWS.includes(it.view)) && (it.view !== "users" || session.accounts)));

  let signOutError = $state("");
  const signOut = () => session.signOut().catch((err) => (signOutError = err instanceof Error ? err.message : String(err)));

  function subline(s: SourceInfo): string {
    if (s.state === "preparing") return [s.latest?.phase, s.latest?.progress].filter(Boolean).join(" ") || "Starting";
    if (s.state === "ready") {
      const passages = s.activeGeneration?.stats.passages;
      return typeof passages === "number" ? `${passages.toLocaleString("en-US")} passages` : "Ready";
    }
    return sourceStateLabel(s.state);
  }

  const itemClass = (active: boolean) =>
    cn(
      "flex w-full items-center gap-2 rounded-[7px] px-2 text-left text-[13px] focus-visible:ring-[3px] focus-visible:ring-accent-soft focus-visible:outline-none",
      active ? "bg-accent text-white" : "text-label hover:bg-fill/70",
    );
</script>

<aside
  class="m-2 mr-0 hidden w-[248px] shrink-0 flex-col overflow-hidden rounded-[14px] border border-white/35 bg-sidebar shadow-float backdrop-blur-2xl backdrop-saturate-150 md:flex dark:border-white/10"
  aria-label="Sidebar"
>
  <div class="px-4 pt-4 pb-1 text-[15px] leading-5 font-semibold">Docify</div>
  <nav class="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="Views">
    <ul class="flex flex-col gap-px pt-1">
      {#each items as it (it.view)}
        {@const active = nav.shown === it.view}
        {@const waiting = it.view === "users" ? users.pending : 0}
        <li>
          <button type="button" class={cn(itemClass(active), "h-7")} aria-current={active ? "page" : undefined} onclick={() => nav.go(it.view)}>
            <it.icon size={15} strokeWidth={1.75} class={active ? "text-white" : "text-accent-text"} aria-hidden="true" />
            <span class="flex-1">{it.label}</span>
            {#if waiting}
              <span class={cn("rounded-full px-1.5 text-[11px] leading-4 font-semibold", active ? "bg-white/25 text-white" : "bg-fill text-label")}
                >{waiting}<span class="sr-only"> waiting for approval</span></span
              >
            {/if}
            <span class={cn("text-[11px]", active ? "text-white" : "text-label2")} aria-hidden="true">{it.key}</span>
          </button>
        </li>
      {/each}
    </ul>

    <div class="flex items-center justify-between px-2 pt-4 pb-1">
      <h2 class="text-[11px] leading-[14px] font-semibold text-label2">Sources</h2>
      {#if session.admin}
        <button
          type="button"
          class="grid size-6 place-items-center rounded-md text-accent-text hover:bg-fill/70 focus-visible:ring-[3px] focus-visible:ring-accent-soft focus-visible:outline-none"
          title={`New source (${shortcuts.find((s) => s.code === "KeyN")?.label})`}
          aria-label="New source"
          onclick={() => (nav.addingSource = true)}><Plus size={15} strokeWidth={2} aria-hidden="true" /></button
        >
      {/if}
    </div>
    {#if sources.list === null}
      <p class="px-2 py-1 text-[11px] text-label2">{sources.error || "Loading sources…"}</p>
    {:else if sources.list.length === 0}
      <p class="px-2 py-1 text-[11px] leading-[14px] text-label2">No sources yet.</p>
    {:else}
      <ul class="flex flex-col gap-px">
        {#each sources.list as s (s.id)}
          {@const active = nav.shown === "source" && nav.sourceId === s.id}
          <li>
            <button type="button" class={cn(itemClass(active), "h-10")} aria-current={active ? "page" : undefined} onclick={() => nav.openSource(s.id)} data-source={s.id}>
              <StatusDot tone={sourceTone(s.state)} class={active ? "ring-2 ring-white" : ""} />
              <span class="min-w-0 flex-1">
                <span class="block truncate font-medium"
                  >{s.library}{#if s.version}<span class="ml-1 text-[11px] font-normal">{s.version}</span>{/if}</span
                >
                <span class={cn("block truncate text-[11px] leading-[13px]", active ? "text-white" : "text-label2")}>{subline(s)}</span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </nav>
  <!-- Who is signed in, and the way out (HIG Managing accounts: show the signed-in state). -->
  {#if session.user}
    <div class="flex items-center gap-2 border-t border-sep/60 px-3 py-2">
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[13px] font-medium" title={session.user.login}>{session.user.login}</span>
        <span class="block truncate text-[11px] leading-[13px] text-label2">{signOutError || (session.user.role === "admin" ? "Administrator" : "Member")}</span>
      </span>
      <button type="button" class="shrink-0 rounded-md px-1.5 py-0.5 text-[12px] text-accent-text hover:bg-fill/70 focus-visible:ring-[3px] focus-visible:ring-accent-soft focus-visible:outline-none" onclick={signOut}
        >Sign Out</button
      >
    </div>
  {/if}
  <div class="flex items-center justify-between border-t border-sep/60 px-3 py-2.5">
    <span class="text-[11px] text-label2">Appearance</span>
    <ThemeSwitch />
  </div>
</aside>

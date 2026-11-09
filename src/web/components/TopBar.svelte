<script lang="ts">
  import ThemeSwitch from "./ThemeSwitch.svelte";
  import { cn } from "../lib/ui.ts";

  type View = "workspace" | "graph" | "settings" | "logs";
  let { view = $bindable() }: { view: View } = $props();

  const tabs: { value: View; label: string }[] = [
    { value: "workspace", label: "Workspace" },
    { value: "graph", label: "Graph" },
    { value: "logs", label: "Logs" },
    { value: "settings", label: "Settings" },
  ];
</script>

<header class="sticky top-0 z-40 flex shrink-0 items-stretch justify-between gap-4 border-b border-zinc-200 bg-white px-5 dark:border-zinc-800 dark:bg-zinc-900">
  <div class="flex min-w-0 items-baseline gap-3 py-3">
    <h1 class="text-[18px] font-semibold tracking-tight">Docify</h1>
    <span class="hidden truncate text-[14px] text-zinc-500 sm:inline dark:text-zinc-400">local documentation for agents</span>
  </div>
  <div class="flex items-center gap-5">
    <nav class="flex gap-5 self-stretch text-[14px] font-medium" aria-label="Views">
      {#each tabs as t (t.value)}
        <button
          type="button"
          aria-current={view === t.value ? "page" : undefined}
          onclick={() => (view = t.value)}
          class={cn(
            "-mb-px border-b-2 transition-colors",
            view === t.value
              ? "border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400"
              : "border-transparent text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
          )}>{t.label}</button
        >
      {/each}
    </nav>
    <ThemeSwitch />
  </div>
</header>

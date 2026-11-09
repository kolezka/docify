<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "../lib/ui.ts";

  let {
    label,
    id,
    hint,
    error,
    class: className = "",
    children,
  }: { label: string; id: string; hint?: string; error?: string | null; class?: string; children: Snippet } = $props();
</script>

<div class={cn("min-w-0", className)}>
  <label for={id} class="mb-1.5 block text-[12px] font-medium text-zinc-500 dark:text-zinc-400">{label}</label>
  {@render children()}
  {#if error}
    <p class="mt-1 text-[12px] font-medium text-rose-600 dark:text-rose-400">{error}</p>
  {:else if hint}
    <p class="mt-1 text-[12px] text-zinc-400 dark:text-zinc-500">{hint}</p>
  {/if}
</div>

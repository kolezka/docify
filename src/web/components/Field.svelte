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
  <label for={id} class="mb-1.5 block text-[13px] text-label">{label}</label>
  {@render children()}
  {#if error}
    <p class="mt-1 text-[11px] leading-[14px] font-medium text-bad-text">{error}</p>
  {:else if hint}
    <p class="mt-1 text-[11px] leading-[14px] text-label2">{hint}</p>
  {/if}
</div>

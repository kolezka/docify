<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn, row } from "../lib/ui.ts";

  // Label leading, value or control trailing. `for` links the label to a control in the trailing slot.
  let {
    label,
    sub,
    for: htmlFor,
    class: className = "",
    children,
    leading,
  }: { label?: string; sub?: string; for?: string; class?: string; children?: Snippet; leading?: Snippet } = $props();
</script>

<div class={cn(row(), className)}>
  {#if leading}{@render leading()}{/if}
  {#if label !== undefined}
    <div class="min-w-0 flex-1">
      {#if htmlFor}<label for={htmlFor} class="block text-[13px] text-label">{label}</label>{:else}<div class="text-[13px] text-label">{label}</div>{/if}
      {#if sub}<div class="mt-px text-[11px] leading-[14px] text-label2">{sub}</div>{/if}
    </div>
  {/if}
  {@render children?.()}
</div>

<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn, groupTitle, panel } from "../lib/ui.ts";

  // A titled group of an inset grouped list, with an optional note under it.
  let { title, hint, class: className = "", children, footer }: { title?: string; hint?: string; class?: string; children: Snippet; footer?: Snippet } = $props();
</script>

<section class={cn("min-w-0", className)}>
  {#if title}<h3 class={groupTitle()}>{title}</h3>{/if}
  <div class={panel({ class: "overflow-hidden" })}>
    {@render children()}
  </div>
  {#if hint}<p class="mx-3.5 mt-1.5 text-[11px] leading-[14px] text-label2">{hint}</p>{/if}
  {@render footer?.()}
</section>

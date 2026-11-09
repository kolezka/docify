<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "../lib/ui.ts";

  // The view's toolbar: no bar background, controls float in glass capsules (HIG Layout > Visual hierarchy).
  let { children, class: className = "" }: { children: Snippet; class?: string } = $props();
</script>

<div class={cn("flex h-[52px] shrink-0 items-center gap-2.5 pr-4 pl-5", className)}>
  {@render children()}
</div>

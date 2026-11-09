<script lang="ts">
  import { chip, type ChipTone } from "../lib/ui.ts";

  let { tone, class: className = "" }: { tone: ChipTone; class?: string } = $props();
</script>

<span class={chip({ tone }).dot({ class: className })} aria-hidden="true"></span>

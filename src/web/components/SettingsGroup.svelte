<script lang="ts">
  import type { Snippet } from "svelte";
  import { panel } from "../lib/ui.ts";

  let { title, description, children }: { title: string; description: string; children: Snippet } = $props();
  const id = $derived(`group-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
</script>

<section class="flex flex-col gap-3" aria-labelledby={id}>
  <div>
    <h2 {id} class="text-[14px] font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
    <p class="mt-1 text-[13px] leading-relaxed text-zinc-500 dark:text-zinc-400">{description}</p>
  </div>
  <div class={panel({ class: "flex flex-col gap-6 p-5" })}>
    {@render children()}
  </div>
</section>

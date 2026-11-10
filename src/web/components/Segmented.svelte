<script lang="ts" generics="T extends string">
  import type { Snippet } from "svelte";
  import { cn } from "../lib/ui.ts";

  // trailing renders inside the same track, so a menu button can sit at the end of the row.
  let {
    options,
    value = $bindable(),
    label,
    size = "sm",
    onchange,
    trailing,
  }: {
    options: { value: T; label: string }[];
    value: T;
    label: string;
    size?: "xs" | "sm";
    onchange?: (value: T) => void;
    trailing?: Snippet;
  } = $props();

  function pick(next: T) {
    if (next === value) return;
    value = next;
    onchange?.(next);
  }
</script>

<div class="inline-flex max-w-full flex-wrap items-center rounded-lg bg-fill p-0.5">
  <div role="radiogroup" aria-label={label} class="inline-flex">
    {#each options as o (o.value)}
      <button
        type="button"
        role="radio"
        aria-checked={value === o.value}
        onclick={() => pick(o.value)}
        class={cn(
          "rounded-md font-medium text-label transition-colors focus-visible:ring-[3px] focus-visible:ring-accent-soft focus-visible:outline-none",
          size === "sm" ? "h-6 px-3 text-[13px]" : "h-[22px] px-2.5 text-[12px]",
          value === o.value ? "bg-seg-on shadow-[0_1px_2px_rgb(0_0_0/0.15)]" : "hover:bg-surface/50",
        )}>{o.label}</button
      >
    {/each}
  </div>
  {@render trailing?.()}
</div>

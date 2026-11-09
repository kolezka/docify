<script lang="ts" generics="T extends string">
  import { cn } from "../lib/ui.ts";

  let {
    options,
    value = $bindable(),
    label,
    size = "sm",
    onchange,
  }: { options: { value: T; label: string }[]; value: T; label: string; size?: "xs" | "sm"; onchange?: (value: T) => void } = $props();

  function pick(next: T) {
    if (next === value) return;
    value = next;
    onchange?.(next);
  }
</script>

<div role="radiogroup" aria-label={label} class="inline-flex max-w-full flex-wrap rounded-md border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-700 dark:bg-zinc-950">
  {#each options as o (o.value)}
    <button
      type="button"
      role="radio"
      aria-checked={value === o.value}
      onclick={() => pick(o.value)}
      class={cn(
        "rounded border font-medium transition-colors",
        size === "sm" ? "px-3 py-1 text-[13px]" : "px-2 py-0.5 text-[12px]",
        value === o.value
          ? "border-zinc-200/60 bg-white text-zinc-900 shadow-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          : "border-transparent text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
      )}>{o.label}</button
    >
  {/each}
</div>

<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "../lib/ui.ts";

  // A sheet attached to the top of the window, as on macOS. Native <dialog>: focus stays inside, Esc closes.
  let {
    open = $bindable(false),
    title,
    width = 520,
    children,
    footer,
    class: className = "",
  }: { open: boolean; title: string; width?: number; children: Snippet; footer?: Snippet; class?: string } = $props();

  let dialog: HTMLDialogElement | undefined = $state();

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });
</script>

<dialog
  bind:this={dialog}
  aria-label={title}
  onclose={() => (open = false)}
  style:width={`min(${width}px, 100vw)`}
  class={cn(
    "mx-auto mt-0 max-h-[85dvh] overflow-hidden rounded-b-[14px] border border-t-0 border-sep bg-window p-0 text-label shadow-[0_20px_60px_rgb(0_0_0/0.3)] backdrop:bg-black/20 dark:backdrop:bg-black/45",
    className,
  )}
>
  {#if open}
    <div class="flex max-h-[85dvh] flex-col">
      <div class="min-h-0 flex-1 overflow-y-auto px-[22px] pt-[22px] pb-1.5">
        {@render children()}
      </div>
      {#if footer}<div class="flex shrink-0 items-center justify-between gap-3 px-[22px] pt-3.5 pb-[18px]">{@render footer()}</div>{/if}
    </div>
  {/if}
</dialog>

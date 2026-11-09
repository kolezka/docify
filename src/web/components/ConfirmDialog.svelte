<script lang="ts">
  import Sheet from "./Sheet.svelte";
  import { button } from "../lib/ui.ts";

  // Destructive confirmation with explicit buttons and no timer (HIG Accessibility > Cognitive).
  let {
    open = $bindable(false),
    title,
    message,
    confirmLabel,
    onconfirm,
  }: { open: boolean; title: string; message: string; confirmLabel: string; onconfirm: () => void } = $props();
</script>

<Sheet bind:open {title} width={420}>
  <h2 class="text-[17px] leading-[22px] font-semibold">{title}</h2>
  <p class="mt-2 text-[13px] leading-[18px] text-label2">{message}</p>
  {#snippet footer()}
    <span></span>
    <span class="flex gap-2.5">
      <button type="button" class={button({ size: "md" })} onclick={() => (open = false)}>Cancel</button>
      <button
        type="button"
        class={button({ intent: "confirm", size: "md" })}
        onclick={() => {
          open = false;
          onconfirm();
        }}>{confirmLabel}</button
      >
    </span>
  {/snippet}
</Sheet>

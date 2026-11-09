<script lang="ts">
  let {
    checked = $bindable(false),
    label,
    hideLabel = false,
    disabled = false,
  }: { checked: boolean; label: string; hideLabel?: boolean; disabled?: boolean } = $props();
</script>

<!-- relative: the hidden checkbox is absolutely positioned and must not stretch the page. -->
<label class="relative inline-flex cursor-pointer items-center gap-2.5 select-none has-disabled:cursor-default has-disabled:opacity-50">
  {#if !hideLabel}<span class="text-[13px] text-label">{label}</span>{/if}
  <input type="checkbox" role="switch" class="peer sr-only" aria-label={hideLabel ? label : undefined} {disabled} bind:checked />
  <span
    class="relative h-[22px] w-[38px] shrink-0 rounded-full bg-fill transition-colors peer-checked:bg-ok peer-focus-visible:ring-[3px] peer-focus-visible:ring-accent-soft after:absolute after:top-0.5 after:left-0.5 after:size-[18px] after:rounded-full after:bg-white after:shadow-[0_1px_2px_rgb(0_0_0/0.25)] after:transition-transform peer-checked:after:translate-x-4"
  ></span>
</label>

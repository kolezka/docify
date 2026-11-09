<script lang="ts">
  let { checked = $bindable(false), label }: { checked: boolean; label: string } = $props();
</script>

<!-- relative: the hidden checkbox is absolutely positioned and must not stretch the page. -->
<label class="relative inline-flex cursor-pointer items-center gap-3 select-none">
  <input type="checkbox" role="switch" class="peer sr-only" bind:checked />
  <span
    class="relative h-5 w-9 shrink-0 rounded-full bg-zinc-200 transition-colors peer-checked:bg-indigo-600 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500/40 after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-4 dark:bg-zinc-700 dark:peer-checked:bg-indigo-500"
  ></span>
  <span class="text-[13px] font-medium text-zinc-900 dark:text-zinc-100">{label}</span>
</label>

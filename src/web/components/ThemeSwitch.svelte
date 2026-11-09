<script lang="ts">
  import { applyTheme, loadTheme, type ThemeChoice } from "../lib/theme.ts";
  import { cn } from "../lib/ui.ts";

  let choice = $state<ThemeChoice>(loadTheme());

  const options: { value: ThemeChoice; label: string; paths: string[] }[] = [
    { value: "system", label: "System theme", paths: ["M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z", "M8 21h8", "M12 16v5"] },
    {
      value: "light",
      label: "Light theme",
      paths: ["M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8Z", "M12 2v2", "M12 20v2", "m4.93 4.93 1.41 1.41", "m17.66 17.66 1.41 1.41", "M2 12h2", "M20 12h2", "m6.34 17.66-1.41 1.41", "m19.07 4.93-1.41 1.41"],
    },
    { value: "dark", label: "Dark theme", paths: ["M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"] },
  ];

  function pick(next: ThemeChoice) {
    choice = next;
    applyTheme(next);
  }
</script>

<div role="radiogroup" aria-label="Theme" class="inline-flex rounded-md border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-700 dark:bg-zinc-950">
  {#each options as o (o.value)}
    <button
      type="button"
      role="radio"
      aria-checked={choice === o.value}
      aria-label={o.label}
      title={o.label}
      onclick={() => pick(o.value)}
      class={cn(
        "grid size-7 place-items-center rounded transition-colors",
        choice === o.value
          ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100"
          : "text-zinc-400 hover:text-zinc-900 dark:text-zinc-500 dark:hover:text-zinc-100",
      )}
    >
      <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        {#each o.paths as d (d)}<path {d} />{/each}
      </svg>
    </button>
  {/each}
</div>

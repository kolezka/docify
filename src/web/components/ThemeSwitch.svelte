<script lang="ts">
  import { Monitor, Moon, Sun } from "@lucide/svelte";
  import { applyTheme, loadTheme, type ThemeChoice } from "../lib/theme.ts";
  import { cn } from "../lib/ui.ts";

  let choice = $state<ThemeChoice>(loadTheme());

  const options = [
    { value: "system", label: "Match system appearance", icon: Monitor },
    { value: "light", label: "Light appearance", icon: Sun },
    { value: "dark", label: "Dark appearance", icon: Moon },
  ] as const;

  function pick(next: ThemeChoice) {
    choice = next;
    applyTheme(next);
  }
</script>

<div role="radiogroup" aria-label="Appearance" class="inline-flex rounded-lg bg-fill p-0.5">
  {#each options as o (o.value)}
    <button
      type="button"
      role="radio"
      aria-checked={choice === o.value}
      aria-label={o.label}
      title={o.label}
      onclick={() => pick(o.value)}
      class={cn(
        "grid h-6 w-8 place-items-center rounded-md text-label transition-colors focus-visible:ring-[3px] focus-visible:ring-accent-soft focus-visible:outline-none",
        choice === o.value ? "bg-seg-on shadow-[0_1px_2px_rgb(0_0_0/0.15)]" : "hover:bg-surface/50",
      )}
    >
      <o.icon size={14} strokeWidth={1.75} aria-hidden="true" />
    </button>
  {/each}
</div>

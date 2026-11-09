<script lang="ts">
  import { chip, cn, type ChipTone } from "../lib/ui.ts";

  // Status as a dot plus a word (HIG: never colour alone).
  let { tone = "neutral", label, dot = true, class: className = "" }: { tone?: ChipTone; label: string; dot?: boolean; class?: string } = $props();
  const styles = $derived(chip({ tone }));
</script>

<span class={cn(styles.base(), className)}>
  {#if dot}<span class={styles.dot()} aria-hidden="true"></span>{/if}
  {label}
</span>

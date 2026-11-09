<script lang="ts">
  import { CircleAlert, CircleCheck, Info, TriangleAlert } from "@lucide/svelte";
  import { cn } from "../lib/ui.ts";

  // A symbol for notes and log lines, so warnings and errors are not told apart by colour alone.
  let { tone, size = 14, class: className = "" }: { tone: "ok" | "warn" | "bad" | "info"; size?: number; class?: string } = $props();
  const Icon = $derived({ ok: CircleCheck, warn: TriangleAlert, bad: CircleAlert, info: Info }[tone]);
  const color = $derived({ ok: "text-ok-text", warn: "text-warn-text", bad: "text-bad-text", info: "text-label2" }[tone]);
  const name = $derived({ ok: "Done", warn: "Warning", bad: "Error", info: "Note" }[tone]);
</script>

<Icon {size} strokeWidth={2} class={cn("shrink-0", color, className)} aria-label={name} role="img" />

import { tv, type VariantProps } from "tailwind-variants";

// Class merging for components that take a `class` prop: the caller's classes win.
export { twMerge as cn } from "tailwind-merge";

// Apple HIG styling; tokens live in app.css and the rules in .design/design-system.md.

// A group of an inset grouped list, or any content surface.
export const panel = tv({
  base: "rounded-[10px] bg-surface",
});

// Section header above a group.
export const groupTitle = tv({
  base: "mx-3 mt-6 mb-1.5 text-[11px] leading-[14px] font-semibold tracking-[0.02em] text-label2 uppercase",
});

// One row in a group: label leading, value or control trailing, inset separator above every row but the first.
export const row = tv({
  base: "relative flex min-h-10 items-center gap-3 px-3.5 py-2 [&+&]:before:absolute [&+&]:before:top-0 [&+&]:before:right-0 [&+&]:before:left-3.5 [&+&]:before:h-px [&+&]:before:bg-sep/60 [&+&]:before:content-['']",
});

export const button = tv({
  base: "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors focus-visible:ring-[3px] focus-visible:ring-accent-soft focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
  variants: {
    intent: {
      // The default button: one per area, placed trailing.
      primary: "bg-accent text-white hover:brightness-110",
      secondary: "border border-sep bg-surface text-label shadow-[0_1px_1px_rgb(0_0_0/0.05)] hover:bg-fill2",
      // Kept for older call sites: a secondary button whose label is the accent.
      accent: "border border-sep bg-surface text-accent-text shadow-[0_1px_1px_rgb(0_0_0/0.05)] hover:bg-fill2",
      danger: "border border-sep bg-surface text-bad-text shadow-[0_1px_1px_rgb(0_0_0/0.05)] hover:bg-fill2",
      confirm: "bg-bad-fill text-white hover:brightness-110",
      ghost: "text-label hover:bg-fill",
      link: "px-0 text-accent-text hover:underline",
    },
    size: {
      // 24 px is the smallest bezeled button; the hit area stays above the 20 pt minimum.
      xs: "h-6 px-2.5 text-[12px]",
      sm: "h-7 px-3 text-[13px]",
      md: "h-7 px-4 text-[13px]",
    },
  },
  defaultVariants: { intent: "secondary", size: "sm" },
});

// Controls that float in the toolbar sit in glass capsules.
export const capsule = tv({
  base: "inline-flex h-[30px] items-center rounded-full border border-white/40 bg-glass shadow-float backdrop-blur-xl backdrop-saturate-150 dark:border-white/10",
});
export const capsuleButton = tv({
  base: "inline-flex h-[30px] min-w-[30px] items-center justify-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-label transition-colors hover:bg-fill/60 disabled:pointer-events-none disabled:opacity-50",
});

export const input = tv({
  base: "h-[26px] w-full min-w-0 rounded-md border border-sep bg-field px-2 text-[13px] text-label transition-colors placeholder:text-label2 focus:border-accent focus:ring-[3px] focus:ring-accent-soft focus:outline-none disabled:opacity-60",
  variants: {
    mono: { true: "font-mono" },
    invalid: {
      true: "border-bad focus:border-bad focus:ring-bad/25",
    },
  },
});

// A popup button: a native select styled as one.
export const popup = tv({
  base: "h-6 w-auto min-w-0 rounded-md border border-sep bg-fill2 py-0 pr-7 pl-2.5 text-[13px] text-label focus:border-accent focus:ring-[3px] focus:ring-accent-soft focus:outline-none disabled:opacity-60",
});

// Status: a coloured dot plus a word, never colour alone.
export const chip = tv({
  slots: {
    base: "inline-flex shrink-0 items-center gap-1.5 text-[13px] font-medium whitespace-nowrap",
    dot: "size-2 shrink-0 rounded-full",
  },
  variants: {
    tone: {
      ok: { base: "text-ok-text", dot: "bg-ok" },
      active: { base: "text-accent-text", dot: "bg-accent motion-safe:animate-pulse" },
      warn: { base: "text-warn-text", dot: "bg-warn" },
      bad: { base: "text-bad-text", dot: "bg-bad" },
      neutral: { base: "text-label2", dot: "bg-label3" },
    },
  },
  defaultVariants: { tone: "neutral" },
});
export type ChipTone = NonNullable<VariantProps<typeof chip>["tone"]>;

// Notes under or inside a group. Warnings and errors carry a symbol (StatusIcon) next to the text.
export const notice = tv({
  base: "flex gap-2 rounded-[10px] p-3 text-[13px] leading-[18px]",
  variants: {
    tone: {
      info: "bg-surface text-label2",
      warn: "bg-warn/10 text-warn-text",
      bad: "bg-bad/10 text-bad-text",
      ok: "bg-ok/10 text-ok-text",
    },
  },
  defaultVariants: { tone: "info" },
});

export const footnote = "text-[11px] leading-[14px] text-label2";

export function sourceTone(state: string): ChipTone {
  if (state === "ready") return "ok";
  if (state === "preparing") return "active";
  if (state === "stale" || state === "not_indexed") return "warn";
  if (state === "failed") return "bad";
  return "neutral";
}

export function sourceStateLabel(state: string): string {
  return { ready: "Ready", stale: "Last update stopped", preparing: "Preparing", failed: "Failed", not_indexed: "Not prepared" }[state] ?? state;
}

export function searchTone(status: string): ChipTone {
  if (status === "ok") return "ok";
  if (status === "weak_match") return "warn";
  if (status === "update_failed") return "bad";
  return "neutral";
}

// Readable wording for API statuses; the API names stay unchanged.
export function searchStatusLabel(status: string): string {
  return (
    {
      ok: "Good match",
      weak_match: "Weak match",
      no_match: "No match",
      not_indexed: "Not prepared",
      version_unavailable: "Version unavailable",
      source_unknown: "Unknown source",
      update_failed: "Update failed",
    }[status] ?? status
  );
}

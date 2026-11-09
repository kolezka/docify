import { tv, type VariantProps } from "tailwind-variants";

// Class merging for components that take a `class` prop: the caller's classes win.
export { twMerge as cn } from "tailwind-merge";

export const panel = tv({
  base: "rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:shadow-none",
});

export const button = tv({
  base: "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500/40 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
  variants: {
    intent: {
      primary: "bg-indigo-600 text-white hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-400",
      secondary:
        "border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800",
      accent:
        "border border-zinc-200 bg-white text-indigo-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-indigo-400 dark:hover:bg-zinc-800",
      danger:
        "border border-zinc-200 bg-white text-rose-600 hover:bg-rose-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-rose-400 dark:hover:bg-rose-500/10",
      confirm: "bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-500 dark:hover:bg-rose-400",
      ghost: "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100",
    },
    size: {
      xs: "h-[26px] px-2 text-[12px]",
      sm: "h-8 px-3 text-[13px]",
      md: "h-9 px-4 text-[13px]",
    },
  },
  defaultVariants: { intent: "secondary", size: "sm" },
});

export const input = tv({
  base: "h-8 w-full min-w-0 rounded-md border border-zinc-200 bg-white px-2.5 text-[13px] text-zinc-900 transition-colors placeholder:text-zinc-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/40 focus:outline-none disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-indigo-400",
  variants: {
    mono: { true: "font-mono" },
    invalid: {
      true: "border-rose-300 text-rose-900 focus:border-rose-500 focus:ring-rose-500/40 dark:border-rose-500/60 dark:text-rose-200 dark:focus:border-rose-400",
    },
  },
});

export const chip = tv({
  slots: {
    base: "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[12px] font-medium whitespace-nowrap",
    dot: "size-1.5 rounded-full",
  },
  variants: {
    tone: {
      ok: { base: "border-emerald-200/60 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300", dot: "bg-emerald-500" },
      active: { base: "border-indigo-200/60 bg-indigo-50 text-indigo-700 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-300", dot: "animate-pulse bg-indigo-500" },
      warn: { base: "border-amber-200/60 bg-amber-50 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300", dot: "bg-amber-500" },
      bad: { base: "border-rose-200/60 bg-rose-50 text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-300", dot: "bg-rose-500" },
      neutral: { base: "border-zinc-200 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300", dot: "bg-zinc-400" },
    },
  },
  defaultVariants: { tone: "neutral" },
});
export type ChipTone = NonNullable<VariantProps<typeof chip>["tone"]>;

export const notice = tv({
  base: "rounded-md border p-3 text-[13px] leading-relaxed",
  variants: {
    tone: {
      info: "border-zinc-200/60 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400",
      warn: "border-amber-200/60 bg-amber-50 text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200",
      bad: "border-rose-200/60 bg-rose-50 text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200",
      ok: "border-emerald-200/60 bg-emerald-50 text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200",
    },
  },
  defaultVariants: { tone: "info" },
});

export function sourceTone(state: string): ChipTone {
  if (state === "ready") return "ok";
  if (state === "preparing") return "active";
  if (state === "stale" || state === "not_indexed") return "warn";
  if (state === "failed") return "bad";
  return "neutral";
}

export function searchTone(status: string): ChipTone {
  if (status === "ok") return "ok";
  if (status === "weak_match") return "warn";
  if (status === "update_failed") return "bad";
  return "neutral";
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

// "embed 120/480" -> 0.25; null when the text carries no count.
export function fraction(text: string | null | undefined): number | null {
  const m = /(\d+)\s*\/\s*(\d+)/.exec(text ?? "");
  if (!m) return null;
  const total = Number(m[2]);
  return total > 0 ? Math.min(1, Number(m[1]) / total) : null;
}

// What the graph row says about coverage. `ignored` counts pages kept out by the source's graphIgnore patterns.
export function graphCoverage(status: string | null, missing: number, ignored: number): string | undefined {
  const pages = (n: number) => `${n} ${n === 1 ? "page" : "pages"}`;
  const left = ignored ? `${pages(ignored)} left out by ignore patterns` : "";
  if (status === "ok") return left ? `${left}. Every other page has graph nodes` : "Every page has graph nodes";
  if (status === "partial") return `${pages(missing)} ${missing === 1 ? "has" : "have"} no graph nodes${left ? `. ${left}` : ""}`;
  // A graph that was wanted is skipped only when no page was left to build it from.
  if (status === "skipped" && ignored) return "Every page matches the ignore patterns, so no graph was built";
  return undefined;
}

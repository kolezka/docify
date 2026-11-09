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

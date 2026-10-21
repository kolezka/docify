// Dotted API names (Bun.password.hash, db.fileControl, hashlib.sha256) are split by the
// FTS tokenizer, so they are also indexed squashed ("bunpasswordhash") for exact symbol hits.
const DOTTED = /(?:[A-Za-z_$][\w$]*)?(?:\.[A-Za-z_$][\w$]*)+/g;

export function squash(symbol: string): string {
  return symbol.replace(/^\./, "").replace(/[.$]/g, "").toLowerCase();
}

export function extractSymbols(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(DOTTED)) {
    const s = m[0];
    if (/^\.\d/.test(s) || s.length < 4) continue;
    if (/\.(md|mdx|html|js|ts|com|org|io|svg|png|json)$/i.test(s)) continue;
    out.add(squash(s));
    const parts = s.split(".").filter(Boolean);
    // Suffixes let "password.hash" or ".hash" style queries match "Bun.password.hash".
    for (let i = 1; i < parts.length - 1; i++) out.add(squash(parts.slice(i).join(".")));
  }
  return [...out];
}

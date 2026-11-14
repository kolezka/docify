// Node search for the graph view: free text plus `key:value` filters, ranked. Pure, so `bun test` can run it.
// It searches what the graph API already sent to the browser; nothing here reaches the server.

export interface SearchNode {
  id: string;
  label: string;
  type: string;
  page: string | null;
  // Label of the node's hyperedge group, if it has one.
  group: string | null;
  grounded: boolean;
  degree: number;
  // Heading path and excerpt of the grounding passage.
  text: string;
}

export interface GraphQuery {
  terms: string[];
  types: string[];
  pages: string[];
  groups: string[];
  // true for is:grounded, false for is:ungrounded.
  grounded: boolean | null;
  minLinks: number;
}

export type MatchField = "label" | "id" | "page" | "group" | "text" | "filter";

export interface SearchHit {
  index: number;
  score: number;
  // The weakest field a term matched in, so the list can say why a node is there.
  field: MatchField;
}

// Letters NFD does not split into base plus accent.
const PLAIN: Record<string, string> = { ł: "l", ø: "o", đ: "d", ı: "i", æ: "a", œ: "o" };

// Lower case without accents. One output character per input code unit, so match offsets fit the original text.
export function fold(text: string): string {
  if (/^[\x00-\x7f]*$/.test(text)) return text.toLowerCase();
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const lower = text[i]!.toLowerCase().normalize("NFD")[0] ?? text[i]!;
    out += PLAIN[lower] ?? lower;
  }
  return out;
}

const TOKEN = /(\w+):"([^"]*)"|"([^"]*)"|(\S+)/g;
export const FILTER_KEYS = ["type", "page", "group", "is", "links"];

export function parseQuery(input: string): GraphQuery {
  const query: GraphQuery = { terms: [], types: [], pages: [], groups: [], grounded: null, minLinks: 0 };
  for (const m of input.matchAll(TOKEN)) {
    let key = m[1]?.toLowerCase();
    let value = m[2];
    if (m[4] !== undefined) {
      const colon = m[4].indexOf(":");
      if (colon > 0) {
        key = m[4].slice(0, colon).toLowerCase();
        value = m[4].slice(colon + 1);
      }
    }
    const folded = fold(value ?? "").trim();
    // A filter still being typed (`type:`, `is:gr`) must not empty the result list.
    if (key && FILTER_KEYS.includes(key) && !folded) continue;
    if (key === "type") query.types.push(folded);
    else if (key === "page") query.pages.push(folded);
    else if (key === "group") query.groups.push(folded);
    else if (key === "is" && "grounded".startsWith(folded)) query.grounded = true;
    else if (key === "is" && "ungrounded".startsWith(folded)) query.grounded = false;
    else if (key === "links" && /^(>=|>)?\d+$/.test(folded)) query.minLinks = Number(folded.replace(/^>=?/, "")) + (/^>\d/.test(folded) ? 1 : 0);
    else if (key === "links" && /^>=?$/.test(folded)) continue;
    else {
      // Not a filter: a quoted phrase, a plain word, or text that merely holds a colon (a URL, `std::vector`).
      const term = fold(m[3] ?? m[4] ?? `${m[1]}:${m[2]}`).trim();
      if (term) query.terms.push(term);
    }
  }
  return query;
}

export function isEmptyQuery(q: GraphQuery): boolean {
  return !q.terms.length && !q.types.length && !q.pages.length && !q.groups.length && q.grounded === null && q.minLinks <= 0;
}

const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);

function labelScore(label: string, term: string): number {
  const at = label.indexOf(term);
  if (at < 0) return 0;
  if (label.length === term.length) return 100;
  if (at === 0) return 80;
  for (let i = at; i >= 0; i = label.indexOf(term, i + 1)) if (!isWordChar(label[i - 1])) return 60;
  return 40;
}

export interface GraphSearch {
  search(query: string | GraphQuery, limit?: number): SearchHit[];
}

// Folds every field once, so each keystroke only compares strings.
export function createGraphSearch(nodes: readonly SearchNode[]): GraphSearch {
  const index = nodes.map((n) => ({
    label: fold(n.label),
    id: fold(n.id),
    type: fold(n.type),
    page: fold(n.page ?? ""),
    group: fold(n.group ?? ""),
    text: fold(n.text),
  }));

  return {
    search(input, limit = Infinity) {
      const q = typeof input === "string" ? parseQuery(input) : input;
      if (isEmptyQuery(q)) return [];
      const hits: SearchHit[] = [];
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]!;
        const f = index[i]!;
        // Values of one filter are alternatives; different filters must all hold.
        if (q.types.length && !q.types.some((t) => f.type.startsWith(t))) continue;
        if (q.pages.length && !q.pages.some((p) => f.page.includes(p))) continue;
        if (q.groups.length && !q.groups.some((g) => f.group.includes(g))) continue;
        if (q.grounded !== null && node.grounded !== q.grounded) continue;
        if (node.degree < q.minLinks) continue;

        let score = 0;
        let weakest = Infinity;
        let field: MatchField = q.terms.length ? "label" : "filter";
        let matched = true;
        for (const term of q.terms) {
          let best = labelScore(f.label, term);
          let where: MatchField = "label";
          const other: [MatchField, string, number][] = [["id", f.id, 20], ["page", f.page, 16], ["group", f.group, 14], ["text", f.text, 8]];
          for (const [name, value, points] of other) {
            if (points > best && value.includes(term)) {
              best = points;
              where = name;
            }
          }
          if (!best) {
            matched = false;
            break;
          }
          score += best;
          if (best < weakest) {
            weakest = best;
            field = where;
          }
        }
        if (!matched) continue;
        hits.push({ index: i, score: score + Math.min(node.degree, 50) * 0.1, field });
      }
      hits.sort((a, b) => b.score - a.score || nodes[b.index]!.degree - nodes[a.index]!.degree || nodes[a.index]!.label.localeCompare(nodes[b.index]!.label) || a.index - b.index);
      return hits.length > limit ? hits.slice(0, limit) : hits;
    },
  };
}

// Where the terms occur in `text`, as merged [start, end) ranges, for marking matches in a list.
export function matchRanges(text: string, terms: readonly string[]): [number, number][] {
  const folded = fold(text);
  const ranges: [number, number][] = [];
  for (const term of terms) {
    if (!term) continue;
    for (let at = folded.indexOf(term); at >= 0; at = folded.indexOf(term, at + term.length)) ranges.push([at, at + term.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

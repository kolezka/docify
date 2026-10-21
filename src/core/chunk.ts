import { countTokens } from "./tokens.ts";

export interface Chunk {
  headingPath: string[];
  anchor: string | null;
  startLine: number; // 1-based, inclusive, normalized document lines
  endLine: number;
  text: string;
  hasCode: boolean;
  hasWarning: boolean;
}

export const MAX_PASSAGE_TOKENS = 700;
const WARNING_RE = /^>\s*\*\*(Warning|Caution|Danger|Important|Deprecated|Note|Tip|Attention):\*\*/m;

// Splits a normalized document into heading sections, then splits oversized sections
// on blank lines outside code fences. A fence is never cut.
export function chunk(markdown: string, anchors: Map<number, string> = new Map()): Chunk[] {
  const lines = markdown.split("\n");
  const sections: { path: string[]; anchor: string | null; start: number; end: number }[] = [];
  const stack: { level: number; title: string }[] = [];
  let current = { path: [] as string[], anchor: null as string | null, start: 1, end: 0 };
  let inFence = false;
  lines.forEach((line, idx) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = !inFence && /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (h) {
      current.end = idx;
      sections.push(current);
      const level = h[1]!.length;
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, title: h[2]!.replace(/`/g, "") });
      current = { path: stack.map((s) => s.title), anchor: anchors.get(idx + 1) ?? slug(h[2]!), start: idx + 1, end: 0 };
    }
  });
  current.end = lines.length;
  sections.push(current);

  const chunks: Chunk[] = [];
  for (const s of sections) {
    const body = lines.slice(s.start - 1, s.end);
    if (!body.some((l) => l.trim() && !/^#{1,6}\s/.test(l))) continue;
    for (const piece of splitSection(body, s.start)) {
      const text = trimBlank(piece.lines);
      if (!text.text.trim()) continue;
      chunks.push({
        headingPath: s.path,
        anchor: s.anchor,
        startLine: piece.start + text.skipped,
        endLine: piece.start + text.skipped + text.count - 1,
        text: text.text,
        hasCode: /^\s*(```|~~~)/m.test(text.text),
        hasWarning: WARNING_RE.test(text.text),
      });
    }
  }
  return chunks;
}

function splitSection(body: string[], start: number): { lines: string[]; start: number }[] {
  if (countTokens(body.join("\n")) <= MAX_PASSAGE_TOKENS) return [{ lines: body, start }];
  // Paragraph blocks, fences kept whole.
  const blocks: { lines: string[]; start: number }[] = [];
  let cur: string[] = [];
  let curStart = start;
  let inFence = false;
  body.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    cur.push(line);
    if (!inFence && line.trim() === "") {
      blocks.push({ lines: cur, start: curStart });
      cur = [];
      curStart = start + i + 1;
    }
  });
  if (cur.length) blocks.push({ lines: cur, start: curStart });

  const out: { lines: string[]; start: number }[] = [];
  let acc: string[] = [];
  let accStart = start;
  let accTokens = 0;
  for (const b of blocks) {
    const t = countTokens(b.lines.join("\n"));
    if (acc.length && accTokens + t > MAX_PASSAGE_TOKENS) {
      out.push({ lines: acc, start: accStart });
      acc = [];
      accTokens = 0;
      accStart = b.start;
    }
    acc.push(...b.lines);
    accTokens += t;
  }
  if (acc.length) out.push({ lines: acc, start: accStart });
  return out;
}

function trimBlank(lines: string[]) {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a]!.trim()) a++;
  while (b > a && !lines[b - 1]!.trim()) b--;
  return { text: lines.slice(a, b).join("\n"), skipped: a, count: b - a };
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

import { NodeHtmlMarkdown } from "node-html-markdown";

export type DocKind = "markdown" | "mdx" | "html";

export interface NormalizedDoc {
  title: string | null;
  markdown: string;
  // True when normalized line N is raw line N, so citations can point at the raw file.
  linesMatchRaw: boolean;
  // Heading anchor by normalized line number (1-based), used for URL citations.
  anchors: Map<number, string>;
}

const ADMONITION_TAGS = ["Note", "Warning", "Tip", "Info", "Caution", "Danger", "Important", "Callout"];
const WARNING_WORDS = ["Note", "Warning", "Caution", "Danger", "Important", "Tip", "Attention", "Deprecated", "Hint", "See also"];

export function kindFromPath(path: string): DocKind | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".mdx")) return "mdx";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  return null;
}

export function normalize(raw: string, kind: DocKind): NormalizedDoc {
  return kind === "html" ? normalizeHtml(raw) : normalizeMarkdown(raw);
}

// Rewrites MDX components and Markdoc tags line by line, keeping the line count,
// so a normalized line range is also the raw line range.
function normalizeMarkdown(raw: string): NormalizedDoc {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let title: string | null = null;
  let inFence: string | null = null;
  let inFrontmatter = lines[0]?.trim() === "---";
  let quoteDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (inFrontmatter) {
      const m = /^title:\s*["']?(.+?)["']?\s*$/.exec(line);
      if (m) title = m[1]!;
      if (i > 0 && line.trim() === "---") inFrontmatter = false;
      out.push("");
      continue;
    }
    const fence = /^\s*(```+|~~~+)/.exec(line);
    if (inFence) {
      if (fence && fence[1]!.startsWith(inFence)) inFence = null;
      out.push(quoteDepth ? "> " + line : line);
      continue;
    }
    if (fence) {
      inFence = fence[1]!;
      out.push(quoteDepth ? "> " + line : line);
      continue;
    }
    const trimmed = line.trim();
    if (/^(import|export)\s.+/.test(trimmed) && !title && out.every((l) => l === "")) {
      out.push("");
      continue;
    }
    const open = new RegExp(`^<(${ADMONITION_TAGS.join("|")})(\\s[^>]*)?>(.*)$`).exec(trimmed);
    const markdocOpen = /^\{%\s*callout[^%]*%\}(.*)$/.exec(trimmed);
    if (open || markdocOpen) {
      const label = open ? (open[1] === "Callout" ? "Note" : open[1]!) : "Note";
      let rest = (open ? open[3] : markdocOpen![1])!.trim();
      const closesInline = new RegExp(`</(${ADMONITION_TAGS.join("|")})>$|\\{%\\s*/callout\\s*%\\}$`).exec(rest);
      if (closesInline) rest = rest.slice(0, closesInline.index).trim();
      out.push(`> **${label}:**${rest ? " " + rest : ""}`);
      if (!closesInline) quoteDepth++;
      continue;
    }
    if (new RegExp(`^</(${ADMONITION_TAGS.join("|")})>$`).test(trimmed) || /^\{%\s*\/callout\s*%\}$/.test(trimmed)) {
      quoteDepth = Math.max(0, quoteDepth - 1);
      out.push("");
      continue;
    }
    // Disclosure blocks keep their summary as bold text.
    const summary = /^<Accordion\s+title="([^"]*)"\s*>$/.exec(trimmed) ?? /^\{%\s*details\s+summary="([^"]*)"\s*%\}$/.exec(trimmed);
    if (summary) {
      out.push(`**${summary[1]}**`);
      continue;
    }
    const caption = /caption="([^"]*)"/.exec(trimmed);
    if (/^<\/?[A-Z][A-Za-z]*(\s[^>]*)?\/?>$/.test(trimmed) || /^\{%.*%\}$/.test(trimmed)) {
      out.push(caption ? `_${caption[1]}_` : "");
      continue;
    }
    out.push(quoteDepth ? (trimmed ? "> " + line : ">") : line);
  }
  if (!title) {
    const h1 = out.find((l) => /^# /.test(l));
    if (h1) title = h1.slice(2).trim();
  }
  return { title, markdown: out.join("\n"), linesMatchRaw: true, anchors: new Map() };
}

function normalizeHtml(raw: string): NormalizedDoc {
  const main =
    /<div class="body" role="main">([\s\S]*?)<div class="sphinxsidebar"/.exec(raw)?.[1] ??
    /<main[^>]*>([\s\S]*?)<\/main>/i.exec(raw)?.[1] ??
    /<article[^>]*>([\s\S]*?)<\/article>/i.exec(raw)?.[1] ??
    /<body[^>]*>([\s\S]*?)<\/body>/i.exec(raw)?.[1] ??
    raw;
  const cleaned = main
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "");
  const md = NodeHtmlMarkdown.translate(cleaned, { codeFence: "```", keepDataImages: false });
  const anchors = new Map<number, string>();
  const out: string[] = [];
  const lines = md.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (/^```/.test(line)) inFence = !inFence;
    if (inFence || /^```/.test(line)) {
      out.push(line);
      continue;
    }
    const heading = /^(#{1,6} .*?)\[¶\]\(#([^ )]+)[^)]*\)\s*$/.exec(line);
    if (heading) {
      line = heading[1]!.trimEnd();
      anchors.set(out.length + 1, decodeURIComponent(heading[2]!));
    }
    // Sphinx renders admonition titles as a lone word paragraph; turn the block into a quote.
    if (WARNING_WORDS.includes(line.trim()) && lines[i + 1]?.trim() === "") {
      out.push(`> **${line.trim()}:**`);
      out.push(">");
      i += 2;
      while (i < lines.length && lines[i]!.trim() !== "") out.push("> " + lines[i++]);
      out.push("");
      continue;
    }
    out.push(line.replace(/\[¶\]\(#[^)]*\)/g, ""));
  }
  const title = out.find((l) => /^# /.test(l))?.slice(2).trim() ?? /<title>([^<]*)<\/title>/i.exec(raw)?.[1]?.trim() ?? null;
  return { title, markdown: out.join("\n"), linesMatchRaw: false, anchors };
}

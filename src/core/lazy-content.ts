// A lazy Livewire component is not in the page at first: the server renders a placeholder and
// puts the component's data, HTML-escaped, into a wire:snapshot attribute. A browser asks for the
// real markup later, so a plain fetch and a render that returns early both see an empty article.
// Once loaded, the page holds the text twice (markup and data) next to the site navigation.

const HTML_BLOCK = /<(?:h[1-6]|p|pre|ul|ol|table)\b/i;
const ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&", nbsp: "\u00a0" };

// One pass, so an escaped entity (&amp;lt;) stays an entity (&lt;) in the decoded value.
function decodeEntities(value: string): string {
  return value.replace(/&(#\d+|#x[0-9a-f]+|lt|gt|quot|apos|amp|nbsp);/gi, (whole, name: string) => {
    if (name[0] !== "#") return ENTITIES[name.toLowerCase()]!;
    const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// Every lazy component of the page with the longest HTML string in its data, and whether it has loaded.
function lazyComponents(page: string): { html: string; loaded: boolean }[] {
  const found: { html: string; loaded: boolean }[] = [];
  for (const match of page.matchAll(/\swire:snapshot="([^"]*)"/g)) {
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(decodeEntities(match[1]!));
    } catch {
      continue;
    }
    if (!isRecord(snapshot) || !isRecord(snapshot.memo) || typeof snapshot.memo.lazyLoaded !== "boolean") continue;
    let html = "";
    const pending: unknown[] = [snapshot.data];
    while (pending.length) {
      const value = pending.pop();
      if (typeof value === "string") {
        if (value.length > html.length && HTML_BLOCK.test(value)) html = value;
      } else if (Array.isArray(value)) pending.push(...value);
      else if (isRecord(value)) pending.push(...Object.values(value));
    }
    if (html) found.push({ html, loaded: snapshot.memo.lazyLoaded });
  }
  return found;
}

// What a reader sees, without spacing, so the same text in different markup compares equal.
const shownText = (html: string) => decodeEntities(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "").replace(/<[^>]*>/g, "")).replace(/\s+/g, "");

// The document to keep for a page whose article is the text of a lazy component, or null when the
// page should be kept as it is. The article is that text when it is still empty, or when it shows
// the component's text and little else. The same bytes come out whether the component had loaded,
// so the snapshot does not change with how long a renderer waited.
export function lazyPageContent(page: string): string | null {
  if (!page.includes("wire:snapshot=")) return null;
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(page)?.[1];
  if (article === undefined) return null;
  const shown = shownText(article);
  const isArticle = (c: { html: string; loaded: boolean }) => {
    if (shown === "") return !c.loaded;
    const carried = shownText(c.html);
    // A component that is a small part of the article would drop the rest of it.
    return carried.length * 2 >= shown.length && shown.includes(carried);
  };
  const html = lazyComponents(page)
    .filter(isArticle)
    .reduce((longest, c) => (c.html.length > longest.length ? c.html : longest), "");
  if (!html) return null;
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(page)?.[1]?.trim() ?? "";
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title></head><body>\n${html}\n</body></html>\n`;
}

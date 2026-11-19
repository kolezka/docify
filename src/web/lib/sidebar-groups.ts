// Sidebar sections: one per source group, then ungrouped sources. A source in two groups shows in both.
export type SidebarSection<T> = { group: string | null; sources: T[] };

export function sidebarSections<T extends { groups?: string[] }>(list: T[]): SidebarSection<T>[] {
  const byGroup = new Map<string, T[]>();
  const ungrouped: T[] = [];
  for (const s of list) {
    const groups = s.groups ?? [];
    if (!groups.length) ungrouped.push(s);
    for (const g of groups) {
      const members = byGroup.get(g);
      if (members) members.push(s);
      else byGroup.set(g, [s]);
    }
  }
  const sections: SidebarSection<T>[] = [...byGroup.keys()].sort().map((group) => ({ group, sources: byGroup.get(group)! }));
  if (ungrouped.length) sections.push({ group: null, sources: ungrouped });
  return sections;
}

// Collapsed sections are remembered per browser. Ungrouped sources use this key.
export const UNGROUPED_KEY = "";
const KEY = "docify-sidebar-collapsed";

export function parseCollapsed(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const value: unknown = JSON.parse(raw);
    return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

// Storage can be blocked (private windows, strict settings); collapsing then lasts for this page only.
export function loadCollapsed(): Set<string> {
  try {
    return parseCollapsed(localStorage.getItem(KEY));
  } catch {
    return new Set();
  }
}

export function saveCollapsed(collapsed: Set<string>) {
  try {
    if (collapsed.size) localStorage.setItem(KEY, JSON.stringify([...collapsed].sort()));
    else localStorage.removeItem(KEY);
  } catch {
    // remembered for this page only
  }
}

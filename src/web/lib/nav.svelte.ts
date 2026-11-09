// Which view the window shows. "source" shows one source's page; "new-source" opens the add sheet over it.
export type View = "search" | "graph" | "logs" | "settings" | "source";

const KEY = "docify-nav";

function load(): { view: View; sourceId: string | null } {
  try {
    const raw = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
    if (raw && ["search", "graph", "logs", "settings", "source"].includes(raw.view)) {
      return { view: raw.view, sourceId: typeof raw.sourceId === "string" ? raw.sourceId : null };
    }
  } catch {
    // fall through to the default
  }
  return { view: "search", sourceId: null };
}

class Nav {
  view = $state<View>("search");
  sourceId = $state<string | null>(null);
  addingSource = $state(false);

  constructor() {
    const saved = load();
    this.view = saved.view;
    this.sourceId = saved.sourceId;
  }

  go(view: Exclude<View, "source">) {
    this.view = view;
    this.save();
  }

  openSource(id: string) {
    this.view = "source";
    this.sourceId = id;
    this.save();
  }

  save() {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ view: this.view, sourceId: this.sourceId }));
    } catch {
      // the view is then not kept across reloads
    }
  }
}

export const nav = new Nav();

// Option+digit and Option+N. Command shortcuts belong to the browser (Find, Settings), so they are not taken.
export const shortcuts: { code: string; label: string; run: () => void }[] = [
  { code: "Digit1", label: "⌥1", run: () => nav.go("search") },
  { code: "Digit2", label: "⌥2", run: () => nav.go("graph") },
  { code: "Digit3", label: "⌥3", run: () => nav.go("logs") },
  { code: "Digit4", label: "⌥4", run: () => nav.go("settings") },
  { code: "KeyN", label: "⌥N", run: () => (nav.addingSource = true) },
];

export function handleShortcut(event: KeyboardEvent): boolean {
  if (!event.altKey || event.metaKey || event.ctrlKey) return false;
  const hit = shortcuts.find((s) => s.code === event.code);
  if (!hit) return false;
  event.preventDefault();
  hit.run();
  return true;
}

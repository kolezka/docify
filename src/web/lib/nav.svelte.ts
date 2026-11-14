import { session } from "./session.svelte.ts";
import { matchShortcut } from "./shortcuts.ts";

// Which view the window shows. "source" shows one source's page; "new-source" opens the add sheet over it.
export type View = "search" | "graph" | "logs" | "settings" | "users" | "source";

// Logs, settings and users are for administrators. The server refuses the calls anyway;
// this keeps a member from landing on a view that can only show an error.
export const ADMIN_VIEWS: readonly View[] = ["logs", "settings", "users"];

const KEY = "docify-nav";

function load(): { view: View; sourceId: string | null } {
  try {
    const raw = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
    if (raw && ["search", "graph", "logs", "settings", "users", "source"].includes(raw.view)) {
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

  // What to show: the chosen view, or Search when this person may not open it.
  get shown(): View {
    if (ADMIN_VIEWS.includes(this.view) && !session.admin) return "search";
    if (this.view === "users" && !session.accounts) return "search";
    return this.view;
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
  { code: "Digit5", label: "⌥5", run: () => nav.go("users") },
  { code: "KeyN", label: "⌥N", run: () => session.admin && (nav.addingSource = true) },
];

export function handleShortcut(event: KeyboardEvent): boolean {
  if (!session.ready) return false;
  const hit = matchShortcut(event, shortcuts, document.querySelector("dialog[open]") !== null);
  if (!hit) return false;
  event.preventDefault();
  hit.run();
  return true;
}

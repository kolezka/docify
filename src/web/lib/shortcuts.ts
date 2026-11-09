// Option+key shortcuts. Option+letter types characters (Option+N is the tilde dead key on a Mac),
// so nothing fires while the user is typing, composing text or inside a modal.

export interface ShortcutEvent {
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  code: string;
  defaultPrevented: boolean;
  isComposing: boolean;
  target: EventTarget | null;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

export function matchShortcut<T extends { code: string }>(event: ShortcutEvent, shortcuts: readonly T[], modalOpen: boolean): T | null {
  if (!event.altKey || event.metaKey || event.ctrlKey) return null;
  if (event.defaultPrevented || event.isComposing || modalOpen || isEditableTarget(event.target)) return null;
  return shortcuts.find((s) => s.code === event.code) ?? null;
}

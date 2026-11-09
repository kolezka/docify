import { expect, test } from "bun:test";
import { isEditableTarget, matchShortcut, type ShortcutEvent } from "../src/web/lib/shortcuts.ts";

const shortcuts = [{ code: "KeyN" }, { code: "Digit1" }];
const press = (over: Partial<ShortcutEvent> = {}): ShortcutEvent => ({
  altKey: true,
  metaKey: false,
  ctrlKey: false,
  code: "KeyN",
  defaultPrevented: false,
  isComposing: false,
  target: { tagName: "BODY" } as unknown as EventTarget,
  ...over,
});

test("Option shortcuts fire on the page but never while typing, composing, handled or in a modal", () => {
  expect(matchShortcut(press(), shortcuts, false)?.code).toBe("KeyN");
  expect(matchShortcut(press({ code: "Digit1" }), shortcuts, false)?.code).toBe("Digit1");

  for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
    expect(matchShortcut(press({ target: { tagName } as unknown as EventTarget }), shortcuts, false)).toBeNull();
  }
  expect(matchShortcut(press({ target: { tagName: "DIV", isContentEditable: true } as unknown as EventTarget }), shortcuts, false)).toBeNull();
  expect(matchShortcut(press({ isComposing: true }), shortcuts, false)).toBeNull();
  expect(matchShortcut(press({ defaultPrevented: true }), shortcuts, false)).toBeNull();
  expect(matchShortcut(press(), shortcuts, true)).toBeNull();

  // Command and Control combinations belong to the browser.
  expect(matchShortcut(press({ metaKey: true }), shortcuts, false)).toBeNull();
  expect(matchShortcut(press({ ctrlKey: true }), shortcuts, false)).toBeNull();
  expect(matchShortcut(press({ altKey: false }), shortcuts, false)).toBeNull();
});

test("only form fields and editable content count as typing targets", () => {
  expect(isEditableTarget(null)).toBe(false);
  expect(isEditableTarget({ tagName: "BUTTON" } as unknown as EventTarget)).toBe(false);
  expect(isEditableTarget({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
});

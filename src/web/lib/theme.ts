export type ThemeChoice = "system" | "light" | "dark";

const KEY = "docify-theme";

// Storage can be blocked (private windows, strict settings); the page then just follows the OS.
export function loadTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  root.classList.toggle("dark", choice === "dark");
  root.classList.toggle("light", choice === "light");
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // remembered for this page only
  }
}

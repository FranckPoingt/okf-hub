import { useEffect, useState } from "react";

export type ThemeChoice = "light" | "dark" | "system";

const KEY = "okf-theme";
const CHANGED = "okf:theme-changed";
const query = () => globalThis.matchMedia?.("(prefers-color-scheme: dark)");

export const resolveTheme = (choice: ThemeChoice, systemDark: boolean) =>
  choice === "system" ? (systemDark ? "dark" : "light") : choice;

export function storedTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

const currentTheme = () =>
  resolveTheme(storedTheme(), query()?.matches ?? false);

function applyTheme() {
  document.documentElement.classList.toggle("dark", currentTheme() === "dark");
  globalThis.dispatchEvent(new Event(CHANGED));
}

/** Applies the saved choice and tracks the system preference while it is "system". */
export function initTheme() {
  applyTheme();
  query()?.addEventListener("change", applyTheme);
}

export function setTheme(choice: ThemeChoice) {
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Private mode: the choice applies until the page closes.
  }
  applyTheme();
}

export function useTheme() {
  const read = () => ({ choice: storedTheme(), resolved: currentTheme() });
  const [theme, setState] = useState(read);
  useEffect(() => {
    const update = () => setState(read());
    globalThis.addEventListener(CHANGED, update);
    return () => globalThis.removeEventListener(CHANGED, update);
  }, []);
  return theme;
}

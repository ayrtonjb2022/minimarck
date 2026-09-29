import React, { createContext, useContext, useEffect, useState, useCallback } from "react";

/**
 * App-wide theme, owned in ONE place and expressed as ONE class on <html>.
 *
 * The web app did this wrong in a way that only showed up on the desktop: the
 * Kanagawa/Catppuccin palette lived in `:root`, and the light palette lived in
 * `.pos-theme-light`, a class the POS stuck on its own container. So "light
 * mode" was a property of the point-of-sale panel and nothing else — the
 * navbar, the sales list and the table chrome all stayed dark while the
 * operator believed they had switched the app. Two palettes, two homes.
 *
 * Here the class goes on the document element, so it is the same for every
 * screen, and it is a single value:
 *
 *   <html class="mm-theme-dark">     Kanagawa / Catppuccin Mocha
 *   <html class="mm-theme-light">    the light palette the POS shipped with
 *
 * The class is on <html> and not on a wrapper for a second reason: Tailwind's
 * `dark:` variant is bound to it (see the `@custom-variant` in
 * styles/index.css), so a `dark:bg-*` utility flips in step with the
 * CSS-variable palette instead of the two disagreeing.
 *
 * It also persists. A till that forgets it is dark is a till nobody can read
 * at 6am, and the whole point of the toggle is that the operator's choice
 * outlives the session. `localStorage` is a real origin here (OFFL-3), which is
 * what makes that work at all under `app://`.
 */

const STORAGE_KEY = "mm-theme";
const ThemeContext = createContext(null);

const readInitial = () => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // A renderer with storage disabled still gets a theme; it just does not
    // remember it. Not worth failing a sale over.
  }
  return "light";
};

export const ThemeProvider = ({ children }) => {
  const [theme, setTheme] = useState(readInitial);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("mm-theme-light", "mm-theme-dark");
    root.classList.add(`mm-theme-${theme}`);
    root.style.colorScheme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* see readInitial */
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === "light" ? "dark" : "light"));
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme, isDark: theme === "dark" }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
};

export default ThemeProvider;

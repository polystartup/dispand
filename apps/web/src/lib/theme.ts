export type Theme = "system" | "light" | "dark";

const KEY = "dispand-theme";

/** Runs before first paint (inline in <head>) so a saved choice never flashes the other theme. */
export const themeInitScript = `try{var t=localStorage.getItem("${KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export function readTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    // storage unavailable: follow the system
  }
  return "system";
}

export function saveTheme(theme: Theme): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // storage unavailable: the choice lasts until reload
  }
}

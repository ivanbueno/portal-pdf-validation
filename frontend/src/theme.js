// The color theme toggles; the workspace header and the sign-in card share one choice.
import { setIconLabel } from "./icons.js";

const NEXT_THEME = { system: "light", light: "dark", dark: "system" };
// Each toggle shows the theme in effect; its name says so too.
const THEME_ICONS = { system: "monitor", light: "sun", dark: "moon" };

// Browsers that block site data throw on any storage access; the theme then
// lasts only for the current page.
function savedTheme() {
  try {
    const theme = localStorage.getItem("theme");
    return Object.hasOwn(NEXT_THEME, theme) ? theme : "system";
  } catch {
    return "system";
  }
}
function saveTheme(theme) {
  try {
    localStorage.setItem("theme", theme);
  } catch {
    // Not remembered; see savedTheme.
  }
}

export function initTheme(...buttons) {
  let theme = savedTheme();
  function apply() {
    const root = document.documentElement;
    // Colors switch at once: a transition would fade each element through
    // low-contrast in-between colors on its own schedule.
    root.classList.add("theme-switching");
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
    getComputedStyle(root).color; // Applies the new colors while transitions are off.
    root.classList.remove("theme-switching");
    for (const button of buttons)
      setIconLabel(button, THEME_ICONS[theme], `Theme: ${theme}`);
  }
  for (const button of buttons)
    button.onclick = () => {
      theme = NEXT_THEME[theme];
      saveTheme(theme);
      apply();
    };
  apply();
}

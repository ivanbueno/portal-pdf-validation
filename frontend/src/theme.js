// The color theme toggles; the workspace header and the sign-in card share one choice.
const NEXT_THEME = { system: "light", light: "dark", dark: "system" };

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
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    for (const button of buttons) button.textContent = `Theme: ${theme}`;
  }
  for (const button of buttons)
    button.onclick = () => {
      theme = NEXT_THEME[theme];
      saveTheme(theme);
      apply();
    };
  apply();
}

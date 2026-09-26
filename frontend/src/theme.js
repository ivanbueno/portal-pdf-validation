// The color theme toggle; one choice applies to the sign-in page and the workspace.
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

export function initTheme(button) {
  let theme = savedTheme();
  function apply() {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    button.textContent = `Theme: ${theme}`;
  }
  button.onclick = () => {
    theme = NEXT_THEME[theme];
    saveTheme(theme);
    apply();
  };
  apply();
}

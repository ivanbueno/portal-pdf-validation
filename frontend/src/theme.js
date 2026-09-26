// The color theme toggle; one choice applies to the sign-in page and the workspace.
const NEXT_THEME = { system: "light", light: "dark", dark: "system" };

export function initTheme(button) {
  let theme = localStorage.getItem("theme") || "system";
  function apply() {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    button.textContent = `Theme: ${theme}`;
  }
  button.onclick = () => {
    theme = NEXT_THEME[theme];
    localStorage.setItem("theme", theme);
    apply();
  };
  apply();
}

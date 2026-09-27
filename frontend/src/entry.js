import "./style.css";
import "./login.css";
import { renderIcons } from "./icons.js";
import { initTheme } from "./theme.js";
import { notify, openWorkspace, SignInRequired } from "./common.js";

renderIcons();
initTheme(
  ...document.querySelectorAll(".theme-choice"),
  document.getElementById("gate-theme"),
);
const settingsToggle = document.getElementById("account-settings-toggle");
const settingsMenu = document.getElementById("account-settings-menu");
function closeSettings() {
  settingsMenu.hidden = true;
  settingsToggle.setAttribute("aria-expanded", "false");
}
settingsToggle.addEventListener("click", () => {
  const open = settingsMenu.hidden;
  settingsMenu.hidden = !open;
  settingsToggle.setAttribute("aria-expanded", String(open));
  if (open) settingsMenu.querySelector("button:not([hidden])")?.focus();
});
document.addEventListener("click", (event) => {
  if (
    !settingsMenu.contains(event.target) &&
    !settingsToggle.contains(event.target)
  )
    closeSettings();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !settingsMenu.hidden) {
    closeSettings();
    settingsToggle.focus();
  }
});
import("./app.js").catch((error) => {
  // The sign-in card is showing and explains what the visitor needs.
  if (error instanceof SignInRequired) return;
  openWorkspace();
  notify(
    "The workspace could not start. Check your connection and reload this page.",
    true,
  );
});

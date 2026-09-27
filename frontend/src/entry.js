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
// Tabbing out of the menu closes it, as clicking elsewhere does.
settingsMenu.parentElement.addEventListener("focusout", (event) => {
  if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget))
    closeSettings();
});
// Arrow keys move between the menu's buttons, wrapping at either end.
settingsMenu.addEventListener("keydown", (event) => {
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[
    event.key
  ];
  if (!step) return;
  event.preventDefault();
  const items = [...settingsMenu.querySelectorAll("button:not([hidden])")];
  const index = items.indexOf(document.activeElement);
  items.at((index + step) % items.length).focus();
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

import "./style.css";
import "./login.css";
import { renderIcons } from "./icons.js";
import { initTheme } from "./theme.js";
import { notify, openWorkspace, SignInRequired } from "./common.js";

renderIcons();
initTheme(
  document.getElementById("theme"),
  document.getElementById("gate-theme"),
);
import("./app.js").catch((error) => {
  // The sign-in card is showing and explains what the visitor needs.
  if (error instanceof SignInRequired) return;
  openWorkspace();
  notify(
    "The workspace could not start. Check your connection and reload this page.",
    true,
  );
});

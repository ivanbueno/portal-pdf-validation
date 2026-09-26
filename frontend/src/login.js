import "./style.css";
import "./login.css";
import { initTheme } from "./theme.js";

initTheme(document.getElementById("theme"));

function show(screen) {
  for (const section of document.querySelectorAll(".login-screen"))
    section.hidden = section.id !== `${screen}-screen`;
}

if (new URLSearchParams(location.search).has("signed-out")) show("signed-out");
// The server forwards authorized users to the workspace, so a session seen here
// belongs to an account without the workspace role.
const response = await fetch("/api/session", {
  credentials: "same-origin",
}).catch(() => null);
if (response?.status === 403) show("denied");

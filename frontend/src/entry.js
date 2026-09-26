import "./style.css";
import { LOGOUT_URL, scheduleNoticeFade } from "./common.js";
import("./app.js").catch((error) => {
  const notice = document.getElementById("notice");
  notice.hidden = false;
  notice.classList.add("error");
  notice.setAttribute("role", "alert");
  const denied =
    error.message === "Your account is not authorized for this workspace.";
  notice.textContent = denied
    ? "Your account needs access to this workspace. Ask your administrator to assign the Validation.User role. "
    : "The workspace could not start. Check your connection and reload this page.";
  if (denied) {
    const logout = document.createElement("a");
    logout.href = LOGOUT_URL;
    logout.textContent = "Sign out";
    notice.append(logout);
  }
  scheduleNoticeFade(notice, 8000);
});

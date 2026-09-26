import "./style.css";
import { AccessDenied, LOGOUT_URL, notify } from "./common.js";
import("./app.js").catch((error) => {
  if (!(error instanceof AccessDenied)) {
    notify(
      "The workspace could not start. Check your connection and reload this page.",
      true,
    );
    return;
  }
  const logout = document.createElement("a");
  logout.href = LOGOUT_URL;
  logout.textContent = "Sign out";
  notify(
    "Your account needs access to this workspace. Ask your administrator to assign the Validation.User role. ",
    true,
  ).append(logout);
});

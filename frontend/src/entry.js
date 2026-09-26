import "./style.css";
import { LeavingWorkspace, notify } from "./common.js";
import("./app.js").catch((error) => {
  // The sign-in page is loading and explains what the visitor needs.
  if (error instanceof LeavingWorkspace) return;
  notify(
    "The workspace could not start. Check your connection and reload this page.",
    true,
  );
});

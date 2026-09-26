import { account, config, signIn, signOut } from "./api.js";
import { initPreviewDialog } from "./previews-ui.js";
import { initResults, poll } from "./results.js";
import { $, notify } from "./ui.js";
import { initUploads } from "./upload.js";

const NEXT_THEME = { system: "light", light: "dark", dark: "system" };
let theme = localStorage.getItem("theme") || "system";
function applyTheme() {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  $("theme").textContent = `Theme: ${theme}`;
}
$("theme").onclick = () => {
  theme = NEXT_THEME[theme];
  localStorage.setItem("theme", theme);
  applyTheme();
};
applyTheme();

$("signin").onclick = signIn;
$("signout").onclick = signOut;
$("signin").hidden = !!account();
$("signout").hidden = config.local || !account();
$("identity").textContent = account()?.name || "Organization sign-in required";
$("disclaimer").textContent = config.disclaimer;

initUploads();
initResults();
initPreviewDialog();
if (!account())
  notify(
    "Sign in with your organization account to upload and validate documents.",
  );
else poll();

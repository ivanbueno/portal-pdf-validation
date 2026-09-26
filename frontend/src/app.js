import { account, config, signOut } from "./api.js";
import { initPreviewDialog } from "./previews-ui.js";
import { initResults, poll } from "./results.js";
import { initTheme } from "./theme.js";
import { $ } from "./ui.js";
import { initUploads } from "./upload.js";

initTheme($("theme"));
$("signout").onclick = signOut;
$("signout").hidden = config.local;
$("identity").textContent = account().name;
$("disclaimer").textContent = config.disclaimer;

initUploads();
initResults();
initPreviewDialog();
poll();

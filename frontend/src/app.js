import { account, config, signOut } from "./api.js";
import { openWorkspace } from "./common.js";
import { initPreviewDialog } from "./previews-ui.js";
import { initResults, poll } from "./results.js";
import { $ } from "./ui.js";
import { initUploads } from "./upload.js";

openWorkspace();
$("signout").onclick = signOut;
$("signout").hidden = config.local;
$("identity").textContent = account().name;
$("disclaimer").textContent = config.disclaimer;

initUploads();
initResults();
initPreviewDialog();
poll();

// DOM helpers, formatting, notices, and labels shared by the portal modules.
import { notify } from "./common.js";
import { config } from "./api.js";

export { notify };

export const $ = (id) => document.getElementById(id);

// Status groups come from the server, which owns the document lifecycle.
export const { active: ACTIVE, terminal: TERMINAL } = config.statuses;
const statusLabels = {
  uploading: "Awaiting upload",
  queued: "Queued",
  running: "Validating",
  passed: "Passed checks",
  failed: "Failed checks",
  error: "Processing error",
};
// Short forms for one profile's result, shown beside the profile's name.
const outcomeLabels = { passed: "Pass", failed: "Fail", error: "Error" };
// Anything without a label yet, such as a profile awaiting its result, is pending.
export const statusLabel = (status) => statusLabels[status] || "Pending";
export const outcomeLabel = (status) => outcomeLabels[status] || "Pending";

const profileLabels = Object.fromEntries(
  config.profiles.map((p) => [p.id, p.label]),
);
// Maps the short names in `validation_profiles` to profile IDs.
export const profileIds = Object.fromEntries(
  config.profiles.map((p) => [p.alias, p.id]),
);
export const profileLabel = (profile) => profileLabels[profile] || profile;

export const size = (bytes) =>
  bytes < 1048576
    ? `${(bytes / 1024).toFixed(1)} KiB`
    : `${(bytes / 1048576).toFixed(1)} MiB`;
// Whole-number binary units for configured limits, e.g. "200 MiB", "2 GiB".
export const limit = (bytes) =>
  bytes >= 1073741824 ? `${bytes / 1073741824} GiB` : `${bytes / 1048576} MiB`;

export const node = (tag, text, className) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
};
export const action = (text, handler, className) => {
  const b = node("button", text, className);
  b.type = "button";
  b.onclick = () => Promise.resolve(handler()).catch(showError);
  return b;
};

export function showError(error) {
  notify(error.message || String(error), true);
}

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

// The word for `count` things, e.g. plural(1, "file") is "file".
export const plural = (count, singular, pluralForm = `${singular}s`) =>
  count === 1 ? singular : pluralForm;
// A count with its noun, e.g. "1 file", "2 files".
export const quantity = (count, singular) =>
  `${count} ${plural(count, singular)}`;

const BINARY_UNITS = [
  ["GiB", 1073741824],
  ["MiB", 1048576],
  ["KiB", 1024],
];
// `bytes` in the largest binary unit it fills, or KiB; `format` renders the number.
const binary = (bytes, format) => {
  const [unit, factor] =
    BINARY_UNITS.find(([, factor]) => bytes >= factor) || BINARY_UNITS.at(-1);
  return `${format(bytes / factor)} ${unit}`;
};
// API clients may reserve a document without its size; submission records it.
export const size = (bytes) =>
  bytes == null ? "Size unavailable" : binary(bytes, (n) => n.toFixed(1));
// Configured limits in whole units, e.g. "200 MiB", "2 GiB".
export const limit = (bytes) => binary(bytes, String);

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

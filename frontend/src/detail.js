// The expanded validation report beneath a document row.
import { api, config } from "./api.js";
import { loadOccurrencePreviews } from "./previews-ui.js";
import {
  action,
  node,
  outcomeLabel,
  plural,
  profileLabel,
  statusLabel,
} from "./ui.js";

const ISSUE_PAGE_SIZE = 100;
// Occurrences shown individually; the rest are summarized by page.
const LISTED_OCCURRENCES = 5;
const NO_ISSUES = {
  passed: "No automated rule failures found.",
  error: "Processing did not complete. Review the profile errors.",
  failed: "No issue details were supplied by the validator.",
};

function outcome(result, status) {
  if (!result) return statusLabel(status);
  if (result.status === "error") return statusLabel("error");
  return `${outcomeLabel(result.status)} · ${result.summary?.errors ?? "Unknown"} ${plural(result.summary?.errors, "error")}`;
}

function renderSummary(d) {
  const summary = node("aside", undefined, "validation-summary");
  summary.append(node("h3", "Validation summary"));
  for (const r of d.profiles || []) {
    const section = node("div", undefined, "summary-profile");
    section.append(
      node("strong", profileLabel(r.profile)),
      node("p", outcome(r, d.status), r.status),
    );
    if (r.summary)
      section.append(
        node(
          "p",
          `${r.summary.failed_rules} failed rules · ${r.summary.checked_rules ?? "Unknown"} rules checked`,
          "muted",
        ),
      );
    if (r.error) section.append(node("p", r.error));
    summary.append(section);
  }
  if (d.error) summary.append(node("p", d.error));
  summary.append(
    node(
      "p",
      `Expires ${new Date(d.expires * 1000).toLocaleString()}`,
      "muted",
    ),
  );
  return summary;
}

const validPage = (occurrence) => {
  const page = Number(occurrence.page);
  return Number.isInteger(page) && page > 0;
};

// One line describing occurrences beyond those listed individually.
function remainingLocationsSummary(occurrences) {
  const pages = [
    ...new Set(occurrences.filter(validPage).map((o) => Number(o.page))),
  ].sort((a, b) => a - b);
  if (!pages.length)
    return `Similar issue in ${occurrences.length} more ${plural(occurrences.length, "location")}; page numbers were not supplied.`;
  const missing = occurrences.filter((o) => !validPage(o)).length;
  return `Similar issue on pages: ${pages.join(", ")}.${missing ? ` Page number unavailable for ${missing} more ${plural(missing, "location")}.` : ""}`;
}

function renderOccurrences(group, docId) {
  const occurrences = node("details", undefined, "occurrences");
  const previewContainers = [];
  occurrences.addEventListener("toggle", () => {
    if (occurrences.open)
      loadOccurrencePreviews(previewContainers, docId, group.occurrences).catch(
        () => {},
      );
  });
  occurrences.append(
    node(
      "summary",
      `${group.count} failed ${plural(group.count, "check")} · View locations`,
    ),
  );
  for (const occurrence of group.occurrences.slice(0, LISTED_OCCURRENCES)) {
    const item = node("div", undefined, "issue-location");
    item.append(
      node("strong", profileLabel(occurrence.profile)),
      node("p", occurrence.message),
    );
    if (occurrence.page) item.append(node("p", `Page ${occurrence.page}`));
    const preview = node(
      "div",
      "Open locations to load page preview.",
      "occurrence-preview muted",
    );
    previewContainers.push(preview);
    item.append(preview);
    occurrences.append(item);
  }
  const remaining = group.occurrences.slice(LISTED_OCCURRENCES);
  if (remaining.length)
    occurrences.append(
      node(
        "p",
        remainingLocationsSummary(remaining),
        "muted issue-locations-summary",
      ),
    );
  if (group.count > group.occurrences.length)
    occurrences.append(
      node(
        "p",
        `Showing the first ${group.occurrences.length} checks. Download the JSON report for all locations.`,
        "muted",
      ),
    );
  return occurrences;
}

function renderIssueGroup(group, docId) {
  const issue = node("article", undefined, "grouped-issue");
  const identity = node("div", undefined, "issue-identity");
  identity.append(
    node(
      "code",
      group.clause
        ? `${group.clause}–${group.test_number}`
        : group.rule_id || "Unspecified rule",
    ),
  );
  for (const profile of group.profiles)
    identity.append(node("span", profileLabel(profile), "profile-badge"));
  const body = node("div");
  body.append(node("p", group.message, "issue-description"));
  if (group.specification) body.append(node("p", group.specification, "muted"));
  body.append(renderOccurrences(group, docId));
  issue.append(identity, body);
  return issue;
}

export async function loadDetail(doc, row, offset = 0) {
  if (!row) return;
  const cell = node("td");
  cell.colSpan = 3;
  const content = node("div", undefined, "expanded-report");
  cell.append(content);
  row.replaceChildren(cell);
  content.append(
    node("p", "Loading validation details…", "muted loading-message"),
  );
  content.setAttribute("aria-live", "polite");
  try {
    // The listed document already carries the per-profile summaries, so only
    // the issue groups need the stored report.
    const groups = await api(
      `/documents/${doc.id}/issues?offset=${offset}&limit=${ISSUE_PAGE_SIZE}`,
    );
    const violations = node("section", undefined, "grouped-issues");
    violations.append(node("h3", `Accessibility issues (${groups.total})`));
    if (!groups.total)
      violations.append(
        node(
          "p",
          NO_ISSUES[doc.status] ||
            "Results will appear when validation finishes.",
          "muted",
        ),
      );
    for (const group of groups.items)
      violations.append(renderIssueGroup(group, doc.id));
    const nav = node("div", undefined, "downloads");
    if (offset)
      nav.append(
        action("Previous issues", () =>
          loadDetail(doc, row, Math.max(0, offset - ISSUE_PAGE_SIZE)),
        ),
      );
    if (offset + groups.items.length < groups.total)
      nav.append(
        action("More issues", () =>
          loadDetail(doc, row, offset + ISSUE_PAGE_SIZE),
        ),
      );
    violations.append(nav, node("p", config.disclaimer, "muted"));
    content.replaceChildren(renderSummary(doc), violations);
  } catch (error) {
    content.replaceChildren(
      node("p", error.message, "error"),
      action("Retry details", () => loadDetail(doc, row, offset)),
    );
  }
}

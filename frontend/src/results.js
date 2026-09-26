// The document table, summary cards, batch progress, and polling.
import { api, account, config, download } from "./api.js";
import { loadDetail } from "./detail.js";
import {
  $,
  ACTIVE,
  TERMINAL,
  action,
  node,
  notify,
  profileIds,
  profileLabel,
  showError,
  size,
  statusLabels,
} from "./ui.js";

const PAGE_SIZE = 20;
const PROFILE_STATE = { passed: "Pass", failed: "Fail", error: "Error" };

let documents = [],
  stats = { total: 0, active_ids: [], passed_by_profile: {} },
  documentLimit = PAGE_SIZE,
  // Documents submitted in the current batch, tracked by the progress bar.
  progressDocumentIds = new Set(),
  // JSON of the last rendered rows; unchanged polls skip the DOM rebuild.
  renderedSignature = "",
  refreshSequence = 0,
  pollDelay = 2500,
  pollTimer,
  searchTimer;
const expanded = new Set(),
  detailRows = new Map();

export function beginBatch() {
  progressDocumentIds = new Set();
}
export function trackDocument(id) {
  progressDocumentIds.add(id);
}
// Makes sure every document of the batch fits in the table, then refreshes.
export function showBatch() {
  documentLimit = Math.max(documentLimit, progressDocumentIds.size);
  return refresh();
}

// One passed-count card per profile, between the files and pages cards.
function renderProfileStats() {
  $("stat-pages")
    .closest(".stat-card")
    .before(
      ...config.profiles.map((profile) => {
        const count = node("strong", "0");
        count.dataset.passedProfile = profile.id;
        const text = node("div");
        text.append(count, node("span", `${profile.label} compliant`));
        const card = node("article", undefined, "stat-card good");
        card.append(node("span", "✓", "stat-icon"), text);
        return card;
      }),
    );
}

function renderStats() {
  $("count").textContent = stats.total;
  $("stat-processed").textContent = stats.processed;
  for (const stat of document.querySelectorAll("[data-passed-profile]"))
    stat.textContent = stats.passed_by_profile[stat.dataset.passedProfile] ?? 0;
  $("stat-pages").textContent = stats.pages;
  // Deleted or expired submissions count as finished so progress never stalls.
  const active = new Set(stats.active_ids),
    total = progressDocumentIds.size,
    finished = [...progressDocumentIds].filter((id) => !active.has(id)).length;
  $("progress-row").hidden = !total || finished >= total;
  $("progress").max = total || 1;
  $("progress").value = finished;
  $("progress-meter").style.setProperty(
    "--progress-complete",
    `${total ? (finished / total) * 100 : 0}%`,
  );
  $("progress-indicator").hidden = finished >= total;
  $("progress-text").textContent = `${finished} of ${total} files processed`;
}

const pageCount = (count) =>
  count == null
    ? "Page count unavailable"
    : `${count} ${count === 1 ? "page" : "pages"}`;

// A details toggle's glyph and state, from whether the document is expanded.
function renderToggle(toggle, id) {
  toggle.textContent = expanded.has(id) ? "⌄" : "›";
  toggle.setAttribute("aria-expanded", String(expanded.has(id)));
}

function renderFileCell(d) {
  const toggle = action(undefined, () => toggleDetail(d), "expand-toggle");
  toggle.id = `toggle-${d.id}`;
  toggle.setAttribute("aria-label", `Validation details for ${d.name}`);
  toggle.setAttribute("aria-controls", `details-${d.id}`);
  renderToggle(toggle, d.id);
  const link = node(d.pdf_available ? "a" : "span", d.name, "pdf-link");
  if (d.pdf_available) {
    link.href = `/api/v1/documents/${d.id}/pdf`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", `${d.name} (opens PDF in a new tab)`);
  }
  const info = node("div");
  info.append(
    link,
    node(
      "span",
      `${new Date((d.submitted || d.created) * 1000).toLocaleDateString()} · ${pageCount(d.page_count)} · ${size(d.size)}`,
      "file-metadata",
    ),
  );
  const layout = node("div", undefined, "document-file");
  layout.append(toggle, info);
  const cell = node("td");
  cell.append(layout);
  return cell;
}

function renderProfileOutcomes(d) {
  const cell = node("td", undefined, "profile-outcomes");
  for (const alias of d.validation_profiles) {
    const profile = profileIds[alias] || alias;
    const result = d.profiles?.find((r) => r.profile === profile);
    const resultStatus = result?.status || d.status;
    const issueCount = result?.summary?.errors ?? result?.issue_total;
    const line = node("div", undefined, `profile-line ${resultStatus}`);
    line.setAttribute(
      "aria-label",
      `${profileLabel(profile)}: ${statusLabels[resultStatus] || "Pending"}, ${issueCount ?? "unknown"} errors`,
    );
    line.append(
      node("span", profileLabel(profile), "profile-name"),
      node("span", PROFILE_STATE[resultStatus] || "Pending", "profile-state"),
    );
    if (resultStatus !== "passed") {
      const running = d.status === "running";
      line.append(
        node(
          "span",
          issueCount ?? (running ? "" : "—"),
          `profile-count${running ? " is-processing" : ""}`,
        ),
      );
    }
    cell.append(line);
  }
  return cell;
}

function renderActions(d, openMenus) {
  const reportButton = action("Download report", () => download(d.id, "json"));
  reportButton.id = `report-${d.id}`;
  reportButton.disabled = !TERMINAL.includes(d.status) || !d.profiles?.length;
  const menu = node("details", undefined, "action-dropdown");
  menu.id = `actions-${d.id}`;
  menu.open = openMenus.has(menu.id);
  const summary = node("summary", "▾");
  summary.id = `menu-${d.id}`;
  summary.setAttribute("aria-label", `More actions for ${d.name}`);
  // Every menu action closes the menu first.
  const menuAction = (text, handler, className) =>
    action(
      text,
      () => {
        menu.open = false;
        return handler();
      },
      className,
    );
  const options = node("div", undefined, "action-options");
  for (const profile of d.profiles || []) {
    if (profile.summary)
      options.append(
        menuAction(`${profileLabel(profile.profile)} XML`, () =>
          download(d.id, "xml", profile.profile),
        ),
      );
  }
  options.append(
    menuAction("View validation details", () => toggleDetail(d, true)),
    menuAction("Delete file", () => confirmDelete(d), "danger"),
  );
  menu.append(summary, options);
  const split = node("div", undefined, "split-button");
  split.append(reportButton, menu);
  const cell = node("td");
  cell.append(split);
  return cell;
}

function renderRow(d, openMenus) {
  const tr = node(
    "tr",
    undefined,
    `document-row${ACTIVE.includes(d.status) ? " is-processing" : ""}${d.status === "running" ? " is-running" : ""}`,
  );
  tr.id = `row-${d.id}`;
  tr.addEventListener("click", (event) => {
    if (
      event.target.closest("a, button, input, select, summary, [role='button']")
    )
      return;
    toggleDetail(d).catch(showError);
  });
  tr.append(
    renderFileCell(d),
    renderProfileOutcomes(d),
    renderActions(d, openMenus),
  );
  // Detail rows are reused so an open report survives re-rendering.
  const detail = detailRows.get(d.id) || node("tr", undefined, "detail-row");
  detail.id = `details-${d.id}`;
  detail.hidden =
    !expanded.has(d.id) && !detail.classList.contains("detail-closing");
  detailRows.set(d.id, detail);
  return [tr, detail];
}

function renderResults() {
  renderStats();
  // The server has already applied search, filter, and documentLimit.
  $("empty").hidden = !!documents.length;
  $("results").hidden = !documents.length;
  $("empty").querySelector("h3").textContent = stats.total
    ? "No matching files"
    : "No files yet";
  const signature = JSON.stringify(documents);
  if (signature === renderedSignature) return;
  renderedSignature = signature;
  const focused = document.activeElement;
  const openMenus = new Set(
    [...document.querySelectorAll(".action-dropdown[open]")].map(
      (menu) => menu.id,
    ),
  );
  $("results-body").replaceChildren(
    ...documents.flatMap((d) => renderRow(d, openMenus)),
  );
  if (focused?.isConnected) focused.focus({ preventScroll: true });
  else if (focused?.id)
    document.getElementById(focused.id)?.focus({ preventScroll: true });
}

export async function refresh() {
  if (!account()) return;
  const sequence = ++refreshSequence;
  const params = new URLSearchParams({
    q: $("search").value.trim(),
    status: $("filter").value,
  });
  // Fetch only the rows on screen; summary cards use server-wide totals.
  const collected = [];
  let data;
  do {
    params.set("offset", collected.length);
    params.set("limit", Math.min(100, documentLimit - collected.length));
    data = await api(`/documents?${params}`);
    collected.push(...data.items);
  } while (
    data.items.length &&
    collected.length < Math.min(documentLimit, data.matching)
  );
  // A slower, older request (e.g. a poll racing a search) must not win.
  if (sequence !== refreshSequence) return;
  documents = collected;
  stats = data;
  $("load-more").hidden = data.matching <= documentLimit;
  renderResults();
}

export async function poll() {
  try {
    if (document.visibilityState === "visible") {
      await refresh();
      pollDelay = stats.active_ids.length ? 2500 : 15000;
    }
  } catch {
    pollDelay = Math.min(pollDelay * 2, 60000);
  }
  pollTimer = setTimeout(poll, pollDelay);
}

// Updates only the toggled row's button and detail row: rebuilding the table
// would move focus and let scroll anchoring shift the page.
async function toggleDetail(doc, forceOpen = false) {
  const closing = expanded.has(doc.id) && !forceOpen;
  if (closing) expanded.delete(doc.id);
  else expanded.add(doc.id);
  renderToggle(document.getElementById(`toggle-${doc.id}`), doc.id);
  const detail = detailRows.get(doc.id);
  if (closing) {
    detail.classList.add("detail-closing");
    setTimeout(() => {
      if (expanded.has(doc.id)) return;
      detail.hidden = true;
      detail.classList.remove("detail-closing");
    }, 180);
  } else {
    detail.hidden = false;
    detail.classList.remove("detail-closing");
    detail.classList.add("detail-enter");
    setTimeout(() => detail.classList.remove("detail-enter"), 220);
    await loadDetail(doc, detail);
  }
}

function confirmDelete(doc) {
  $("confirm-title").textContent = `Delete “${doc.name}”?`;
  $("confirm").showModal();
  $("confirm-delete").onclick = async () => {
    try {
      await api(`/documents/${doc.id}`, { method: "DELETE" });
      $("confirm").close();
      expanded.delete(doc.id);
      detailRows.delete(doc.id);
      notify("File deleted.");
      await refresh();
    } catch (e) {
      showError(e);
    }
  };
}

const closeMenus = (handle) =>
  document.querySelectorAll(".action-dropdown[open]").forEach(handle);

export function initResults() {
  renderProfileStats();
  $("search").oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => refresh().catch(showError), 250);
  };
  $("filter").onchange = () => refresh().catch(showError);
  $("load-more").onclick = () => {
    documentLimit += PAGE_SIZE;
    refresh().catch(showError);
  };
  $("confirm-cancel").onclick = () => $("confirm").close();
  document.addEventListener("click", (event) =>
    closeMenus((menu) => {
      if (!menu.contains(event.target)) menu.open = false;
    }),
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape")
      closeMenus((menu) => {
        menu.open = false;
        menu.querySelector("summary").focus();
      });
  });
  window.addEventListener("online", () => {
    clearTimeout(pollTimer);
    poll();
  });
}

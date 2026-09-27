// The document table, summary cards, batch progress, and polling.
import { api, config, download } from "./api.js";
import { cancelDetail, loadDetail, refreshDetail } from "./detail.js";
import {
  $,
  ACTIVE,
  TERMINAL,
  action,
  icon,
  iconAction,
  node,
  notify,
  outcomeLabel,
  profileIds,
  profileLabel,
  quantity,
  setIconLabel,
  showError,
  size,
  statusLabel,
} from "./ui.js";

const PAGE_SIZE = 20;
// Poll quickly while documents are processing, slowly when idle, and back off
// on errors up to the maximum.
const ACTIVE_POLL = 2500,
  IDLE_POLL = 15000,
  MAX_POLL = 60000,
  // Fast polls transfer only active metadata; the whole workspace is reconciled
  // this often to discover external deletions, expirations, and uploads.
  RECONCILE_INTERVAL = 30000;
const pollDelayFor = (activeCount) => (activeCount ? ACTIVE_POLL : IDLE_POLL);

let documents = [],
  stats = { total: 0, activity: [], passed_by_profile: {} },
  documentLimit = PAGE_SIZE,
  // Documents submitted in the current batch, tracked by the progress bar.
  progressDocumentIds = new Set(),
  // JSON of the last rendered rows; unchanged polls skip the DOM rebuild.
  renderedSignature = "",
  refreshController,
  nextCursor,
  lastFilters,
  lastActivity = "",
  lastFullRefresh = 0,
  pollDelay = ACTIVE_POLL,
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
  const active = new Set(stats.activity.map((item) => item.id)),
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
  $("progress-text").textContent =
    `${finished} of ${quantity(total, "file")} processed`;
}

const pageCount = (count) =>
  count == null ? "Page count unavailable" : quantity(count, "page");

// A details toggle's state, from whether the document is expanded; CSS turns its chevron.
function renderToggle(toggle, id) {
  toggle.setAttribute("aria-expanded", String(expanded.has(id)));
}

function renderFileCell(d) {
  const toggle = action(undefined, () => toggleDetail(d), "expand-toggle");
  toggle.append(icon("chevron-right"));
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
    const issueCount = result?.summary?.errors;
    const line = node("div", undefined, `profile-line ${resultStatus}`);
    line.setAttribute(
      "aria-label",
      `${profileLabel(profile)}: ${statusLabel(resultStatus)}, ${issueCount ?? "unknown"} errors`,
    );
    line.append(
      node("span", profileLabel(profile), "profile-name"),
      node("span", outcomeLabel(resultStatus), "profile-state"),
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
  const reportButton = iconAction(
    "download",
    `Download report for ${d.name}`,
    () => download(d.id, "json"),
  );
  reportButton.id = `report-${d.id}`;
  reportButton.disabled = !TERMINAL.includes(d.status) || !d.profiles?.length;
  const menu = node("details", undefined, "action-dropdown");
  menu.id = `actions-${d.id}`;
  menu.open = openMenus.has(menu.id);
  const summary = node("summary");
  summary.id = `menu-${d.id}`;
  setIconLabel(summary, "chevron-down", `More actions for ${d.name}`);
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
  if (expanded.has(d.id)) refreshDetail(d, detail);
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
  const visible = new Set(documents.map((doc) => doc.id));
  for (const [id, row] of detailRows) {
    if (visible.has(id)) continue;
    cancelDetail(row);
    detailRows.delete(id);
  }
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

function cancelRefresh() {
  clearTimeout(pollTimer);
  refreshController?.abort();
}

const activitySignature = (items = []) =>
  JSON.stringify(
    items
      .map((item) => [item.id, item.status, item.attempts, item.expires])
      .sort((a, b) => a[0].localeCompare(b[0])),
  );

// Whether active documents are unchanged since the last full refresh, so a poll
// can skip listing; sets the next poll delay when they are.
async function activityUnchanged(signal) {
  const { items } = await api("/documents/activity", { signal });
  signal.throwIfAborted();
  if (activitySignature(items) !== lastActivity) return false;
  pollDelay = pollDelayFor(items.length);
  return true;
}

// Collects rows from `params` until `documentLimit` are loaded or none remain.
// The first page carries the workspace totals; the last one, the next cursor.
async function fetchPages(params, collected, signal) {
  let data, first;
  do {
    params.set(
      "limit",
      Math.min(config.maxFiles, documentLimit - collected.length),
    );
    data = await api(`/documents?${params}`, { signal });
    signal.throwIfAborted();
    first ||= data;
    collected.push(...data.items);
    if (data.next_cursor) params.set("cursor", data.next_cursor);
  } while (
    data.next_cursor &&
    data.items.length &&
    collected.length < documentLimit
  );
  return { stats: first, nextCursor: data.next_cursor };
}

export async function refresh({ append = false, activityOnly = false } = {}) {
  cancelRefresh();
  clearTimeout(searchTimer);
  const controller = (refreshController = new AbortController());
  const { signal } = controller;
  const params = new URLSearchParams({
    q: $("search").value.trim(),
    status: $("filter").value,
  });
  const filters = params.toString();
  append = append && !!nextCursor && filters === lastFilters;
  const collected = append ? [...documents] : [];
  if (append) params.set("cursor", nextCursor);
  try {
    const reconcileDue =
      !lastFullRefresh || Date.now() - lastFullRefresh >= RECONCILE_INTERVAL;
    if (activityOnly && !reconcileDue && (await activityUnchanged(signal)))
      return;
    const page = await fetchPages(params, collected, signal);
    documents = collected;
    stats = page.stats;
    nextCursor = page.nextCursor;
    lastFilters = filters;
    if (!append) {
      lastActivity = activitySignature(stats.activity);
      lastFullRefresh = Date.now();
    }
    $("load-more").hidden = !nextCursor;
    $("delete-all").hidden = !stats.total;
    renderResults();
    pollDelay = pollDelayFor(stats.activity.length);
  } catch (error) {
    if (signal.aborted) return;
    pollDelay = Math.min(pollDelay * 2, MAX_POLL);
    throw error;
  } finally {
    // Only the latest request owns the next poll, including after reconnects.
    if (!signal.aborted) {
      refreshController = undefined;
      pollTimer = setTimeout(poll, pollDelay);
    }
  }
}

export function poll() {
  cancelRefresh();
  if (document.visibilityState === "visible") {
    return refresh({ activityOnly: true }).catch(() => {});
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
    cancelDetail(detail);
    detail.classList.add("detail-closing");
    afterAnimation(detail, "detail-exit", () => {
      if (expanded.has(doc.id)) return;
      detail.hidden = true;
      detail.classList.remove("detail-closing");
    });
  } else {
    detail.hidden = false;
    detail.classList.remove("detail-closing");
    detail.classList.add("detail-enter");
    // loadDetail replaces the animated content at once, so wait for it first.
    const loading = loadDetail(doc, detail);
    afterAnimation(detail, "detail-enter", () =>
      detail.classList.remove("detail-enter"),
    );
    await loading;
  }
}

// Runs `then` once the CSS animation `name` within `element` ends, however
// long the stylesheet makes it; also when it is cancelled or never started.
function afterAnimation(element, name, then) {
  const animations = element
    .getAnimations({ subtree: true })
    .filter((animation) => animation.animationName === name);
  Promise.allSettled(animations.map((animation) => animation.finished)).then(
    then,
  );
}

// The shared confirmation dialog, set up for one removal. `onConfirm` runs when
// confirmed; on failure the dialog stays open and the error is shown.
function confirmRemoval({ title, message, keep, remove, onConfirm }) {
  $("confirm-title").textContent = title;
  $("confirm-message").textContent = message;
  $("confirm-cancel").textContent = keep;
  const button = $("confirm-delete");
  button.textContent = remove;
  $("confirm").showModal();
  button.onclick = async () => {
    // One request per confirmation, however many clicks.
    button.disabled = true;
    try {
      await onConfirm();
      $("confirm").close();
      await refresh();
    } catch (e) {
      showError(e);
    } finally {
      button.disabled = false;
    }
  };
}

function confirmDelete(doc) {
  confirmRemoval({
    title: `Delete “${doc.name}”?`,
    message:
      "Access is removed immediately. The document and its reports will be permanently removed.",
    keep: "Keep file",
    remove: "Delete file",
    onConfirm: async () => {
      await api(`/documents/${doc.id}`, { method: "DELETE" });
      expanded.delete(doc.id);
      cancelDetail(detailRows.get(doc.id));
      detailRows.delete(doc.id);
      notify("File deleted.");
    },
  });
}

function confirmDeleteAll() {
  confirmRemoval({
    title: "Delete all documents?",
    message: `This permanently removes ${quantity(stats.total, "file")} and all reports from your workspace, including files still being validated. Access is removed immediately and this can't be undone.`,
    keep: "Keep files",
    remove: "Delete all documents",
    onConfirm: async () => {
      const { deleted } = await api("/documents", { method: "DELETE" });
      expanded.clear();
      for (const row of detailRows.values()) cancelDetail(row);
      detailRows.clear();
      notify(`${quantity(deleted, "file")} deleted.`);
    },
  });
}

const closeMenus = (handle) =>
  document.querySelectorAll(".action-dropdown[open]").forEach(handle);

export function initResults() {
  // The server accepts `all`, `active`, or one finished status.
  $("filter").replaceChildren(
    new Option("All outcomes", "all"),
    new Option("In progress", "active"),
    ...TERMINAL.map((status) => new Option(statusLabel(status), status)),
  );
  renderProfileStats();
  $("search").oninput = () => {
    cancelRefresh();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => refresh().catch(showError), 250);
  };
  $("filter").onchange = () => refresh().catch(showError);
  $("load-more").onclick = () => {
    documentLimit += PAGE_SIZE;
    refresh({ append: true }).catch(showError);
  };
  $("confirm-cancel").onclick = () => $("confirm").close();
  $("delete-all").onclick = confirmDeleteAll;
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
  window.addEventListener("online", poll);
}

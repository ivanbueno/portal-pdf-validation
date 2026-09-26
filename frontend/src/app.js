import "./style.css";
import { renderOccurrencePreview } from "./pdf-previews.js";
import { scheduleNoticeFade } from "./common.js";
import {
  api,
  config,
  account,
  signIn,
  signOut,
  upload,
  download,
} from "./api.js";
const $ = (id) => document.getElementById(id);
const labels = {
  uploading: "Awaiting upload",
  queued: "Queued",
  running: "Validating",
  passed: "Passed checks",
  failed: "Failed checks",
  error: "Processing error",
};
const ACTIVE = ["uploading", "queued", "running"];
const TERMINAL = ["passed", "failed", "error"];
const size = (bytes) =>
  bytes < 1048576
    ? `${(bytes / 1024).toFixed(1)} KiB`
    : `${(bytes / 1048576).toFixed(1)} MiB`;
// Whole-number binary units for configured limits, e.g. "200 MiB", "2 GiB".
const limit = (bytes) =>
  bytes >= 1073741824 ? `${bytes / 1073741824} GiB` : `${bytes / 1048576} MiB`;
const node = (tag, text, className) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
};
const action = (text, handler, className) => {
  const b = node("button", text, className);
  b.type = "button";
  b.onclick = () => Promise.resolve(handler()).catch(showError);
  return b;
};
let staged = [],
  documents = [],
  busy = false,
  stats = { total: 0, active_ids: [] },
  progressDocumentIds = new Set(),
  documentLimit = 20,
  pollDelay = 2500,
  pollTimer,
  cancelNoticeFade;
function notify(text, error = false) {
  const notice = $("notice");
  cancelNoticeFade?.();
  notice.classList.remove("notice-leaving");
  notice.hidden = !text;
  notice.textContent = text;
  notice.classList.toggle("error", error);
  notice.setAttribute("role", error ? "alert" : "status");
  if (text) cancelNoticeFade = scheduleNoticeFade(notice, error ? 8000 : 5000);
}
function showError(error) {
  notify(error.message || String(error), true);
}
const stagedBytes = () => staged.reduce((n, s) => n + s.file.size, 0);
function renderStaging() {
  $("staging").hidden = !staged.length;
  $("submit").disabled =
    busy || !staged.length || !account() || !selectedProfiles().length;
  $("clear").disabled = busy;
  $("files").disabled = busy;
  $("staged-total").textContent =
    `${staged.length} files · ${size(stagedBytes())}`;
  $("staged-body").replaceChildren(
    ...staged.map((s, i) => {
      const tr = node("tr");
      tr.append(
        node("td", s.file.name),
        node("td", size(s.file.size)),
        node("td", s.state || "Ready"),
      );
      const td = node("td");
      const b = action("Remove", async () => {
        await cancelUpload(s);
        staged.splice(i, 1);
        renderStaging();
      });
      b.disabled = busy;
      b.setAttribute("aria-label", `Remove ${s.file.name}`);
      td.append(b);
      tr.append(td);
      return tr;
    }),
  );
}
function selectedProfiles() {
  return [...document.querySelectorAll('input[name="profile"]:checked')].map(
    (input) => input.value,
  );
}
document.querySelectorAll('input[name="profile"]').forEach((input) => {
  input.addEventListener("change", renderStaging);
});
function addFiles(files) {
  if (busy) return;
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      notify(`${file.name}: only PDFs are supported.`, true);
      continue;
    }
    if (!file.size || file.size > config.maxFileBytes) {
      notify(
        `${file.name}: file must be between 1 byte and ${limit(config.maxFileBytes)}.`,
        true,
      );
      continue;
    }
    if (
      staged.length >= config.maxFiles ||
      stagedBytes() + file.size > config.maxSelectionBytes
    ) {
      notify(
        `This selection exceeds the ${config.maxFiles}-file or ${limit(config.maxSelectionBytes)} limit.`,
        true,
      );
      break;
    }
    staged.push({ file, state: "Ready" });
  }
  renderStaging();
}
$("files").onchange = (e) => {
  addFiles(e.target.files);
  e.target.value = "";
};
$("drop").ondragover = (e) => {
  e.preventDefault();
  $("drop").classList.add("dragover");
};
$("drop").ondragleave = () => $("drop").classList.remove("dragover");
let fileDragDepth = 0;
const isFileDrag = (event) =>
  Array.from(event.dataTransfer?.types || []).includes("Files");
function clearFileDrag() {
  fileDragDepth = 0;
  document.body.classList.remove("file-dragging");
  $("drop").classList.remove("dragover");
}
window.addEventListener("dragenter", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  fileDragDepth++;
  document.body.classList.add("file-dragging");
});
window.addEventListener("dragover", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});
window.addEventListener("dragleave", (event) => {
  if (!isFileDrag(event)) return;
  fileDragDepth = Math.max(0, fileDragDepth - 1);
  if (!fileDragDepth) clearFileDrag();
});
window.addEventListener("drop", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  clearFileDrag();
  addFiles(event.dataTransfer.files);
});
window.addEventListener("blur", clearFileDrag);
async function cancelUpload(item) {
  if (!item.doc) return;
  try {
    const current = await api(`/documents/${item.doc.id}`);
    if (current.status === "uploading")
      await api(`/documents/${item.doc.id}`, { method: "DELETE" });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}
$("clear").onclick = async () => {
  try {
    for (const item of staged) {
      await cancelUpload(item);
    }
    staged = [];
    renderStaging();
  } catch (e) {
    showError(e);
  }
};
const UPLOAD_CONCURRENCY = 3;
let stagingFrame;
function scheduleStagingRender() {
  stagingFrame ||= requestAnimationFrame(() => {
    stagingFrame = undefined;
    renderStaging();
  });
}
async function submitItem(item) {
  let status, uploadUrl;
  if (item.doc) {
    // A retry: the upload or submission may already have reached the server.
    ({ status } = await api(`/documents/${item.doc.id}`));
  } else {
    item.doc = await api("/documents", {
      method: "POST",
      headers: item.key ? { "Idempotency-Key": item.key } : {},
      body: JSON.stringify({
        name: item.file.name,
        size: item.file.size,
        profiles: (item.profiles ||= selectedProfiles()),
      }),
    });
    ({ status, upload_url: uploadUrl } = item.doc);
  }
  item.key = item.doc.idempotency_key;
  if (status === "uploading") {
    if (!item.uploaded) {
      uploadUrl ||= (
        await api(`/documents/${item.doc.id}/upload-url`, { method: "POST" })
      ).upload_url;
      await upload(uploadUrl, item.file, (p) => {
        item.state = `${p}%`;
        scheduleStagingRender();
      });
      item.uploaded = true;
    }
    await api(`/documents/${item.doc.id}/submit`, { method: "POST" });
  }
  progressDocumentIds.add(item.doc.id);
  staged.splice(staged.indexOf(item), 1);
}
$("submit").onclick = async () => {
  busy = true;
  $("submit").classList.add("is-submitting");
  $("submit").setAttribute("aria-busy", "true");
  progressDocumentIds = new Set();
  notify("Preparing your documents…");
  $("submit").textContent = "Uploading…";
  renderStaging();
  let submitted = 0;
  const pending = [...staged];
  // Reserve, upload, and submit independently; one failure never blocks another file.
  const uploader = async () => {
    for (let item; (item = pending.shift());) {
      try {
        await submitItem(item);
        submitted++;
      } catch (error) {
        item.key ||= error.idempotencyKey;
        item.state = error.message || "Retry required";
      }
      renderStaging();
    }
  };
  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, uploader));
  busy = false;
  $("submit").classList.remove("is-submitting");
  $("submit").removeAttribute("aria-busy");
  $("submit").textContent = staged.length
    ? "Retry remaining files"
    : "Validate PDFs →";
  renderStaging();
  notify(
    `${submitted} files submitted. ${staged.length ? `${staged.length} files need attention; retry the remaining files.` : "You can leave this page and return to your results."}`,
    !!staged.length,
  );
  documentLimit = Math.max(documentLimit, progressDocumentIds.size);
  await refresh().catch(showError);
};
function renderResults() {
  // The server has already applied search, filter, and documentLimit.
  const visible = documents;
  $("count").textContent = stats.total;
  $("empty").hidden = !!visible.length;
  $("results").hidden = !visible.length;
  $("empty").querySelector("h3").textContent = stats.total
    ? "No matching files"
    : "No files yet";
  // Deleted or expired submissions count as finished so progress never stalls.
  const active = new Set(stats.active_ids),
    finished = [...progressDocumentIds].filter((id) => !active.has(id)).length;
  $("stat-processed").textContent = stats.processed;
  $("stat-wcag").textContent = stats.wcag_passed;
  $("stat-ua").textContent = stats.ua_passed;
  $("stat-pages").textContent = stats.pages;
  $("progress-row").hidden =
    !progressDocumentIds.size || finished >= progressDocumentIds.size;
  $("progress").max = progressDocumentIds.size || 1;
  $("progress").value = finished;
  const remaining = progressDocumentIds.size - finished;
  $("progress-meter").style.setProperty(
    "--progress-complete",
    `${progressDocumentIds.size ? (finished / progressDocumentIds.size) * 100 : 0}%`,
  );
  $("progress-indicator").hidden = remaining <= 0;
  $("progress-text").textContent =
    `${finished} of ${progressDocumentIds.size} files processed`;
  const signature = JSON.stringify(visible);
  if (signature === renderedSignature) return;
  renderedSignature = signature;
  const focused = document.activeElement;
  const openMenus = new Set(
    [...document.querySelectorAll(".action-dropdown[open]")].map(
      (menu) => menu.id,
    ),
  );
  const rows = [];
  for (const d of visible) {
    const tr = node(
      "tr",
      undefined,
      `document-row${ACTIVE.includes(d.status) ? " is-processing" : ""}${d.status === "running" ? " is-running" : ""}`,
    );
    tr.id = `row-${d.id}`;
    const file = node("td"),
      fileLayout = node("div", undefined, "document-file");
    const toggle = action(
      expanded.has(d.id) ? "⌄" : "›",
      () => toggleDetail(d),
      "expand-toggle",
    );
    toggle.id = `toggle-${d.id}`;
    toggle.setAttribute("aria-label", `Validation details for ${d.name}`);
    toggle.setAttribute("aria-expanded", String(expanded.has(d.id)));
    toggle.setAttribute("aria-controls", `details-${d.id}`);
    tr.addEventListener("click", (event) => {
      if (
        event.target.closest(
          "a, button, input, select, summary, [role='button']",
        )
      )
        return;
      toggleDetail(d).catch(showError);
    });
    const info = node("div");
    const link = node(d.pdf_available ? "a" : "span", d.name, "pdf-link");
    if (d.pdf_available) {
      link.href = `/api/v1/documents/${d.id}/pdf`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.setAttribute("aria-label", `${d.name} (opens PDF in a new tab)`);
    }
    info.append(
      link,
      node(
        "span",
        `${new Date((d.submitted || d.created) * 1000).toLocaleDateString()} · ${d.page_count == null ? "Page count unavailable" : `${d.page_count} ${d.page_count === 1 ? "page" : "pages"}`} · ${size(d.size)}`,
        "file-metadata",
      ),
    );
    fileLayout.append(toggle, info);
    file.append(fileLayout);
    const status = node("td", undefined, "profile-outcomes");
    const requestedProfiles = d.validation_profiles.map(
      (alias) => profileIds[alias] || alias,
    );
    for (const profile of requestedProfiles) {
      const result = d.profiles?.find((r) => r.profile === profile);
      const resultStatus = result?.status || d.status;
      const line = node("div", undefined, `profile-line ${resultStatus}`);
      const issueCount = result?.summary?.errors ?? result?.issue_total;
      line.setAttribute(
        "aria-label",
        `${profileLabel(profile)}: ${labels[resultStatus] || "Pending"}, ${issueCount ?? "unknown"} errors`,
      );
      line.append(
        node("span", profileLabel(profile), "profile-name"),
        node(
          "span",
          resultStatus === "passed"
            ? "Pass"
            : resultStatus === "failed"
              ? "Fail"
              : resultStatus === "error"
                ? "Error"
                : "Pending",
          "profile-state",
        ),
      );
      if (resultStatus !== "passed") {
        line.append(
          node(
            "span",
            issueCount ?? (d.status === "running" ? "" : "—"),
            `profile-count${d.status === "running" ? " is-processing" : ""}`,
          ),
        );
      }
      status.append(line);
    }
    const actions = node("td");
    const split = node("div", undefined, "split-button");
    const reportButton = action("Download report", () =>
      download(d.id, "json"),
    );
    reportButton.id = `report-${d.id}`;
    reportButton.disabled = !TERMINAL.includes(d.status) || !d.profiles?.length;
    const menu = node("details", undefined, "action-dropdown");
    menu.id = `actions-${d.id}`;
    menu.open = openMenus.has(menu.id);
    const summary = node("summary", "▾");
    summary.id = `menu-${d.id}`;
    summary.setAttribute("aria-label", `More actions for ${d.name}`);
    const options = node("div", undefined, "action-options");
    for (const profile of d.profiles || []) {
      if (profile.summary)
        options.append(
          action(`${profileLabel(profile.profile)} XML`, () => {
            menu.open = false;
            return download(d.id, "xml", profile.profile);
          }),
        );
    }
    options.append(
      action("View validation details", () => {
        menu.open = false;
        return toggleDetail(d, true);
      }),
    );
    options.append(
      action(
        "Delete file",
        () => {
          menu.open = false;
          confirmDelete(d);
        },
        "danger",
      ),
    );
    menu.append(summary, options);
    split.append(reportButton, menu);
    actions.append(split);
    tr.append(file, status, actions);
    const detail = detailRows.get(d.id) || node("tr", undefined, "detail-row");
    detail.id = `details-${d.id}`;
    detail.hidden =
      !expanded.has(d.id) && !detail.classList.contains("detail-closing");
    detailRows.set(d.id, detail);
    rows.push(tr, detail);
  }
  $("results-body").replaceChildren(...rows);
  if (focused?.isConnected) focused.focus({ preventScroll: true });
  else if (focused?.id)
    document.getElementById(focused.id)?.focus({ preventScroll: true });
}
let refreshSequence = 0;
async function refresh() {
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
async function poll() {
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
let searchTimer;
$("search").oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => refresh().catch(showError), 250);
};
$("filter").onchange = () => refresh().catch(showError);
$("load-more").onclick = () => {
  documentLimit += 20;
  refresh().catch(showError);
};
const expanded = new Set(),
  detailRows = new Map();
let renderedSignature = "";
const previewCache = new Map();
const profileIds = Object.fromEntries(
  config.profiles.map((p) => [p.alias, p.id]),
);
const profileLabels = Object.fromEntries(
  config.profiles.map((p) => [p.id, p.label]),
);
const profileLabel = (profile) => profileLabels[profile] || profile;
const fetchPdf = (id) => api(`/documents/${id}/pdf`, { download: true });
// Rendered previews are cached per size; failures are evicted so they can retry.
function cachedPreview(docId, occurrence, width) {
  const key = `${docId}:${occurrence.page || ""}:${occurrence.location || ""}:${width}`;
  if (!previewCache.has(key)) {
    const result = renderOccurrencePreview(docId, occurrence, fetchPdf, width);
    result.catch(() => previewCache.delete(key));
    previewCache.set(key, result);
  }
  return previewCache.get(key);
}
const previewAlt = (image) =>
  `PDF page ${image.page}${image.precise ? " with the failed region boxed in red" : " without a precise highlight"}`;
async function loadOccurrencePreviews(previews, docId, occurrences) {
  for (const [index, preview] of previews.entries()) {
    if (preview.dataset.previewsLoaded) continue;
    preview.dataset.previewsLoaded = "true";
    const occurrence = occurrences[index];
    if (
      !occurrence.page &&
      /(?:^|\/)metadata\[\d+\]|XMPPackage/i.test(occurrence.location || "")
    ) {
      preview.textContent =
        "Document-level check; no page preview is available.";
      preview.title = occurrence.location || "Document-level veraPDF location";
      continue;
    }
    preview.textContent = "Loading page preview…";
    try {
      const image = await cachedPreview(docId, occurrence, 320);
      const button = node("button", undefined, "preview-thumb");
      button.type = "button";
      button.setAttribute(
        "aria-label",
        `Enlarge PDF page ${image.page} preview${image.precise ? " with exact error bounds" : " without an exact highlight"}`,
      );
      const thumbnail = node("img");
      thumbnail.src = image.src;
      thumbnail.alt = previewAlt(image);
      button.append(thumbnail);
      button.onclick = () => openPreview(docId, occurrence, image);
      preview.classList.remove("muted");
      preview.replaceChildren(
        button,
        node("span", `Page ${image.page}`, "muted preview-caption"),
      );
    } catch (error) {
      delete preview.dataset.previewsLoaded;
      preview.textContent = "PDF page preview unavailable.";
      preview.title = error instanceof Error ? error.message : String(error);
      console.warn("PDF occurrence preview failed", {
        docId,
        location: occurrence.location,
        error,
      });
    }
  }
}
function outcome(result, status) {
  if (!result) return labels[status] || "Pending";
  if (result.status === "error") return "Processing error";
  return `${result.passed ? "Pass" : "Fail"} · ${result.summary?.errors ?? "Unknown"} ${result.summary?.errors === 1 ? "error" : "errors"}`;
}
async function toggleDetail(doc, forceOpen = false) {
  const anchor = document.getElementById(`row-${doc.id}`);
  const anchorTop = anchor?.getBoundingClientRect().top;
  const closing = expanded.has(doc.id) && !forceOpen;
  const detail = detailRows.get(doc.id);
  if (closing) detail?.classList.add("detail-closing");
  if (closing) expanded.delete(doc.id);
  else expanded.add(doc.id);
  renderedSignature = "";
  renderResults();
  // Replacing the tbody can make the browser's scroll anchoring choose a
  // different table position. Keep the toggled row at its current viewport Y.
  if (anchorTop != null) {
    requestAnimationFrame(() => {
      const currentTop = document
        .getElementById(`row-${doc.id}`)
        ?.getBoundingClientRect().top;
      if (currentTop != null) window.scrollBy(0, currentTop - anchorTop);
    });
  }
  if (closing) {
    const row = detailRows.get(doc.id);
    window.setTimeout(() => {
      if (!row || expanded.has(doc.id)) return;
      row.hidden = true;
      row.classList.remove("detail-closing");
    }, 180);
  } else {
    const row = detailRows.get(doc.id);
    row?.classList.remove("detail-closing");
    row?.classList.add("detail-enter");
    window.setTimeout(() => {
      if (!row) return;
      row.classList.remove("detail-enter");
    }, 220);
    await loadDetail(doc);
  }
}
async function loadDetail(doc, offset = 0) {
  const row = detailRows.get(doc.id);
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
    const [d, groups] = await Promise.all([
      api(`/documents/${doc.id}?limit=1`),
      api(`/documents/${doc.id}/issues?offset=${offset}`),
    ]);
    content.replaceChildren();
    const summary = node("aside", undefined, "validation-summary");
    summary.append(node("h3", "Validation summary"));
    for (const r of d.results) {
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
    const violations = node("section", undefined, "grouped-issues");
    violations.append(node("h3", `Accessibility issues (${groups.total})`));
    if (!groups.total)
      violations.append(
        node(
          "p",
          d.status === "passed"
            ? "No automated rule failures found."
            : d.status === "error"
              ? "Processing did not complete. Review the profile errors."
              : d.status === "failed"
                ? "No issue details were supplied by the validator."
                : "Results will appear when validation finishes.",
          "muted",
        ),
      );
    for (const group of groups.items) {
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
      if (group.specification)
        body.append(node("p", group.specification, "muted"));
      const occurrences = node("details", undefined, "occurrences");
      const previewContainers = [];
      occurrences.addEventListener("toggle", () => {
        if (occurrences.open)
          loadOccurrencePreviews(
            previewContainers,
            doc.id,
            group.occurrences,
          ).catch(() => {});
      });
      occurrences.append(
        node(
          "summary",
          `${group.count} failed ${group.count === 1 ? "check" : "checks"} · View locations`,
        ),
      );
      for (const occurrence of group.occurrences.slice(0, 5)) {
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
      const additionalOccurrences = group.occurrences.slice(5);
      if (additionalOccurrences.length) {
        const pages = [
          ...new Set(
            additionalOccurrences
              .map((occurrence) => Number(occurrence.page))
              .filter((page) => Number.isInteger(page) && page > 0),
          ),
        ].sort((a, b) => a - b);
        const missingPages = additionalOccurrences.filter((occurrence) => {
          const page = Number(occurrence.page);
          return !Number.isInteger(page) || page < 1;
        }).length;
        const pageSummary = pages.length
          ? `Similar issue on pages: ${pages.join(", ")}.`
          : `Similar issue in ${additionalOccurrences.length} more locations; page numbers were not supplied.`;
        const missingPageSummary =
          pages.length && missingPages
            ? ` Page number unavailable for ${missingPages} more ${missingPages === 1 ? "location" : "locations"}.`
            : "";
        occurrences.append(
          node(
            "p",
            `${pageSummary}${missingPageSummary}`,
            "muted issue-locations-summary",
          ),
        );
      }
      if (group.count > group.occurrences.length)
        occurrences.append(
          node(
            "p",
            "Showing the first 100 checks. Download the JSON report for all locations.",
            "muted",
          ),
        );
      body.append(occurrences);
      issue.append(identity, body);
      violations.append(issue);
    }
    const nav = node("div", undefined, "downloads");
    if (offset)
      nav.append(
        action("Previous issues", () =>
          loadDetail(doc, Math.max(0, offset - 100)),
        ),
      );
    if (offset + groups.items.length < groups.total)
      nav.append(action("More issues", () => loadDetail(doc, offset + 100)));
    violations.append(nav, node("p", config.disclaimer, "muted"));
    content.append(summary, violations);
  } catch (error) {
    content.replaceChildren(
      node("p", error.message, "error"),
      action("Retry details", () => loadDetail(doc, offset)),
    );
  }
}
async function openPreview(docId, occurrence, thumbnail) {
  const dialog = $("preview-dialog");
  $("preview-title").textContent =
    `PDF page ${thumbnail.page} · ${occurrence.message}`;
  $("preview-image").src = thumbnail.src;
  $("preview-image").alt = previewAlt(thumbnail);
  $("preview-note").textContent = "Loading enlarged page…";
  dialog.showModal();
  $("preview-close").focus();
  try {
    const image = await cachedPreview(docId, occurrence, 1100);
    if (!dialog.open) return;
    $("preview-image").src = image.src;
    $("preview-image").alt = previewAlt(image);
    $("preview-note").textContent = image.precise
      ? "Red box uses the coordinates or form annotation bounds identified by veraPDF."
      : "No precise coordinates could be derived from this veraPDF location; the page is shown without a highlight.";
  } catch {
    if (dialog.open)
      $("preview-note").textContent =
        "Could not load the enlarged PDF preview.";
  }
}
$("preview-close").onclick = () => $("preview-dialog").close();
$("preview-dialog").addEventListener("click", (event) => {
  const dialog = event.currentTarget;
  const bounds = dialog.getBoundingClientRect();
  if (
    event.target === dialog &&
    (event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom)
  )
    dialog.close();
});
document.addEventListener("click", (event) => {
  document.querySelectorAll(".action-dropdown[open]").forEach((menu) => {
    if (!menu.contains(event.target)) menu.open = false;
  });
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape")
    document.querySelectorAll(".action-dropdown[open]").forEach((menu) => {
      menu.open = false;
      menu.querySelector("summary").focus();
    });
});
function confirmDelete(doc) {
  $("confirm-title").textContent = `Delete “${doc.name}”?`;
  $("confirm").showModal();
  $("confirm-delete").onclick = async () => {
    try {
      await api(`/documents/${doc.id}`, {
        method: "DELETE",
      });
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
$("confirm-cancel").onclick = () => $("confirm").close();
$("signin").onclick = signIn;
$("signout").onclick = signOut;
$("signin").hidden = !!account();
$("signout").hidden = config.local || !account();
$("identity").textContent = account()?.name || "Organization sign-in required";
let theme = localStorage.getItem("theme") || "system";
function applyTheme() {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  $("theme").textContent = `Theme: ${theme}`;
}
$("theme").onclick = () => {
  theme = { system: "light", light: "dark", dark: "system" }[theme];
  localStorage.setItem("theme", theme);
  applyTheme();
};
applyTheme();
renderStaging();
if (!account())
  notify(
    "Sign in with your organization account to upload and validate documents.",
  );
else poll();
window.addEventListener("online", () => {
  clearTimeout(pollTimer);
  poll();
});

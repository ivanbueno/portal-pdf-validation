import "./style.css";
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
const size = (bytes) =>
  bytes < 1048576
    ? `${(bytes / 1024).toFixed(1)} KiB`
    : `${(bytes / 1048576).toFixed(1)} MiB`;
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
  documentLimit = 20,
  pollDelay = 2500,
  pollTimer;
function notify(text, error = false) {
  $("notice").hidden = !text;
  $("notice").textContent = text;
  $("notice").classList.toggle("error", error);
  $("notice").setAttribute("role", error ? "alert" : "status");
}
function showError(error) {
  notify(error.message || String(error), true);
}
function renderStaging() {
  $("staging").hidden = !staged.length;
  $("submit").disabled = busy || !staged.length || !account();
  $("clear").disabled = busy;
  $("files").disabled = busy;
  $("staged-total").textContent =
    `${staged.length} files · ${size(staged.reduce((n, s) => n + s.file.size, 0))}`;
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
function addFiles(files) {
  if (busy) return;
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      notify(`${file.name}: only PDFs are supported.`, true);
      continue;
    }
    if (!file.size || file.size > config.maxFileBytes) {
      notify(`${file.name}: file must be between 1 byte and 200 MiB.`, true);
      continue;
    }
    if (
      staged.length >= config.maxFiles ||
      staged.reduce((n, s) => n + s.file.size, 0) + file.size >
        config.maxSelectionBytes
    ) {
      notify("This selection exceeds the 200-file or 2 GiB limit.", true);
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
$("drop").ondrop = (e) => {
  e.preventDefault();
  $("drop").classList.remove("dragover");
  addFiles(e.dataTransfer.files);
};
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
$("submit").onclick = async () => {
  busy = true;
  notify("Preparing your documents…");
  $("submit").textContent = "Uploading…";
  renderStaging();
  let submitted = 0;
  // Reserve, upload, and submit independently; one failure never blocks another file.
  for (const item of [...staged]) {
    try {
      item.doc ||= await api("/documents", {
        method: "POST",
        headers: item.key ? { "Idempotency-Key": item.key } : {},
        body: JSON.stringify({ name: item.file.name, size: item.file.size }),
      });
      item.key = item.doc.idempotency_key;
      const current = await api(`/documents/${item.doc.id}`);
      if (current.status === "uploading") {
        if (!item.uploaded) {
          const grant = await api(`/documents/${item.doc.id}/upload-url`, {
            method: "POST",
          });
          await upload(grant.upload_url, item.file, (p) => {
            item.state = `${p}%`;
            renderStaging();
          });
          item.uploaded = true;
        }
        await api(`/documents/${item.doc.id}/submit`, { method: "POST" });
      }
      submitted++;
      staged.splice(staged.indexOf(item), 1);
    } catch (error) {
      item.key ||= error.idempotencyKey;
      item.state = error.message || "Retry required";
    }
    renderStaging();
  }
  busy = false;
  $("submit").textContent = staged.length
    ? "Retry remaining files"
    : "Validate PDFs →";
  renderStaging();
  notify(
    `${submitted} files submitted. ${staged.length ? `${staged.length} files need attention; retry the remaining files.` : "You can leave this page and return to your results."}`,
    !!staged.length,
  );
  await refresh().catch(showError);
};
function renderResults() {
  const docs = documents,
    query = $("search").value.toLowerCase(),
    filter = $("filter").value;
  const visible = docs.filter(
    (d) =>
      d.name.toLowerCase().includes(query) &&
      (filter === "all" ||
        (filter === "active"
          ? ["uploading", "queued", "running"].includes(d.status)
          : d.status === filter)),
  );
  $("count").textContent = docs.length;
  $("empty").hidden = !!visible.length;
  $("results").hidden = !visible.length;
  $("empty").querySelector("h3").textContent = docs.length
    ? "No matching files"
    : "No files yet";
  const submitted = docs.filter((d) => d.status !== "uploading"),
    finished = submitted.filter((d) =>
      ["passed", "failed", "error"].includes(d.status),
    ).length;
  $("stat-processed").textContent = finished;
  $("stat-wcag").textContent = docs.filter((d) =>
    d.profiles?.some((p) => p.profile === "wcag-2.2" && p.status === "passed"),
  ).length;
  $("stat-ua").textContent = docs.filter((d) =>
    d.profiles?.some((p) => p.profile === "pdfua-1" && p.status === "passed"),
  ).length;
  $("stat-pages").textContent = docs.reduce((total, d) => total + (d.page_count || 0), 0);
  $("progress-row").hidden = !submitted.length || finished === submitted.length;
  $("progress").max = submitted.length || 1;
  $("progress").value = finished;
  $("progress-text").textContent =
    `${finished} of ${submitted.length} files processed`;
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
    const tr = node("tr", undefined, "document-row");
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
    for (const profile of ["pdfua-1", "wcag-2.2"]) {
      const result = d.profiles?.find((r) => r.profile === profile);
      const line = node("div", undefined, "profile-line");
      line.append(
        node("strong", profileLabel(profile)),
        node(
          "span",
          outcome(result, d.status),
          `profile-result ${result?.status || d.status}`,
        ),
      );
      status.append(line);
    }
    const actions = node("td");
    const split = node("div", undefined, "split-button");
    const reportButton = action("Download report", () =>
      download(d.id, "json"),
    );
    reportButton.id = `report-${d.id}`;
    reportButton.disabled =
      !["passed", "failed", "error"].includes(d.status) || !d.profiles?.length;
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
    detail.hidden = !expanded.has(d.id);
    detailRows.set(d.id, detail);
    rows.push(tr, detail);
  }
  $("results-body").replaceChildren(...rows);
  if (focused?.isConnected) focused.focus({ preventScroll: true });
  else if (focused?.id)
    document.getElementById(focused.id)?.focus({ preventScroll: true });
}
async function refresh() {
  if (!account()) return;
  const collected = [];
  let total = 0;
  for (let offset = 0; offset < documentLimit; offset += 100) {
    const data = await api(
      `/documents?offset=${offset}&limit=${Math.min(100, documentLimit - offset)}`,
    );
    collected.push(...data.items);
    total = data.total;
    if (collected.length >= total) break;
  }
  documents = collected;
  $("load-more").hidden = total <= documentLimit;
  renderResults();
}
async function poll() {
  try {
    if (document.visibilityState === "visible") {
      await refresh();
      pollDelay = documents.some((d) =>
        ["running", "queued"].includes(d.status),
      )
        ? 2500
        : 15000;
    }
  } catch {
    pollDelay = Math.min(pollDelay * 2, 60000);
  }
  pollTimer = setTimeout(poll, pollDelay);
}
$("refresh").onclick = () => refresh().catch(showError);
$("search").oninput = renderResults;
$("filter").onchange = renderResults;
$("load-more").onclick = () => {
  documentLimit += 20;
  refresh().catch(showError);
};
const expanded = new Set(),
  detailRows = new Map();
let renderedSignature = "";
const profileLabel = (profile) =>
  profile === "pdfua-1" ? "PDF/UA-1" : "WCAG 2.2";
function outcome(result, status) {
  if (!result) return labels[status] || "Pending";
  if (result.status === "error") return "Processing error";
  return `${result.passed ? "Pass" : "Fail"} · ${result.summary?.errors ?? "Unknown"} ${result.summary?.errors === 1 ? "error" : "errors"}`;
}
async function toggleDetail(doc, forceOpen = false) {
  if (expanded.has(doc.id) && !forceOpen) expanded.delete(doc.id);
  else expanded.add(doc.id);
  renderedSignature = "";
  renderResults();
  if (expanded.has(doc.id)) await loadDetail(doc);
}
async function loadDetail(doc, offset = 0) {
  const row = detailRows.get(doc.id);
  if (!row) return;
  const cell = node("td");
  cell.colSpan = 3;
  const content = node("div", undefined, "expanded-report");
  cell.append(content);
  row.replaceChildren(cell);
  content.append(node("p", "Loading validation details…", "muted"));
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
    summary.append(action("Refresh details", () => loadDetail(doc, offset)));
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
      occurrences.append(
        node(
          "summary",
          `${group.count} failed ${group.count === 1 ? "check" : "checks"} · View locations`,
        ),
      );
      for (const occurrence of group.occurrences) {
        const item = node("div", undefined, "issue-location");
        item.append(
          node("strong", profileLabel(occurrence.profile)),
          node("p", occurrence.message),
        );
        if (occurrence.page) item.append(node("p", `Page ${occurrence.page}`));
        item.append(
          node(
            "code",
            occurrence.location || "Location not supplied by veraPDF",
          ),
        );
        occurrences.append(item);
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

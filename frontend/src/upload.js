// File staging, drag and drop, and the reserve → upload → submit workflow.
import { api, account, config, upload } from "./api.js";
import { beginBatch, showBatch, trackDocument } from "./results.js";
import { $, action, limit, node, notify, showError, size } from "./ui.js";

const UPLOAD_CONCURRENCY = 3;

let staged = [],
  busy = false,
  stagingFrame,
  // Nested dragenter/dragleave events fire per element; count them.
  fileDragDepth = 0;

const stagedBytes = () => staged.reduce((n, s) => n + s.file.size, 0);
const selectedProfiles = () =>
  [...document.querySelectorAll('input[name="profile"]:checked')].map(
    (input) => input.value,
  );

// One checkbox per profile; the profiles the API runs by default start checked.
function renderProfileOptions() {
  $("profile-options").append(
    ...config.profiles.map((profile) => {
      const input = node("input");
      input.type = "checkbox";
      input.name = "profile";
      input.value = profile.alias;
      input.checked = profile.default;
      input.addEventListener("change", renderStaging);
      const option = node("label");
      option.append(input, node("strong", profile.label));
      return option;
    }),
  );
}

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
      const remove = action("Remove", async () => {
        await cancelUpload(s);
        staged.splice(i, 1);
        renderStaging();
      });
      remove.disabled = busy;
      remove.setAttribute("aria-label", `Remove ${s.file.name}`);
      const td = node("td");
      td.append(remove);
      tr.append(td);
      return tr;
    }),
  );
}
// Coalesces frequent upload-progress updates into one render per frame.
function scheduleStagingRender() {
  stagingFrame ||= requestAnimationFrame(() => {
    stagingFrame = undefined;
    renderStaging();
  });
}

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
  trackDocument(item.doc.id);
  staged.splice(staged.indexOf(item), 1);
}

function setSubmitting(submitting) {
  busy = submitting;
  $("submit").classList.toggle("is-submitting", submitting);
  if (submitting) {
    $("submit").setAttribute("aria-busy", "true");
    $("submit").textContent = "Uploading…";
  } else {
    $("submit").removeAttribute("aria-busy");
    $("submit").textContent = staged.length
      ? "Retry remaining files"
      : "Validate PDFs →";
  }
  renderStaging();
}

async function submitStaged() {
  beginBatch();
  notify("Preparing your documents…");
  setSubmitting(true);
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
  setSubmitting(false);
  notify(
    `${submitted} files submitted. ${staged.length ? `${staged.length} files need attention; retry the remaining files.` : "You can leave this page and return to your results."}`,
    !!staged.length,
  );
  await showBatch().catch(showError);
}

const isFileDrag = (event) =>
  Array.from(event.dataTransfer?.types || []).includes("Files");
function clearFileDrag() {
  fileDragDepth = 0;
  document.body.classList.remove("file-dragging");
  $("drop").classList.remove("dragover");
}
function initDragAndDrop() {
  $("drop").ondragover = (e) => {
    e.preventDefault();
    $("drop").classList.add("dragover");
  };
  $("drop").ondragleave = () => $("drop").classList.remove("dragover");
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
}

export function initUploads() {
  renderProfileOptions();
  $("files").onchange = (e) => {
    addFiles(e.target.files);
    e.target.value = "";
  };
  $("clear").onclick = async () => {
    try {
      for (const item of staged) await cancelUpload(item);
      staged = [];
      renderStaging();
    } catch (e) {
      showError(e);
    }
  };
  $("submit").onclick = submitStaged;
  initDragAndDrop();
  renderStaging();
}

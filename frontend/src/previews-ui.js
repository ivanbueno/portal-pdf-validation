// Page-preview thumbnails for issue locations and the enlarged preview dialog.
import { api } from "./api.js";
import { renderOccurrencePreview } from "./pdf-previews.js";
import { $, node } from "./ui.js";

const THUMBNAIL_WIDTH = 320;
const ENLARGED_WIDTH = 1100;
const previewCache = new Map();

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
const isDocumentLevel = (occurrence) =>
  !occurrence.page &&
  /(?:^|\/)metadata\[\d+\]|XMPPackage/i.test(occurrence.location || "");

function thumbnailButton(docId, occurrence, image) {
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
  return button;
}

export async function loadOccurrencePreviews(previews, docId, occurrences) {
  for (const [index, preview] of previews.entries()) {
    if (preview.dataset.previewsLoaded) continue;
    preview.dataset.previewsLoaded = "true";
    const occurrence = occurrences[index];
    if (isDocumentLevel(occurrence)) {
      preview.textContent =
        "Document-level check; no page preview is available.";
      preview.title = occurrence.location || "Document-level veraPDF location";
      continue;
    }
    preview.textContent = "Loading page preview…";
    try {
      const image = await cachedPreview(docId, occurrence, THUMBNAIL_WIDTH);
      preview.classList.remove("muted");
      preview.replaceChildren(
        thumbnailButton(docId, occurrence, image),
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
    const image = await cachedPreview(docId, occurrence, ENLARGED_WIDTH);
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

export function initPreviewDialog() {
  $("preview-close").onclick = () => $("preview-dialog").close();
  // Close on backdrop clicks, which land on the dialog outside its content box.
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
}

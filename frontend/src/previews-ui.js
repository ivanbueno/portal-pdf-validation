// Page-preview thumbnails for issue locations and the enlarged preview dialog.
import { isDocumentLevel } from "./pdf-locations.js";
import { renderOccurrencePreview } from "./pdf-previews.js";
import { $, node } from "./ui.js";

const THUMBNAIL_WIDTH = 320;
const ENLARGED_WIDTH = 1100;
let dialogRequest = 0,
  dialogController,
  detachOwner;
const previewAlt = (image) =>
  `PDF page ${image.page}${image.precise ? " with the failed region boxed in red" : " without a precise highlight"}`;

function thumbnailButton(docId, occurrence, image, signal) {
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
  button.onclick = () => openPreview(docId, occurrence, image, signal);
  return button;
}

export async function loadOccurrencePreviews(
  previews,
  docId,
  occurrences,
  signal,
) {
  if (signal.aborted) return;
  signal.addEventListener(
    "abort",
    () => {
      for (const preview of previews) {
        delete preview.dataset.previewsLoaded;
        preview.replaceChildren();
        preview.textContent = "Open locations to load page preview.";
        preview.classList.add("muted");
      }
    },
    { once: true },
  );
  for (const [index, preview] of previews.entries()) {
    if (signal.aborted || !preview.isConnected) return;
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
      const image = await renderOccurrencePreview(
        docId,
        occurrence,
        THUMBNAIL_WIDTH,
        signal,
      );
      if (signal.aborted || !preview.isConnected) return;
      preview.classList.remove("muted");
      preview.replaceChildren(
        thumbnailButton(docId, occurrence, image, signal),
        node("span", `Page ${image.page}`, "muted preview-caption"),
      );
    } catch (error) {
      if (signal.aborted) return;
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

function cancelDialogRequest() {
  dialogRequest++;
  dialogController?.abort();
  detachOwner?.();
  detachOwner = undefined;
  $("preview-image").removeAttribute("src");
}

function closePreview() {
  cancelDialogRequest();
  $("preview-dialog").close();
}

async function openPreview(docId, occurrence, thumbnail, ownerSignal) {
  if (ownerSignal.aborted) return;
  cancelDialogRequest();
  const token = dialogRequest;
  const controller = (dialogController = new AbortController());
  ownerSignal.addEventListener("abort", closePreview, { once: true });
  detachOwner = () => ownerSignal.removeEventListener("abort", closePreview);
  const dialog = $("preview-dialog");
  $("preview-title").textContent =
    `PDF page ${thumbnail.page} · ${occurrence.message}`;
  $("preview-image").src = thumbnail.src;
  $("preview-image").alt = previewAlt(thumbnail);
  $("preview-note").textContent = "Loading enlarged page…";
  dialog.showModal();
  $("preview-close").focus();
  try {
    const image = await renderOccurrencePreview(
      docId,
      occurrence,
      ENLARGED_WIDTH,
      controller.signal,
    );
    if (!dialog.open || token !== dialogRequest) return;
    $("preview-image").src = image.src;
    $("preview-image").alt = previewAlt(image);
    $("preview-note").textContent = image.precise
      ? "Red box uses the coordinates or form annotation bounds identified by veraPDF."
      : "No precise coordinates could be derived from this veraPDF location; the page is shown without a highlight.";
  } catch {
    if (dialog.open && token === dialogRequest)
      $("preview-note").textContent =
        "Could not load the enlarged PDF preview.";
  }
}

export function initPreviewDialog() {
  $("preview-close").onclick = closePreview;
  $("preview-dialog").addEventListener("cancel", cancelDialogRequest);
  $("preview-dialog").addEventListener("close", () => {
    // A queued close event from the previous view must not cancel a new view.
    if (!$("preview-dialog").open) cancelDialogRequest();
  });
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
      closePreview();
  });
}

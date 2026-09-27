// Page previews for veraPDF issue occurrences: locate the failing region, then
// render its page with the region boxed.
import {
  evictOldest,
  markedContentRects,
  pageAnnotations,
  touch,
  withDocument,
} from "./pdf-document.js";
import { toViewportRect, unionRects, validRect } from "./pdf-geometry.js";
import { contentItem, explicitBounds, objectNumbers } from "./pdf-locations.js";

const HIGHLIGHT = "#df2020";
const REGION_LIMIT = 100;
// Rendered images are data URLs; bound them by count and approximate UTF-16 size.
const PREVIEW_LIMITS = {
  count: 24,
  weight: 16 * 1024 * 1024,
  weigh: (image) => image.src.length * 2,
};

async function structureBounds(source, occurrence) {
  if (!objectNumbers(occurrence.location).length) return null;
  const structure = await import("./pdf-structure.js");
  return structure.structureBounds(source, occurrence);
}

async function explicitRegion(source, occurrence) {
  const bounds = explicitBounds(occurrence.location);
  return bounds && { page: bounds.page, rects: [bounds.rect] };
}

async function contentItemRegion(source, occurrence) {
  const item = contentItem(occurrence.location);
  if (!item) return null;
  const rects =
    (await markedContentRects(source, item.page)).get(item.content) || [];
  if (!rects.length) return null;
  const selected = rects[item.index] ? [rects[item.index]] : rects;
  return { page: item.page, rects: [unionRects(selected)] };
}

// Best-effort locators, most precise first. Each resolves to { page, rects } or
// null; failures count as no match.
const LOCATORS = [explicitRegion, contentItemRegion, structureBounds];

// Form fields: veraPDF names the widget object, which pdf.js exposes as an
// annotation ID. Searches the reported page, or every page when there is none.
async function annotationRegion(source, occurrence, reportedPage, signal) {
  const refs = objectNumbers(occurrence.location)
    .map(([number]) => `${number}R`)
    .reverse();
  if (!refs.length) return null;
  const last = reportedPage || source.pdf.numPages;
  for (let page = reportedPage || 1; page <= last; page++) {
    signal.throwIfAborted();
    const annotations = await pageAnnotations(source, page);
    const annotation = refs
      .map((ref) =>
        annotations.find(
          (item) =>
            item.subtype === "Widget" &&
            (item.id === ref || item.parentId === ref),
        ),
      )
      .find(Boolean);
    if (annotation) return { page, rects: [annotation.rect] };
  }
  return null;
}

async function locate(source, occurrence, signal) {
  const reported = Number(occurrence.page);
  const reportedPage =
    Number.isInteger(reported) && reported > 0 ? reported : null;
  for (const locator of LOCATORS) {
    signal.throwIfAborted();
    const region = await locator(source, occurrence).catch(() => null);
    // A region without a usable page keeps the page veraPDF reported.
    if (region)
      return { page: region.page || reportedPage, rects: region.rects };
  }
  return (
    (await annotationRegion(source, occurrence, reportedPage, signal)) || {
      page: reportedPage,
      rects: [],
    }
  );
}

// Everything `locate` reads: table messages can name the rows to box.
export const occurrenceKey = (occurrence) =>
  JSON.stringify([occurrence.page, occurrence.location, occurrence.message]);

async function renderPage(pdf, pageNumber, rects, width, signal) {
  const page = await pdf.getPage(pageNumber);
  signal.throwIfAborted();
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / base.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d", { alpha: false });
  const task = page.render({ canvas, canvasContext: context, viewport });
  const cancel = () => task.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await task.promise;
    signal.throwIfAborted();
  } catch (error) {
    canvas.width = canvas.height = 0;
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  context.strokeStyle = HIGHLIGHT;
  context.lineWidth = Math.max(
    3,
    Math.min(canvas.width, canvas.height) * 0.009,
  );
  for (const rect of rects.filter(validRect)) {
    const [left, top, right, bottom] = toViewportRect(viewport, rect);
    context.strokeRect(left, top, right - left, bottom - top);
  }
  return canvas;
}

// A PNG data URL, encoded asynchronously: canvas.toDataURL blocks the main
// thread. Data URLs are plain strings, so a cache can drop one that an image
// still shows, which an object URL would need revoking for.
async function encode(canvas) {
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob(
      (png) =>
        png
          ? resolve(png)
          : reject(new Error("Page preview could not be encoded")),
      "image/png",
    ),
  );
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function renderOccurrencePreview(
  docId,
  occurrence,
  width,
  signal,
) {
  return withDocument(docId, signal, async (source) => {
    const key = `${occurrenceKey(occurrence)}:${width}`;
    if (source.previews.has(key)) return touch(source.previews, key);
    // Located once per occurrence: the thumbnail and enlarged renders share it.
    // Location work belongs to this operation; don't share its cancellation with
    // another consumer. Cache only completed locations.
    const locationKey = occurrenceKey(occurrence);
    const { page, rects } =
      source.regions.get(locationKey) ||
      (await locate(source, occurrence, signal));
    signal.throwIfAborted();
    touch(source.regions, locationKey, { page, rects });
    evictOldest(source.regions, { count: REGION_LIMIT });
    if (!page || page < 1 || page > source.pdf.numPages)
      throw new Error("No page could be matched to this veraPDF location");
    const canvas = await renderPage(source.pdf, page, rects, width, signal);
    try {
      const image = {
        src: await encode(canvas),
        page,
        precise: rects.some(validRect),
      };
      signal.throwIfAborted();
      touch(source.previews, key, image);
      evictOldest(source.previews, PREVIEW_LIMITS);
      return image;
    } finally {
      canvas.width = canvas.height = 0;
    }
  });
}

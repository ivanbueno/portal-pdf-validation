// Page previews for veraPDF issue occurrences: locate the failing region, then
// render its page with the region boxed.
import { loadDocument, markedContentRects } from "./pdf-document.js";
import { toViewportRect, unionRects, validRect } from "./pdf-geometry.js";
import { contentItem, explicitBounds, objectNumbers } from "./pdf-locations.js";
import { structureBounds } from "./pdf-structure.js";

const HIGHLIGHT = "#df2020";

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
async function annotationRegion(source, occurrence, reportedPage) {
  const refs = objectNumbers(occurrence.location)
    .map(([number]) => `${number}R`)
    .reverse();
  if (!refs.length) return null;
  const { pdf } = source;
  const last = reportedPage || pdf.numPages;
  for (let page = reportedPage || 1; page <= last; page++) {
    const annotations = await (
      await pdf.getPage(page)
    ).getAnnotations({ intent: "display" });
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

async function locate(source, occurrence) {
  const reported = Number(occurrence.page);
  const reportedPage =
    Number.isInteger(reported) && reported > 0 ? reported : null;
  for (const locator of LOCATORS) {
    const region = await locator(source, occurrence).catch(() => null);
    // A region without a usable page keeps the page veraPDF reported.
    if (region)
      return { page: region.page || reportedPage, rects: region.rects };
  }
  return (
    (await annotationRegion(source, occurrence, reportedPage)) || {
      page: reportedPage,
      rects: [],
    }
  );
}

async function renderPage(pdf, pageNumber, rects, width) {
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / base.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d", { alpha: false });
  await page.render({ canvas, canvasContext: context, viewport }).promise;
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
  fetchPdf,
  width,
) {
  const source = await loadDocument(docId, fetchPdf);
  const { page, rects } = await locate(source, occurrence);
  if (!page || page < 1 || page > source.pdf.numPages)
    throw new Error("No page could be matched to this veraPDF location");
  const canvas = await renderPage(source.pdf, page, rects, width);
  return {
    src: await encode(canvas),
    page,
    precise: rects.some(validRect),
  };
}

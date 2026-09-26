import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRef,
} from "pdf-lib";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

let cachedDocument;
// veraPDF locations name PDF objects as "(12 0 obj ...)".
const objectNumbers = (location) =>
  [...(location || "").matchAll(/\((?:<)?(\d+)\s+(\d+)\s+obj/g)].map(
    (match) => [Number(match[1]), Number(match[2])],
  );
// pdf.js annotation IDs.
const objectRefs = (location) =>
  objectNumbers(location).map(([number]) => `${number}R`);
// pdf-lib references.
const structureRefs = (location) =>
  objectNumbers(location).map(([number, generation]) =>
    PDFRef.of(number, generation),
  );

function explicitBounds(location) {
  if (!location) return null;
  try {
    const parsed = JSON.parse(location);
    const item = parsed.bbox?.[0];
    if (item) return { page: Number(item.p) + 1, rect: item.rect.map(Number) };
  } catch {
    // veraPDF also emits a path form for bounding boxes.
  }
  const match = location.match(
    /(?:^|\/)pages\[(\d+)(?:-\d+)?\]\/boundingBox\[([\d.eE+-]+),([\d.eE+-]+),([\d.eE+-]+),([\d.eE+-]+)\]/,
  );
  if (!match) return null;
  return {
    page: Number(match[1]) + 1,
    rect: match.slice(2).map(Number),
  };
}

const validRect = (rect) =>
  Array.isArray(rect) &&
  rect.length === 4 &&
  rect.every(Number.isFinite) &&
  rect[0] !== rect[2] &&
  rect[1] !== rect[3];

const unionRects = (rects) =>
  rects.reduce(
    (merged, rect) =>
      merged
        ? [
            Math.min(merged[0], rect[0]),
            Math.min(merged[1], rect[1]),
            Math.max(merged[2], rect[2]),
            Math.max(merged[3], rect[3]),
          ]
        : rect,
    null,
  );

const toViewportRect = (viewport, rect) => {
  const first = viewport.convertToViewportPoint(rect[0], rect[1]);
  const second = viewport.convertToViewportPoint(rect[2], rect[3]);
  return [
    Math.min(first[0], second[0]),
    Math.min(first[1], second[1]),
    Math.max(first[0], second[0]),
    Math.max(first[1], second[1]),
  ];
};

async function scanMarkedContent(document, pageNumber) {
  const page = await document.getPage(pageNumber);
  const content = await page.getTextContent({ includeMarkedContent: true });
  const byMcid = new Map();
  const markedContent = [];
  for (const item of content.items) {
    if (item.type === "beginMarkedContentProps") {
      const id = Number(item.id?.match(/_mc(\d+)$/)?.[1]);
      markedContent.push(Number.isFinite(id) ? id : null);
    } else if (item.type === "endMarkedContent") {
      markedContent.pop();
    } else if (item.str?.trim()) {
      const id = [...markedContent].reverse().find((value) => value !== null);
      if (id === undefined) continue;
      const [, , c, d, x, y] = item.transform;
      const height = Math.hypot(c, d) || item.height || 0;
      const rect = [x, y, x + (item.width || 0), y + height];
      if (!validRect(rect)) continue;
      if (!byMcid.has(id)) byMcid.set(id, []);
      byMcid.get(id).push(rect);
    }
  }
  return byMcid;
}

// Text rectangles grouped by marked-content ID (MCID), scanned once per page.
function markedContentRects(pageNumber) {
  const cache = (cachedDocument.markedContent ||= new Map());
  if (!cache.has(pageNumber)) {
    const scan = scanMarkedContent(cachedDocument.document, pageNumber);
    scan.catch(() => cache.delete(pageNumber));
    cache.set(pageNumber, scan);
  }
  return cache.get(pageNumber);
}

async function loadDocument(docId, fetchPdf) {
  if (cachedDocument?.docId === docId) return cachedDocument.promise;
  // pdf.js 6 removed PDFDocumentProxy.destroy(); the loading task owns cleanup.
  if (cachedDocument?.document)
    await cachedDocument.document.loadingTask.destroy();
  const entry = { docId, dataPromise: null, document: null, promise: null };
  cachedDocument = entry;
  const promise = (async () => {
    const blob = await fetchPdf(docId);
    entry.dataPromise = blob.arrayBuffer().then((data) => new Uint8Array(data));
    const data = await entry.dataPromise;
    return pdfjs.getDocument({ data: data.slice() }).promise;
  })();
  entry.promise = promise;
  try {
    const document = await promise;
    if (cachedDocument?.docId === docId) entry.document = document;
    return document;
  } catch (error) {
    if (cachedDocument?.docId === docId) cachedDocument = undefined;
    throw error;
  }
}

async function deriveContentItemBounds(occurrence) {
  const match = occurrence.location?.match(
    /(?:^|\/)pages\[(\d+)(?:-\d+)?\].*?\/content\[(\d+)\]\/contentItem\[(\d+)\]/,
  );
  if (!match || !cachedDocument?.document) return null;
  const pageNumber = Number(match[1]) + 1;
  const itemIndex = Number(match[3]);
  const rects =
    (await markedContentRects(pageNumber)).get(Number(match[2])) || [];
  if (!rects.length) return null;
  const selected = rects[itemIndex] ? [rects[itemIndex]] : rects;
  return { page: pageNumber, rects: [unionRects(selected)] };
}

async function deriveStructuralBounds(occurrence) {
  const refs = structureRefs(occurrence.location);
  const targetRef = refs.at(-1);
  if (!targetRef || !cachedDocument?.dataPromise) return null;
  const data = await cachedDocument.dataPromise;
  cachedDocument.rawPdfPromise ||= PDFDocument.load(data.slice(), {
    updateMetadata: false,
  });
  const rawPdf = await cachedDocument.rawPdfPromise;
  const context = rawPdf.context;
  const resolve = (object) =>
    object instanceof PDFRef ? context.lookup(object) : object;
  const dictionary = (object) => {
    const resolved = resolve(object);
    return resolved instanceof PDFDict ? resolved : null;
  };
  const get = (object, key) => dictionary(object)?.get(PDFName.of(key));
  const kids = (object) => {
    const value = resolve(get(object, "K"));
    return value instanceof PDFArray
      ? Array.from({ length: value.size() }, (_, index) => value.get(index))
      : value
        ? [value]
        : [];
  };
  const element = dictionary(targetRef);
  if (!element) return null;
  const selectedElements = [element];
  if (get(element, "S")?.toString() === "/Table") {
    const rows = [];
    const visited = new Set();
    const collectRows = (object, isRoot = false) => {
      if (object instanceof PDFRef) {
        if (visited.has(object.toString())) return;
        visited.add(object.toString());
      }
      const type = get(object, "S")?.toString();
      if (type === "/TR") {
        rows.push(object);
        return;
      }
      if (type === "/Table" && !isRoot) return;
      for (const child of kids(object)) collectRows(child);
    };
    collectRows(element, true);
    if (!rows.length) return null;

    const rowMatch = occurrence.message.match(
      /\brows?\s+(\d+)(?:\s+and\s+(\d+))?/i,
    );
    selectedElements.splice(
      0,
      selectedElements.length,
      ...(rowMatch
        ? [
            ...new Set(
              rowMatch
                .slice(1)
                .filter(Boolean)
                .map((value) => Number(value) - 1),
            ),
          ]
            .map((index) => rows[index])
            .filter(Boolean)
        : rows),
    );
  }
  if (!selectedElements.length) return null;

  const pages = rawPdf.getPages();
  const pageNumberForRef = (ref) =>
    pages.findIndex((page) => page.ref.toString() === ref?.toString()) + 1;
  const rowLocations = [];

  for (const selected of selectedElements) {
    const mcidsByPage = new Map();
    const pageNumbers = new Set();
    const seen = new Set();
    const addMcid = (pageRef, value) => {
      if (!(value instanceof PDFNumber) || !pageRef) return;
      const pageNumber = pageNumberForRef(pageRef);
      if (pageNumber < 1) return;
      if (!mcidsByPage.has(pageNumber)) mcidsByPage.set(pageNumber, new Set());
      mcidsByPage.get(pageNumber).add(value.asNumber());
    };
    const walk = (object, inheritedPage) => {
      if (object instanceof PDFNumber) {
        addMcid(inheritedPage, object);
        return;
      }
      if (object instanceof PDFRef) {
        const key = object.toString();
        if (seen.has(key)) return;
        seen.add(key);
      }
      const resolved = resolve(object);
      if (!(resolved instanceof PDFDict)) return;
      const pageRef = get(resolved, "Pg") || inheritedPage;
      const pageNumber = pageNumberForRef(pageRef);
      if (pageNumber > 0) pageNumbers.add(pageNumber);
      addMcid(pageRef, get(resolved, "MCID"));
      for (const child of kids(resolved)) walk(child, pageRef);
    };
    const pageRef = get(selected, "Pg") || get(element, "Pg");
    walk(selected, pageRef);

    for (const pageNumber of pageNumbers) {
      const wanted = mcidsByPage.get(pageNumber) || new Set();
      if (!wanted.size) {
        rowLocations.push({ page: pageNumber, rects: [] });
        continue;
      }
      const byMcid = await markedContentRects(pageNumber);
      const rects = [...wanted].flatMap((id) => byMcid.get(id) || []);
      rowLocations.push({
        page: pageNumber,
        rects: rects.length ? [unionRects(rects)] : [],
      });
    }
  }
  const boxesByPage = new Map();
  for (const item of rowLocations) {
    boxesByPage.set(item.page, [
      ...(boxesByPage.get(item.page) || []),
      ...item.rects,
    ]);
  }
  return [...boxesByPage].map(([page, rects]) => ({ page, rects }));
}

export async function renderOccurrencePreview(
  docId,
  occurrence,
  fetchPdf,
  width,
) {
  const pdf = await loadDocument(docId, fetchPdf);
  const bounds = explicitBounds(occurrence.location);
  const contentItemBounds = bounds
    ? null
    : await deriveContentItemBounds(occurrence).catch(() => null);
  const structuralBounds =
    bounds || contentItemBounds
      ? null
      : await deriveStructuralBounds(occurrence).catch(() => null);
  const reportedPage = Number(occurrence.page);
  const refs = objectRefs(occurrence.location).reverse();
  let pageNumber =
    bounds?.page ||
    contentItemBounds?.page ||
    structuralBounds?.[0]?.page ||
    (Number.isInteger(reportedPage) && reportedPage > 0 ? reportedPage : null);
  let annotation;
  if (
    !bounds &&
    !contentItemBounds &&
    !structuralBounds?.length &&
    refs.length
  ) {
    const first = pageNumber || 1;
    const last = pageNumber || pdf.numPages;
    for (let candidate = first; candidate <= last; candidate++) {
      const candidatePage = await pdf.getPage(candidate);
      const annotations = await candidatePage.getAnnotations({
        intent: "display",
      });
      annotation = refs
        .map((ref) =>
          annotations.find(
            (item) =>
              item.subtype === "Widget" &&
              (item.id === ref || item.parentId === ref),
          ),
        )
        .find(Boolean);
      if (annotation) {
        pageNumber = candidate;
        break;
      }
    }
  }
  if (!pageNumber || pageNumber < 1 || pageNumber > pdf.numPages)
    throw new Error("No page could be matched to this veraPDF location");
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / base.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d", { alpha: false });
  await page.render({ canvas, canvasContext: context, viewport }).promise;

  const rects =
    (contentItemBounds?.page === pageNumber ? contentItemBounds.rects : null) ||
    structuralBounds?.find((item) => item.page === pageNumber)?.rects ||
    [
      validRect(bounds?.rect)
        ? bounds.rect
        : validRect(annotation?.rect)
          ? annotation.rect
          : null,
    ].filter(Boolean);
  for (const rect of rects) {
    if (!validRect(rect)) continue;
    const [left, top, right, bottom] = toViewportRect(viewport, rect);
    context.save();
    context.strokeStyle = "#df2020";
    context.lineWidth = Math.max(
      3,
      Math.min(canvas.width, canvas.height) * 0.009,
    );
    context.strokeRect(
      Math.min(left, right),
      Math.min(top, bottom),
      Math.abs(right - left),
      Math.abs(bottom - top),
    );
    context.restore();
  }
  const precise = rects.some(validRect);
  return {
    src: canvas.toDataURL("image/png"),
    page: pageNumber,
    precise,
  };
}

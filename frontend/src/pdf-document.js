// The PDF loaded for previews, with its per-page caches. Only one document is
// kept: previews are requested for one expanded report at a time.
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { PDFDocument } from "pdf-lib";
import { validRect } from "./pdf-geometry.js";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

let current;

// Resolves to a source: { docId, pdf, data, markedContent, structure }.
export function loadDocument(docId, fetchPdf) {
  if (current?.docId === docId) return current.source;
  // pdf.js 6 removed PDFDocumentProxy.destroy(); the loading task owns cleanup.
  // A document still loading is left to finish for the previews awaiting it.
  const previous = current?.loaded;
  const entry = (current = { docId, loaded: null });
  entry.source = (async () => {
    await previous?.pdf.loadingTask.destroy();
    const blob = await fetchPdf(docId);
    const data = new Uint8Array(await blob.arrayBuffer());
    // pdf.js takes ownership of the bytes it is given, so it gets a copy.
    const pdf = await pdfjs.getDocument({ data: data.slice() }).promise;
    const source = {
      docId,
      pdf,
      data,
      markedContent: new Map(),
      structure: null,
    };
    if (current === entry) entry.loaded = source;
    return source;
  })();
  entry.source.catch(() => {
    if (current === entry) current = undefined;
  });
  return entry.source;
}

// The raw object graph (pdf-lib), parsed on first use for structure lookups.
export function structure(source) {
  source.structure ||= PDFDocument.load(source.data.slice(), {
    updateMetadata: false,
  });
  return source.structure;
}

async function scanMarkedContent(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);
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
export function markedContentRects(source, pageNumber) {
  const cache = source.markedContent;
  if (!cache.has(pageNumber)) {
    const scan = scanMarkedContent(source.pdf, pageNumber);
    scan.catch(() => cache.delete(pageNumber));
    cache.set(pageNumber, scan);
  }
  return cache.get(pageNumber);
}

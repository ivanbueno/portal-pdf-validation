// The PDF loaded for previews, with its per-page caches. Only one document is
// kept: previews are requested for one expanded report at a time.
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { PDFDocument } from "@cantoo/pdf-lib";
import { validRect } from "./pdf-geometry.js";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

let current;

// Resolves to a source: { docId, pdf, data, markedContent, annotations, regions, structure }.
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
      annotations: new Map(),
      regions: new Map(),
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
// The empty password decrypts files that only restrict permissions, whose
// structure trees are otherwise unreadable; unencrypted files ignore it.
export function structure(source) {
  source.structure ||= PDFDocument.load(source.data.slice(), {
    updateMetadata: false,
    password: "",
  });
  return source.structure;
}

async function scanMarkedContent(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent({ includeMarkedContent: true });
  const byMcid = new Map();
  // The innermost MCID for each open marked-content section; sections without
  // one inherit their parent's, so the top is always the one text belongs to.
  const markedContent = [];
  for (const item of content.items) {
    if (item.type === "beginMarkedContentProps") {
      const id = Number(item.id?.match(/_mc(\d+)$/)?.[1]);
      markedContent.push(
        Number.isFinite(id) ? id : (markedContent.at(-1) ?? null),
      );
    } else if (item.type === "endMarkedContent") {
      markedContent.pop();
    } else if (item.str?.trim()) {
      const id = markedContent.at(-1);
      if (id == null) continue;
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

// The promise `compute()` returns, cached under `key`; a failure is evicted so it can retry.
export function cached(cache, key, compute) {
  if (!cache.has(key)) {
    const result = compute();
    result.catch(() => cache.delete(key));
    cache.set(key, result);
  }
  return cache.get(key);
}

// Text rectangles grouped by marked-content ID (MCID), scanned once per page.
export const markedContentRects = (source, pageNumber) =>
  cached(source.markedContent, pageNumber, () =>
    scanMarkedContent(source.pdf, pageNumber),
  );

// A page's display annotations, read once per page.
export const pageAnnotations = (source, pageNumber) =>
  cached(source.annotations, pageNumber, async () =>
    (await source.pdf.getPage(pageNumber)).getAnnotations({
      intent: "display",
    }),
  );

// Document sessions own PDF workers, source bytes, and bounded per-page caches.
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { validRect } from "./pdf-geometry.js";
import { documentSessions } from "./pdf-sessions.js";
import { api } from "./api.js";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export const withDocument = documentSessions((docId) => {
  const controller = new AbortController();
  const { signal } = controller;
  let task, source;
  const ready = (async () => {
    const blob = await api(`/documents/${docId}/pdf`, {
      download: true,
      signal,
    });
    const data = new Uint8Array(await blob.arrayBuffer());
    signal.throwIfAborted();
    // pdf.js takes ownership of the bytes it is given, so it gets a copy.
    task = pdfjs.getDocument({ data: data.slice() });
    const pdf = await task.promise;
    signal.throwIfAborted();
    source = {
      docId,
      pdf,
      data,
      markedContent: new Map(),
      annotations: new Map(),
      regions: new Map(),
      previews: new Map(),
      structure: null,
    };
    return source;
  })();
  return {
    ready,
    async close() {
      controller.abort();
      await task?.destroy();
      if (source) {
        for (const value of Object.values(source))
          if (value instanceof Map) value.clear();
        source.data = null;
        source.structure = null;
      }
    },
  };
});

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

// Bounded caches are Maps in least-recently-used order: reinserting a key
// moves it last, so eviction starts from the first.
export function touch(cache, key, value = cache.get(key)) {
  cache.delete(key);
  cache.set(key, value);
  return value;
}

// Evicts the least recently used entries until at most `count` remain and the
// values `weigh` sizes total at most `weight`.
export function evictOldest(
  cache,
  { count = Infinity, weight = Infinity, weigh = () => 0 },
) {
  let total = 0;
  if (weight !== Infinity)
    for (const value of cache.values()) total += weigh(value);
  for (const [key, value] of cache) {
    if (cache.size <= count && total <= weight) break;
    cache.delete(key);
    total -= weigh(value);
  }
}

// The promise `compute()` returns, cached under `key`; a failure is evicted so it can retry.
export function cached(cache, key, compute, limit = 32) {
  if (!cache.has(key)) {
    const result = compute();
    result.catch(() => {
      if (cache.get(key) === result) cache.delete(key);
    });
    cache.set(key, result);
  }
  const result = touch(cache, key);
  evictOldest(cache, { count: limit });
  return result;
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

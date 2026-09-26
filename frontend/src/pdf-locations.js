// Parsing of veraPDF issue locations. veraPDF page indexes are 0-based; every
// page number returned here is 1-based.

const PAGE = String.raw`(?:^|\/)pages\[(\d+)(?:-\d+)?\]`;
const COORDINATE = String.raw`([\d.eE+-]+)`;
const BOUNDING_BOX = new RegExp(
  String.raw`${PAGE}\/boundingBox\[${COORDINATE},${COORDINATE},${COORDINATE},${COORDINATE}\]`,
);
const CONTENT_ITEM = new RegExp(
  String.raw`${PAGE}.*?\/content\[(\d+)\]\/contentItem\[(\d+)\]`,
);
// PDF objects appear as "(12 0 obj ...)".
const OBJECT = /\((?:<)?(\d+)\s+(\d+)\s+obj/g;
const DOCUMENT_LEVEL = /(?:^|\/)metadata\[\d+\]|XMPPackage/i;

// An explicit bounding box, from veraPDF's JSON or path form: { page, rect }.
export function explicitBounds(location) {
  if (!location) return null;
  try {
    const item = JSON.parse(location).bbox?.[0];
    if (item) return { page: Number(item.p) + 1, rect: item.rect.map(Number) };
  } catch {
    // veraPDF also emits a path form for bounding boxes.
  }
  const match = location.match(BOUNDING_BOX);
  return match
    ? { page: Number(match[1]) + 1, rect: match.slice(2).map(Number) }
    : null;
}

// A content item within a page's content stream: { page, content, index }.
export function contentItem(location) {
  const match = location?.match(CONTENT_ITEM);
  return match
    ? {
        page: Number(match[1]) + 1,
        content: Number(match[2]),
        index: Number(match[3]),
      }
    : null;
}

// [number, generation] of each PDF object named in the location, in order.
export const objectNumbers = (location) =>
  [...(location || "").matchAll(OBJECT)].map((match) => [
    Number(match[1]),
    Number(match[2]),
  ]);

// Metadata checks concern the whole document, not a page.
export const isDocumentLevel = (occurrence) =>
  !occurrence.page && DOCUMENT_LEVEL.test(occurrence.location || "");

// Bounds from the structure tree: veraPDF names a structure element, and the
// marked content it owns gives the region to highlight.
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef } from "pdf-lib";
import { markedContentRects, structure } from "./pdf-document.js";
import { unionRects } from "./pdf-geometry.js";
import { objectNumbers } from "./pdf-locations.js";

// Structure trees can share or loop through indirect objects; visit each once.
function firstVisits() {
  const seen = new Set();
  return (object) => {
    if (!(object instanceof PDFRef)) return true;
    const key = object.toString();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

function structureTree(pdf) {
  const context = pdf.context;
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
  const pages = pdf.getPages();
  const pageNumber = (ref) =>
    pages.findIndex((page) => page.ref.toString() === ref?.toString()) + 1;
  return {
    dictionary,
    get,
    kids,
    pageNumber,
    type: (object) => get(object, "S")?.toString(),
  };
}

// Rows of a table, without descending into nested tables.
function tableRows(tree, table) {
  const rows = [];
  const firstVisit = firstVisits();
  const collect = (object, isRoot = false) => {
    if (!firstVisit(object)) return;
    const type = tree.type(object);
    if (type === "/TR") {
      rows.push(object);
      return;
    }
    if (type === "/Table" && !isRoot) return;
    for (const child of tree.kids(object)) collect(child);
  };
  collect(table, true);
  return rows;
}

// Table messages may name 1-based rows, e.g. "rows 3 and 4".
function mentionedRows(rows, message) {
  const match = message.match(/\brows?\s+(\d+)(?:\s+and\s+(\d+))?/i);
  if (!match) return rows;
  const indexes = new Set(
    match
      .slice(1)
      .filter(Boolean)
      .map((value) => Number(value) - 1),
  );
  return [...indexes].map((index) => rows[index]).filter(Boolean);
}

// The pages an element touches, in order, each with the MCIDs it owns there.
function markedContentByPage(tree, element, pageRef) {
  const pages = new Map();
  const firstVisit = firstVisits();
  const mcids = (page) => {
    if (!pages.has(page)) pages.set(page, new Set());
    return pages.get(page);
  };
  const addMcid = (pageRef, value) => {
    const page = tree.pageNumber(pageRef);
    if (value instanceof PDFNumber && pageRef && page > 0)
      mcids(page).add(value.asNumber());
  };
  const walk = (object, inheritedPage) => {
    // An integer kid is an MCID on the inherited page.
    if (object instanceof PDFNumber) return addMcid(inheritedPage, object);
    if (!firstVisit(object)) return;
    const dict = tree.dictionary(object);
    if (!dict) return;
    const ownPage = tree.get(dict, "Pg") || inheritedPage;
    if (tree.pageNumber(ownPage) > 0) mcids(tree.pageNumber(ownPage));
    addMcid(ownPage, tree.get(dict, "MCID"));
    for (const child of tree.kids(dict)) walk(child, ownPage);
  };
  walk(element, pageRef);
  return pages;
}

async function textBox(source, page, mcids) {
  const byMcid = await markedContentRects(source, page);
  const rects = [...mcids].flatMap((id) => byMcid.get(id) || []);
  return rects.length ? [unionRects(rects)] : [];
}

// { page, rects }: the first page the named element touches, with one box per
// selected element (table rows are boxed separately).
export async function structureBounds(source, occurrence) {
  const target = objectNumbers(occurrence.location).at(-1);
  if (!target) return null;
  const tree = structureTree(await structure(source));
  const element = tree.dictionary(PDFRef.of(...target));
  if (!element) return null;
  let selected = [element];
  if (tree.type(element) === "/Table") {
    const rows = tableRows(tree, element);
    if (!rows.length) return null;
    selected = mentionedRows(rows, occurrence.message);
  }
  const regions = selected.map((item) =>
    markedContentByPage(
      tree,
      item,
      tree.get(item, "Pg") || tree.get(element, "Pg"),
    ),
  );
  const page = regions.flatMap((region) => [...region.keys()])[0];
  if (!page) return null;
  const rects = [];
  for (const region of regions) {
    const mcids = region.get(page);
    if (mcids?.size) rects.push(...(await textBox(source, page, mcids)));
  }
  return { page, rects };
}

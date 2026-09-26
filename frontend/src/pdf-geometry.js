// Rectangles are [x1, y1, x2, y2] in PDF user space unless noted.

export const validRect = (rect) =>
  Array.isArray(rect) &&
  rect.length === 4 &&
  rect.every(Number.isFinite) &&
  rect[0] !== rect[2] &&
  rect[1] !== rect[3];

export const unionRects = (rects) =>
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

// Canvas-space [left, top, right, bottom] for a PDF rectangle.
export const toViewportRect = (viewport, rect) => {
  const first = viewport.convertToViewportPoint(rect[0], rect[1]);
  const second = viewport.convertToViewportPoint(rect[2], rect[3]);
  return [
    Math.min(first[0], second[0]),
    Math.min(first[1], second[1]),
    Math.max(first[0], second[0]),
    Math.max(first[1], second[1]),
  ];
};

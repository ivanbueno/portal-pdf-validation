// Inline SVG icons on a 24px grid, stroked in the current text color so they follow
// the theme. Dependency-free like common.js, so the startup theme toggles can use them.
const PATHS = {
  "alert-octagon":
    "M8.3 3h7.4L21 8.3v7.4L15.7 21H8.3L3 15.7V8.3zM12 8v4.5M12 16h.01",
  "alert-triangle": "M12 3.5l9.5 16.5h-19zM12 10v4M12 17h.01",
  "arrow-right": "M5 12h14M13 6l6 6-6 6",
  check: "M5 12.5l4.5 4.5L19 7.5",
  "circle-check": "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM8.5 12.5l2.5 2.5 4.5-5",
  clock: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 7v5l3 2",
  "external-link":
    "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  files:
    "M8 7V5a2 2 0 0 1 2-2h7l4 4v10a2 2 0 0 1-2 2h-2M5 7h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z",
  info: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 11v5M12 8h.01",
  inbox: "M3 13l3-8h12l3 8v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 13h5l1 3h6l1-3h5",
  lock: "M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM8 11V8a4 4 0 0 1 8 0v3",
  "log-out": "M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 8l4 4-4 4M19 12H9",
  "shield-check":
    "M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6zM8.5 12l2.5 2.5 4.5-4.5",
  sliders:
    "M4 7h9M17 7h3M4 17h3M11 17h9M13 7a2 2 0 1 0 4 0 2 2 0 1 0-4 0M7 17a2 2 0 1 0 4 0 2 2 0 1 0-4 0",
  upload: "M12 16V4M7 9l5-5 5 5M5 20h14",
  "chevron-down": "M6 9l6 6 6-6",
  "chevron-right": "M9 6l6 6-6 6",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  x: "M6 6l12 12M18 6L6 18",
  sun: "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z",
  moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z",
  monitor:
    "M4 4h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8 20h8M12 16v4",
};

const SVG = "http://www.w3.org/2000/svg";

// A decorative icon; the control it sits in carries the accessible name.
export function icon(name) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", PATHS[name]);
  svg.append(path);
  return svg;
}

// Fills the page's `data-icon` placeholders, so its markup names icons without repeating their paths.
export function renderIcons(root = document) {
  for (const el of root.querySelectorAll("[data-icon]"))
    el.replaceChildren(icon(el.dataset.icon));
}

// Gives an icon-only control its name, and sighted pointer users the same name as a tooltip.
export function setIconLabel(control, name, label) {
  control.replaceChildren(icon(name));
  control.setAttribute("aria-label", label);
  control.title = label;
}

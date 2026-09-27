// Inline SVG icons on a 24px grid, stroked in the current text color so they follow
// the theme. Dependency-free like common.js, so the startup theme toggles can use them.
const PATHS = {
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

// Gives an icon-only control its name, and sighted pointer users the same name as a tooltip.
export function setIconLabel(control, name, label) {
  control.replaceChildren(icon(name));
  control.setAttribute("aria-label", label);
  control.title = label;
}

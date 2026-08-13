// Heroicons ships plain SVG files, so Vite's `?raw` inlines the handful we use
// straight into the bundle — no icon font, no web component, no runtime fetch.
// Add an import here (and a line in ICONS) to use a new one.
import arrowTopRightOnSquare from "heroicons/24/outline/arrow-top-right-on-square.svg?raw";
import arrowsRightLeft from "heroicons/24/outline/arrows-right-left.svg?raw";
import bolt from "heroicons/24/outline/bolt.svg?raw";
import buildingOffice2 from "heroicons/24/outline/building-office-2.svg?raw";
import chartBar from "heroicons/24/outline/chart-bar.svg?raw";
import checkBadge from "heroicons/24/outline/check-badge.svg?raw";
import chevronDown from "heroicons/24/outline/chevron-down.svg?raw";
import clock from "heroicons/24/outline/clock.svg?raw";
import exclamationTriangle from "heroicons/24/outline/exclamation-triangle.svg?raw";
import funnel from "heroicons/24/outline/funnel.svg?raw";
import mapFolded from "heroicons/24/outline/map.svg?raw";
import rectangleGroup from "heroicons/24/outline/rectangle-group.svg?raw";
import square3Stack3d from "heroicons/24/outline/square-3-stack-3d.svg?raw";
import squares2x2 from "heroicons/24/outline/squares-2x2.svg?raw";
import users from "heroicons/24/outline/users.svg?raw";

const ICONS = {
  "arrow-top-right-on-square": arrowTopRightOnSquare,
  "arrows-right-left": arrowsRightLeft,
  "bolt": bolt,
  "building-office-2": buildingOffice2,
  "chart-bar": chartBar,
  "check-badge": checkBadge,
  "chevron-down": chevronDown,
  "clock": clock,
  "exclamation-triangle": exclamationTriangle,
  "funnel": funnel,
  "map": mapFolded,
  "rectangle-group": rectangleGroup,
  "square-3-stack-3d": square3Stack3d,
  "squares-2x2": squares2x2,
  "users": users,
};

// Returns the icon as an HTML string, sized in `em` so the surrounding
// font-size class still controls it and `currentColor` still inherits — the two
// things call sites relied on before. Names are literals in our own source, so
// an unknown one is a typo worth failing loudly on.
export function icon(name, cls = "") {
  const svg = ICONS[name];
  if (!svg) throw new Error(`Unknown heroicon: ${name}`);
  return svg.replace(
    "<svg",
    `<svg width="1em" height="1em" focusable="false" class="inline-block shrink-0${cls ? " " + cls : ""}"`
  );
}

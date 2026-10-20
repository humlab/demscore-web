import createElement from "lucide/dist/esm/createElement.mjs";
import Check from "lucide/dist/esm/icons/check.mjs";
import ChevronDown from "lucide/dist/esm/icons/chevron-down.mjs";
import ChevronLeft from "lucide/dist/esm/icons/chevron-left.mjs";
import ChevronRight from "lucide/dist/esm/icons/chevron-right.mjs";
import ChevronUp from "lucide/dist/esm/icons/chevron-up.mjs";
import ChevronsLeft from "lucide/dist/esm/icons/chevrons-left.mjs";
import Download from "lucide/dist/esm/icons/download.mjs";
import Globe from "lucide/dist/esm/icons/globe.mjs";
import Hexagon from "lucide/dist/esm/icons/hexagon.mjs";
import Info from "lucide/dist/esm/icons/info.mjs";
import Map from "lucide/dist/esm/icons/map.mjs";
import Maximize from "lucide/dist/esm/icons/maximize.mjs";
import Minimize from "lucide/dist/esm/icons/minimize.mjs";
import Palette from "lucide/dist/esm/icons/palette.mjs";
import Pause from "lucide/dist/esm/icons/pause.mjs";
import Play from "lucide/dist/esm/icons/play.mjs";
import Table from "lucide/dist/esm/icons/table.mjs";
import X from "lucide/dist/esm/icons/x.mjs";

const ICONS = {
  check: Check,
  "chevron-down": ChevronDown,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  "chevron-up": ChevronUp,
  "chevrons-left": ChevronsLeft,
  download: Download,
  "globe-2": Globe,
  hexagon: Hexagon,
  info: Info,
  map: Map,
  maximize: Maximize,
  minimize: Minimize,
  palette: Palette,
  pause: Pause,
  play: Play,
  table: Table,
  x: X,
};

export function refreshIcons() {
  document.querySelectorAll("[data-lucide]").forEach((placeholder) => {
    const iconName = placeholder.getAttribute("data-lucide");
    const iconNode = ICONS[iconName];
    if (!iconNode) return;

    const classes = ["lucide", `lucide-${iconName}`, placeholder.getAttribute("class")]
      .filter(Boolean)
      .join(" ");
    const attrs = {
      class: classes,
      "aria-hidden": placeholder.getAttribute("aria-hidden") || "true",
      focusable: "false",
    };
    const title = placeholder.getAttribute("title");
    if (title) attrs.title = title;

    placeholder.replaceWith(createElement(iconNode, attrs));
  });
}

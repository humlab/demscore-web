import { BaseController } from "../core/BaseController.js";
import { refreshIcons } from "../core/icons.js";

// The three panels that stand over the map -- the sidebar, the timeline and the
// map dashboard -- can each be put away, and the map can be shown on its own.
//
// Asked for because on a laptop panel the three covered a good part of the map
// even zoomed all the way out. Most of that is answered by `--ui-scale` in
// styles.css, which shrinks them on small windows; this is for the reader who
// wants them gone anyway.
//
// ---- what "put away" means ----
//
// A collapsed panel slides off its edge and leaves a thin strip behind (the
// `.panel-reveal-*` elements this creates). Pointing at the strip brings the
// panel back for as long as the pointer stays on it -- a *peek* -- and the
// panel's own button, now pointing the other way, pins it back for good.
// Keyboard focus moving into a collapsed panel peeks it too, so Tab never
// lands on a control nobody can see.
//
// The dashboard is the exception: it folds down to its legend rather than
// leaving the screen, because the legend is the key to the map's colours and a
// map without one is a picture of nothing in particular. Folded, the legend
// moves down into the map's bottom-left corner with the dashboard's button
// beside it, and that button is the only way back -- a hover peek would lift
// the legend out from under the pointer, since the folded legend no longer
// sits where it does in the full dashboard.
//
// On a touch screen nothing can be pointed at, so the strips are wider there
// and a tap -- or a drag away from the edge -- pins the panel back outright.
//
// ---- map only ----
//
// The map-only button hides all three and asks the browser for full screen.
// The attribution line stays: the map's licence terms are discharged by it
// being always visible (see AGENTS.md), and "only the map" does not get to
// change that.
//
// None of this is remembered between visits. A panel that stays hidden on the
// next visit is a panel the reader has to know how to find.

// How long a peeked panel waits after the pointer leaves before it goes again.
// Long enough to cross the gap between a strip and the panel it brings out.
const PEEK_HIDE_DELAY_MS = 350;

// How far a finger has to drag away from the edge before it counts as pulling
// the panel out rather than as a tap that wandered.
const DRAG_REVEAL_PX = 16;

// Which way each strip is dragged to bring its panel out: x or y, and sign.
const DRAG_DIRECTION = {
  sidebar: { axis: "x", sign: 1 },
  timeline: { axis: "y", sign: 1 },
  dashboard: { axis: "y", sign: -1 },
};

const LABELS = {
  sidebar: { hide: "Hide the side panel", show: "Show the side panel", reveal: "Show the side panel" },
  timeline: { hide: "Hide the timeline", show: "Show the timeline", reveal: "Show the timeline" },
  dashboard: {
    hide: "Hide the map controls, keeping the legend",
    show: "Show the map controls",
    reveal: "Show the map controls",
  },
};

export class PanelCollapseController extends BaseController {
  constructor({ mapController, onLayoutChange }) {
    super();
    this.mapController = mapController;
    this.onLayoutChange = onLayoutChange || (() => {});

    this.appEl = null;
    this.panels = new Map();
    this.mapOnly = false;
    this.mapOnlyButton = null;
  }

  initialize() {
    this.appEl = this.getEl("app");

    this.register("sidebar", this.getEl("controls"), this.getEl("sidebarCollapseBtn"));
    this.register("timeline", this.getEl("timeline-overlay"), this.getEl("timelineCollapseBtn"));
    const dashboard = this.mapController.getMapChoiceDashboard();
    // No strip and no peek for the dashboard: see the note at the top.
    if (dashboard) {
      this.register("dashboard", dashboard, dashboard.querySelector("#dashboardCollapseBtn"), { peeks: false });
    }

    this.installMapOnlyButton();

    // Leaving full screen by the browser's own means -- Escape, or its own
    // button -- leaves map-only with it, or the reader is left with no panels
    // and no full screen to show for it.
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement && this.mapOnly) this.setMapOnly(false);
    });
    // Escape also leaves map-only where full screen was refused or is not
    // offered (an iPhone, or a page in a frame), since then there was no full
    // screen for Escape to leave.
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.mapOnly && !document.fullscreenElement) this.setMapOnly(false);
    });
  }

  register(key, panel, button, { peeks = true } = {}) {
    if (!panel || !button) return;

    const strip = document.createElement("div");
    strip.className = `panel-reveal panel-reveal-${key}`;
    // A pointer surface, not a control: the keyboard reaches a collapsed panel
    // by tabbing into it, which peeks it (focusin below), and a screen reader
    // reaches it the same way. A focusable strip would be a second stop for the
    // same thing.
    strip.setAttribute("aria-hidden", "true");
    strip.title = LABELS[key].reveal;
    strip.innerHTML = '<span class="panel-reveal-grip"></span>';
    this.appEl.appendChild(strip);

    const entry = { key, panel, button, strip, peeks, collapsed: false, peeking: false, hideTimer: null };
    this.panels.set(key, entry);

    // Keyed on whether the panel is away, not on its own flag: in map-only every
    // panel is away while its flag may still say "out", and the button then
    // has to mean "bring it back".
    button.addEventListener("click", () => this.setCollapsed(key, !(entry.collapsed || this.mapOnly)));

    strip.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "mouse") this.peek(key);
    });
    strip.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "mouse") this.scheduleUnpeek(key);
    });
    this.bindStripDrag(entry);

    panel.addEventListener("pointerenter", () => this.cancelUnpeek(key));
    panel.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "mouse" && entry.peeking) this.scheduleUnpeek(key);
    });
    panel.addEventListener("focusin", () => {
      if (entry.collapsed) this.peek(key);
    });
    panel.addEventListener("focusout", (event) => {
      if (entry.peeking && !panel.contains(event.relatedTarget)) this.scheduleUnpeek(key);
    });

    this.render(entry);
  }

  // A tap on a strip, or a drag away from its edge, pins the panel back out.
  // Mouse pointers peek on hover instead (above), so this answers touch and pen.
  bindStripDrag(entry) {
    let start = null;
    entry.strip.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse") return;
      start = { x: event.clientX, y: event.clientY, id: event.pointerId };
      entry.strip.setPointerCapture?.(event.pointerId);
    });
    entry.strip.addEventListener("pointermove", (event) => {
      if (!start || event.pointerId !== start.id) return;
      const { axis, sign } = DRAG_DIRECTION[entry.key];
      const moved = (axis === "x" ? event.clientX - start.x : event.clientY - start.y) * sign;
      if (moved >= DRAG_REVEAL_PX) {
        start = null;
        this.setCollapsed(entry.key, false);
      }
    });
    const end = (event) => {
      if (!start || event.pointerId !== start.id) return;
      start = null;
      // Released without travelling far enough to be a drag: a tap.
      if (event.type === "pointerup") this.setCollapsed(entry.key, false);
    };
    entry.strip.addEventListener("pointerup", end);
    entry.strip.addEventListener("pointercancel", end);
  }

  isCollapsed(key) {
    const entry = this.panels.get(key);
    return Boolean(entry && (entry.collapsed || this.mapOnly) && !entry.peeking);
  }

  setCollapsed(key, collapsed) {
    const entry = this.panels.get(key);
    if (!entry) return;
    entry.collapsed = collapsed;
    entry.peeking = false;
    this.cancelUnpeek(key);
    // Pinning a panel back out of map-only is the reader leaving map-only.
    if (!collapsed && this.mapOnly) {
      this.setMapOnly(false);
      return;
    }
    this.render(entry);
    this.onLayoutChange();
  }

  peek(key) {
    const entry = this.panels.get(key);
    if (!entry || !entry.peeks || !(entry.collapsed || this.mapOnly)) return;
    this.cancelUnpeek(key);
    if (entry.peeking) return;
    entry.peeking = true;
    this.render(entry);
  }

  scheduleUnpeek(key) {
    const entry = this.panels.get(key);
    if (!entry || !entry.peeking) return;
    this.cancelUnpeek(key);
    entry.hideTimer = window.setTimeout(() => {
      entry.hideTimer = null;
      // Still being used: the pointer came back, or focus is inside it.
      if (entry.panel.matches(":hover") || entry.strip.matches(":hover")) return;
      if (entry.panel.contains(document.activeElement)) return;
      entry.peeking = false;
      this.render(entry);
    }, PEEK_HIDE_DELAY_MS);
  }

  cancelUnpeek(key) {
    const entry = this.panels.get(key);
    if (entry?.hideTimer) {
      window.clearTimeout(entry.hideTimer);
      entry.hideTimer = null;
    }
  }

  // State lives on #app as classes, because the layout it changes is #app's --
  // the sidebar's column, the timeline's centring over the pane -- and not just
  // the panel's own.
  render(entry) {
    const { key, button } = entry;
    const away = entry.collapsed || this.mapOnly;
    this.appEl.classList.toggle(`is-collapsed-${key}`, away);
    this.appEl.classList.toggle(`is-peek-${key}`, away && entry.peeking);

    // The button says what pressing it will do. While the panel is only
    // peeking, pressing it pins it back out.
    const label = away ? LABELS[key].show : LABELS[key].hide;
    button.setAttribute("aria-expanded", away ? "false" : "true");
    button.setAttribute("aria-label", label);
    button.title = label;
    // The one-word caption some buttons carry under their chevron.
    const caption = button.querySelector(".panel-collapse-text");
    if (caption) caption.textContent = away ? "Show" : "Hide";
  }

  // ---- map only -------------------------------------------------------------

  installMapOnlyButton() {
    const container = document.createElement("div");
    container.className = "ol-unselectable ol-control map-only-control";
    container.innerHTML = `
      <button type="button" class="map-only-button" aria-pressed="false" aria-label="Show only the map" title="Show only the map">
        <i class="map-only-icon-enter" data-lucide="maximize" aria-hidden="true"></i>
        <i class="map-only-icon-exit" data-lucide="minimize" aria-hidden="true"></i>
      </button>`;
    this.mapOnlyButton = container.querySelector("button");
    this.mapOnlyButton.addEventListener("click", () => this.setMapOnly(!this.mapOnly));
    this.mapController.addMapControl(container);
    refreshIcons();
  }

  setMapOnly(on) {
    if (on === this.mapOnly) return;
    this.mapOnly = on;
    this.appEl.classList.toggle("is-map-only", on);

    const label = on ? "Show the panels again" : "Show only the map";
    this.mapOnlyButton.setAttribute("aria-pressed", on ? "true" : "false");
    this.mapOnlyButton.setAttribute("aria-label", label);
    this.mapOnlyButton.title = label;

    // Full screen is a nicety on top of map-only, not a condition of it: it is
    // refused outside a user gesture, inside a frame, and on an iPhone.
    if (on && !document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else if (!on && document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    }

    for (const entry of this.panels.values()) {
      entry.peeking = false;
      this.cancelUnpeek(entry.key);
      this.render(entry);
    }
    this.onLayoutChange();
  }
}

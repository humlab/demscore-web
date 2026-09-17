import { BaseController } from "../core/BaseController.js";
import { readAreaOutlinesEnabled, writeAreaOutlinesEnabled } from "../core/preferences.js";
import {
  createEqualEarthCrs,
  equalEarthPanBounds,
  equalEarthProjectedBounds,
} from "../core/projection.js";

const POLARITY_POSITIVE = "positive";
const POLARITY_NEUTRAL = "neutral";
const LAND_BASEMAP_COLOR = "#fffaf0";
const HEX_FILL_LAYER = "hex_variable";
// Drawn by MapServer over the fills, from the precomputed edge table; see
// the hex_outline layer in mapserver/mapserver.map. Asking for it in the same
// GetMap as the fills keeps the two in step -- one image, one cache entry, and
// no window where outlines from the previous year sit over this year's colours.
const HEX_OUTLINE_LAYER = "hex_outline";
// Adjacent quantile classes can be a shade apart, which is the whole reason the
// outlines exist, so they start on and the toggle is there to take them off.
const AREA_OUTLINES_DEFAULT = true;
// ntile(7) in demscore.country_scores() is what both the map and the legend are
// built on, so the swatch count is not a styling choice.
const LEGEND_CLASS_COUNT = 7;
// Shorter than the variable list's 170ms: the swatches are small and next to
// each other, so a pointer crossing the bar is usually on its way somewhere,
// but the card it opens is one line of numbers rather than a whole record.
const LEGEND_TIP_HOVER_DELAY_MS = 90;
const LEGEND_TIP_GAP_PX = 12;
const LEGEND_TIP_VIEWPORT_MARGIN_PX = 10;
const LEGEND_TIP_ARROW_INSET_PX = 14;
// Hovering the bar during a scrub can collect a class-break response per year;
// the cache keeps the hovered ones, not the whole timeline.
const CLASS_BREAKS_CACHE_LIMIT = 120;

const LEGEND_COLORS_NEGATIVE = ["#313695", "#4575b4", "#74add1", "#abd9e9", "#fdae61", "#f46d43", "#d73027"];
const LEGEND_COLORS_NEUTRAL = ["#d1fae5", "#a7f3d0", "#6ee7b7", "#34d399", "#10b981", "#059669", "#047857"];
const MIN_ZOOM_FLOOR = 0;
const MAX_ZOOM = 6;
// Zoom is continuous (zoomSnap 0) so the wheel and pinch land wherever they
// land; this is only the step the +/- buttons and the keyboard move by. Whole
// levels were too coarse a jump to frame a region with.
const ZOOM_DELTA = 0.25;
// Keep the hex layer generalized at world scale, then step into denser meshes
// as the user settles on regional views. Values match demscore.hex_mesh's
// precomputed 5km grid increments.
//
// Each size is half what it was under Web Mercator, which is what keeps the map
// at the density it had. A Mercator hexagon covered ground area proportional to
// cos^2(latitude), so the old mesh carried a surplus of hexagons towards the
// poles that the sizes were implicitly counting on; an Equal Earth hexagon
// covers the same area everywhere, and reaching the same count takes one about
// half the nominal size. The zoom thresholds are untouched because the CRS
// reuses Web Mercator's resolution ladder -- a zoom still means the same scale.
const HEX_RESOLUTION_STOPS = [
  { minZoom: 0, hexSizeM: 100000 },
  { minZoom: 2.75, hexSizeM: 60000 },
  { minZoom: 3.75, hexSizeM: 40000 },
  { minZoom: 4.75, hexSizeM: 25000 },
];

// Leaflet reports fractional zoom now, and "Zoom: 3.2500000000000004" is not a
// reading anyone wants.
function formatZoom(zoom) {
  return String(Math.round(zoom * 100) / 100);
}

// Variables range from shares in [0, 1] to GDP figures in the millions, and the
// legend has one narrow line to say where a class starts and ends, so the
// magnitude picks the form rather than a single fixed precision.
function formatLegendValue(value) {
  if (!Number.isFinite(value)) return "n/a";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e6) {
    return value.toLocaleString(undefined, { notation: "compact", maximumSignificantDigits: 3 });
  }
  if (magnitude > 0 && magnitude < 1e-3) {
    return value.toExponential(1);
  }
  const decimals = magnitude >= 100 ? 0 : magnitude >= 1 ? 2 : 3;
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatLegendRange(classBreak) {
  const low = formatLegendValue(classBreak?.min);
  const high = formatLegendValue(classBreak?.max);
  // A class can hold a single country, or several that share a value.
  return low === high ? low : `${low} \u2013 ${high}`;
}

function compileLegendMeaning(legendMeta) {
  const meaning = {
    defaults: {
      title: "Quantile class (country-year)",
      low: "Lower value",
      high: "Higher value",
      note: "Colors show relative rank for the selected year.",
      direction: "low-to-high",
    },
    datasetDefaults: legendMeta?.dataset_defaults || {},
    rules: Array.isArray(legendMeta?.rules)
      ? legendMeta.rules
          .map((rule) => {
            const compiled = { ...rule };
            if (typeof rule.match === "string" && rule.match.length > 0) {
              try {
                compiled._regex = new RegExp(rule.match);
              } catch (_) {
                compiled._regex = null;
              }
            } else {
              compiled._regex = null;
            }
            return compiled;
          })
          .filter((rule) => rule._regex)
      : [],
  };

  if (legendMeta?.defaults && typeof legendMeta.defaults === "object") {
    meaning.defaults = { ...meaning.defaults, ...legendMeta.defaults };
  }
  return meaning;
}

export class MapController extends BaseController {
  constructor({ state, meta, legendMeta, mapServerBase, metadataController, onLayerParamsChange }) {
    super();
    this.state = state;
    this.meta = meta;
    this.mapServerBase = mapServerBase;
    this.metadataController = metadataController;
    this.legendMeaning = compileLegendMeaning(legendMeta);
    this.onLayerParamsChange = typeof onLayerParamsChange === "function" ? onLayerParamsChange : () => {};
    this.areaOutlinesEnabled = readAreaOutlinesEnabled(AREA_OUTLINES_DEFAULT);

    this.loadingIndicator = this.getEl("loading-indicator");
    this.legendDock = this.getEl("mapLegendDock");
    this.legendTip = this.getEl("legendTooltip");
    this.legendTipClassEl = this.getEl("legendTooltipClass");
    this.legendTipRangeEl = this.getEl("legendTooltipRange");
    this.legendTipCountEl = this.getEl("legendTooltipCount");

    this.map = null;
    this.layerControl = null;
    this.hexLayerGroup = null;
    this.activeWmsLayer = null;
    this.pendingWmsLayer = null;
    this.pendingLayerOnReady = null;

    this.legend = null;
    this.legendTitleEl = null;
    this.legendSubtitleEl = null;
    this.legendBarEl = null;
    this.legendLowEl = null;
    this.legendHighEl = null;
    this.legendNoteEl = null;
    this.legendSwatchEls = [];

    // Keyed dataset|variable|year. A value of null is a remembered failure, so a
    // pointer resting on the bar does not retry the same request per swatch.
    this.classBreaksCache = new Map();
    this.classBreaksRequests = new Map();
    this.legendTipTimer = null;
    this.legendTipKey = null;

    this.loadingRevealTimer = null;
    this.demscoreBasemapPaneName = "demscoreBasemapPane";
    this.demscoreHexPaneName = "demscoreHexPane";
  }

  initialize() {
    const landmassBase = L.layerGroup([], {
      attribution: '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener noreferrer">Natural Earth</a>',
    });

    const crs = createEqualEarthCrs();

    this.map = L.map("mapCanvas", {
      crs,
      center: [20, 10],
      zoom: 2,
      // The floor is replaced by the measured world-fit zoom in
      // applyWorldFitMinZoom; this is only the limit that measurement may
      // return.
      minZoom: MIN_ZOOM_FLOOR,
      maxZoom: MAX_ZOOM,
      zoomSnap: 0,
      zoomDelta: ZOOM_DELTA,
      layers: [landmassBase],
      // maxBounds is set in applyPanBounds once the map has a size to measure;
      // it depends on both that and the zoom. Viscosity stays here because
      // Map.Drag reads the two together.
      maxBoundsViscosity: 1.0,
      worldCopyJump: false,
    });

    this.map.createPane(this.demscoreBasemapPaneName);
    const demscoreBasemapPane = this.map.getPane(this.demscoreBasemapPaneName);
    demscoreBasemapPane.style.zIndex = "100";
    demscoreBasemapPane.style.pointerEvents = "none";

    this.map.createPane(this.demscoreHexPaneName);
    const demscoreHexPane = this.map.getPane(this.demscoreHexPaneName);
    demscoreHexPane.style.zIndex = "350";
    demscoreHexPane.style.pointerEvents = "none";
    demscoreHexPane.classList.add("demscore-hex-pane");

    this.hexLayerGroup = L.layerGroup([]).addTo(this.map);
    this.activeWmsLayer = this.createWmsLayer();
    this.hexLayerGroup.addLayer(this.activeWmsLayer);

    this.layerControl = L.control.layers(
      {
        Landmasses: landmassBase,
      },
      {
        "Demscore Hex Layer": this.hexLayerGroup,
      },
      { collapsed: false, position: "bottomleft" },
    );
    this.layerControl.addTo(this.map);

    this.initializeLegend();
    this.installAreaOutlineToggle();
    this.installZoomIndicator();
    this.applyWorldFitMinZoom();
    this.applyPanBounds();
    this.loadLandmassBaseLayer(landmassBase);

    this.map.on("resize", () => {
      // A taller or wider window fits the world at a different zoom, so the
      // floor is re-measured rather than fixed once at startup.
      this.applyWorldFitMinZoom();
      this.applyPanBounds();
      this.rebalanceLegendPosition();
    });
    // How much ground half a window covers is what the pan limit is made of, so
    // it is remeasured whenever the zoom settles. Only on zoomend, not during:
    // setMaxBounds can pull the view back inside, and doing that mid-animation
    // fights the zoom.
    this.map.on("zoomend", () => this.applyPanBounds());
    window.addEventListener("resize", () => this.rebalanceLegendPosition());
  }

  // The zoom at which the whole world fits the window. Measured straight in
  // projected metres: getBoundsZoom would do it through a LatLngBounds, which
  // only describes this world when its corners are pushed past +/-180 (see
  // equalEarthPanBounds), and it clamps its answer to the map's current minimum
  // -- which is the value being computed. The coarsest resolution that still
  // fits the world in the window is handed back to the CRS's own ladder, so the
  // answer agrees with fractional zoom.
  applyWorldFitMinZoom() {
    const size = this.map.getSize();
    if (!size.x || !size.y) return;

    const world = equalEarthProjectedBounds().getSize();
    const fitResolution = Math.max(world.x / size.x, world.y / size.y);
    const worldFit = this.map.options.crs.zoom(1 / fitResolution);

    const nextMin = Math.min(Math.max(worldFit, MIN_ZOOM_FLOOR), MAX_ZOOM);
    if (!Number.isFinite(nextMin) || nextMin === this.map.getMinZoom()) return;
    this.map.setMinZoom(nextMin);
  }

  // Any point on the globe can be brought to the middle of the window, and no
  // further -- see equalEarthPanBounds, which also explains why the box cannot
  // be a plain lat/lon one. Leaflet keeps the whole viewport inside maxBounds,
  // so the box is the world grown by half a window, and half a window is worth
  // a different number of metres at every zoom and every window size. Setting
  // the option is enough to move every limit at once: Map.Drag rebuilds its own
  // from it at each dragstart, and _limitCenter reads it at each setView.
  applyPanBounds() {
    const size = this.map.getSize();
    if (!size.x || !size.y) return;

    this.map.setMaxBounds(
      equalEarthPanBounds(this.map.options.crs, size, this.map.getZoom()),
    );
  }

  getMap() {
    return this.map;
  }

  getContainer() {
    return this.map.getContainer();
  }

  async loadLandmassBaseLayer(layerGroup) {
    try {
      const response = await fetch("/api/basemap/land");
      if (!response.ok) {
        throw new Error(`Could not load land basemap: ${response.status}`);
      }
      const geojson = await response.json();
      const landLayer = L.geoJSON(geojson, {
        pane: this.demscoreBasemapPaneName,
        interactive: false,
        style: {
          color: LAND_BASEMAP_COLOR,
          fillColor: LAND_BASEMAP_COLOR,
          fillOpacity: 1,
          opacity: 1,
          stroke: true,
          weight: 1,
        },
      });
      layerGroup.addLayer(landLayer);
    } catch (error) {
      console.error(error);
    }
  }

  refresh() {
    this.metadataController.refreshVariableMetadataPanel();
    this.refreshLegend();
    this.loadNextLayer();
  }

  updateHexLayerForZoom() {
    const nextHexSize = String(this.hexSizeFromZoom());
    // A pending layer is what the map is about to show, so it -- not the layer
    // still on screen -- is what the new zoom has to agree with. Measuring
    // against the active layer restarted swaps that already carried the right
    // mesh, which during autoplay cost a frame every time.
    const incomingLayer = this.pendingWmsLayer || this.activeWmsLayer;
    const incomingHexSize = String(incomingLayer?.wmsParams?.hex_size ?? "");
    if (incomingHexSize === nextHexSize) return;

    this.loadNextLayer();
  }

  getVisibleTileCoords(layer = this.activeWmsLayer) {
    if (!this.map || !layer) return [];

    // Between whole zooms the grid keeps requesting one whole tile zoom and
    // scales what comes back, so the preload asks the grid which zoom and which
    // pixel bounds it is actually working in. Rounding the map's own fractional
    // zoom here would name tiles the map never asks for, and the preload marks
    // would then be reporting on the wrong tiles.
    const tileZoom = Number.isFinite(layer._tileZoom) ? layer._tileZoom : Math.round(this.map.getZoom());
    const tileSize = layer.getTileSize();
    const pixelBounds = typeof layer._getTiledPixelBounds === "function"
      ? layer._getTiledPixelBounds(this.map.getCenter())
      : this.map.getPixelBounds();
    // Same rounding as Leaflet's own _pxBoundsToTileRange, so the two agree on
    // the last row and column.
    const tileRange = L.bounds(
      pixelBounds.min.unscaleBy(tileSize).floor(),
      pixelBounds.max.unscaleBy(tileSize).ceil().subtract([1, 1]),
    );
    const coords = [];

    for (let y = tileRange.min.y; y <= tileRange.max.y; y += 1) {
      for (let x = tileRange.min.x; x <= tileRange.max.x; x += 1) {
        const point = new L.Point(x, y);
        point.z = tileZoom;
        if (typeof layer._isValidTile === "function" && !layer._isValidTile(point)) {
          continue;
        }
        coords.push(typeof layer._wrapCoords === "function" ? layer._wrapCoords(point) : point);
      }
    }

    return coords;
  }

  getVisibleWmsTileUrls(paramOverrides = {}) {
    const layer = this.activeWmsLayer;
    if (!layer || typeof layer.getTileUrl !== "function") return [];

    const originalParams = { ...layer.wmsParams };
    const originalKeys = new Set(Object.keys(originalParams));

    try {
      Object.assign(layer.wmsParams, paramOverrides);
      return [...new Set(this.getVisibleTileCoords(layer).map((coords) => layer.getTileUrl(coords)))];
    } finally {
      for (const key of Object.keys(layer.wmsParams)) {
        if (!originalKeys.has(key)) {
          delete layer.wmsParams[key];
        }
      }
      Object.assign(layer.wmsParams, originalParams);
    }
  }

  advanceAutoPlayLayer(onReady) {
    this.loadNextLayer(() => {
      if (typeof onReady === "function") {
        onReady();
      }
    });
  }

  stopPendingLayerSwap() {
    // Whatever was waiting on this swap is cancelled along with it. A reload that
    // means to keep the wait alive carries the continuation over itself first --
    // see loadNextLayer.
    this.pendingLayerOnReady = null;
    if (!this.pendingWmsLayer) return;
    this.pendingWmsLayer.off("load");
    this.hexLayerGroup.removeLayer(this.pendingWmsLayer);
    this.pendingWmsLayer = null;
    this.hideLoadingIndicator();
  }

  createWmsLayer() {
    return L.tileLayer.wms(this.mapServerBase, {
      layers: this.wmsLayerNames(),
      styles: "",
      format: "image/png",
      transparent: true,
      version: "1.1.1",
      dataset: this.state.dataset,
      variable: this.state.variable,
      polarity: this.metadataController.getActivePolarity(),
      year: String(this.state.year),
      hex_size: String(this.hexSizeFromZoom()),
      tileSize: 512,
      updateWhenIdle: true,
      updateInterval: 400,
      keepBuffer: 0,
      pane: this.demscoreHexPaneName,
      zIndex: 2,
      noWrap: true,
      // No bounds option: a LatLngBounds cannot describe the Equal Earth world,
      // and one built from the corners would mark every tile east of about 106E
      // invalid so the map would simply never request them. The CRS carries the
      // projected world box instead, which is what Leaflet builds its global
      // tile range from.
    });
  }

  wmsLayerNames() {
    return this.areaOutlinesEnabled ? `${HEX_FILL_LAYER},${HEX_OUTLINE_LAYER}` : HEX_FILL_LAYER;
  }

  getAreaOutlinesEnabled() {
    return this.areaOutlinesEnabled;
  }

  setAreaOutlinesEnabled(enabled) {
    const next = Boolean(enabled);
    if (next === this.areaOutlinesEnabled) return;

    this.areaOutlinesEnabled = next;
    writeAreaOutlinesEnabled(next);
    // The outlines ride along in the fill request, so switching them changes the
    // tile URL: the visible tiles are re-fetched and the preload marks, which
    // count tiles under the old URL, no longer describe what is cached.
    this.loadNextLayer();
    this.onLayerParamsChange();
  }

  installAreaOutlineToggle() {
    const control = L.control({ position: "bottomleft" });
    control.onAdd = () => {
      const div = L.DomUtil.create("div", "map-display-options");
      div.innerHTML = `
        <label class="map-display-option">
          <input id="areaOutlineToggle" type="checkbox" />
          <span>Outline equal-colour areas</span>
        </label>`;
      const checkbox = div.querySelector("#areaOutlineToggle");
      checkbox.checked = this.areaOutlinesEnabled;
      checkbox.addEventListener("change", () => this.setAreaOutlinesEnabled(checkbox.checked));
      // The control sits over the map, so a click on it must not also pan or
      // zoom the map underneath.
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      return div;
    };
    control.addTo(this.map);
  }

  hexSizeFromZoom() {
    const zoom = this.map ? this.map.getZoom() : 0;
    let hexSize = HEX_RESOLUTION_STOPS[0].hexSizeM;

    for (const stop of HEX_RESOLUTION_STOPS) {
      if (zoom >= stop.minZoom) {
        hexSize = stop.hexSizeM;
      }
    }

    return hexSize;
  }

  showLoadingIndicator() {
    if (this.loadingRevealTimer !== null) {
      window.clearTimeout(this.loadingRevealTimer);
    }
    this.loadingRevealTimer = window.setTimeout(() => {
      this.loadingRevealTimer = null;
      this.loadingIndicator.classList.add("is-loading");
    }, 500);
  }

  hideLoadingIndicator() {
    if (this.loadingRevealTimer !== null) {
      window.clearTimeout(this.loadingRevealTimer);
      this.loadingRevealTimer = null;
    }
    this.loadingIndicator.classList.remove("is-loading");
  }

  loadNextLayer(onReady) {
    // A reload can land while a swap is still in flight -- a zoom crossing a hex
    // resolution stop mid-autoplay is the usual way. The superseded layer's
    // continuation moves onto the new layer instead of dying with it: autoplay
    // schedules its next year from that callback, so dropping it froze the
    // timeline while the button still read "Pause".
    const carriedOnReady = this.pendingLayerOnReady;
    this.stopPendingLayerSwap();
    const readyCallback = typeof onReady === "function" ? onReady : carriedOnReady;

    const nextLayer = this.createWmsLayer();
    this.hexLayerGroup.addLayer(nextLayer);
    nextLayer.setOpacity(0);
    this.pendingWmsLayer = nextLayer;
    this.pendingLayerOnReady = readyCallback;

    this.showLoadingIndicator();
    nextLayer.once("load", () => {
      if (this.pendingWmsLayer !== nextLayer) return;
      nextLayer.setOpacity(1);
      this.hexLayerGroup.removeLayer(this.activeWmsLayer);
      this.activeWmsLayer = nextLayer;
      this.pendingWmsLayer = null;
      this.pendingLayerOnReady = null;
      this.hideLoadingIndicator();
      if (readyCallback) readyCallback();
    });
  }

  resolveLegendMeaning(dataset, variable) {
    const merged = {
      ...this.legendMeaning.defaults,
      ...(this.legendMeaning.datasetDefaults?.[dataset] || {}),
    };

    const matchingRule = this.legendMeaning.rules.find((rule) => {
      const datasetMatch = !rule.dataset || rule.dataset === dataset;
      return datasetMatch && rule._regex && rule._regex.test(variable);
    });

    return matchingRule ? { ...merged, ...matchingRule } : merged;
  }

  initializeLegend() {
    const div = document.createElement("div");
    div.className = "map-legend";
    div.innerHTML = `
      <div class="legend-copy">
        <div class="legend-title"></div>
        <div class="legend-subtitle"></div>
      </div>
      <div class="legend-scale">
        <div class="legend-bar"></div>
        <div class="legend-labels"><span></span><span></span></div>
        <div class="legend-note"></div>
      </div>`;

    this.legendTitleEl = div.querySelector(".legend-title");
    this.legendSubtitleEl = div.querySelector(".legend-subtitle");
    this.legendBarEl = div.querySelector(".legend-bar");
    this.legendLowEl = div.querySelector(".legend-labels span:first-child");
    this.legendHighEl = div.querySelector(".legend-labels span:last-child");
    this.legendNoteEl = div.querySelector(".legend-note");
    this.legendDock.append(div);
    this.legend = div;

    // The swatches are built once and only recoloured afterwards: rebuilding the
    // bar per refresh would drop the focus and the hover the tooltip hangs off.
    this.legendBarEl.innerHTML = Array.from({ length: LEGEND_CLASS_COUNT }, (_, index) =>
      `<span class="legend-swatch" data-class-index="${index + 1}" role="img" tabindex="0"></span>`)
      .join("");
    this.legendSwatchEls = Array.from(this.legendBarEl.querySelectorAll(".legend-swatch"));
    this.bindLegendTooltip();
  }

  bindLegendTooltip() {
    this.legendBarEl.addEventListener("pointerover", (event) => {
      // Touch and pen have no hover to rest on, and the bar is not a control.
      if (event.pointerType && event.pointerType !== "mouse") return;
      const swatch = event.target.closest(".legend-swatch");
      if (!swatch) return;
      this.scheduleLegendTip(swatch);
    });
    this.legendBarEl.addEventListener("pointerleave", () => this.hideLegendTip());

    // Keyboard reaches the same numbers: each swatch is a tab stop.
    this.legendBarEl.addEventListener("focusin", (event) => {
      const swatch = event.target.closest(".legend-swatch");
      if (swatch) void this.showLegendTip(swatch);
    });
    this.legendBarEl.addEventListener("focusout", () => this.hideLegendTip());

    // The card is placed in viewport coordinates, so anything that moves the bar
    // under it drops it rather than leaving it pointing at nothing.
    window.addEventListener("resize", () => this.hideLegendTip());
    document.addEventListener("scroll", () => this.hideLegendTip(), true);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.hideLegendTip();
    });
  }

  scheduleLegendTip(swatch) {
    const key = `${this.classBreaksKey()}#${swatch.dataset.classIndex}`;
    if (key === this.legendTipKey) return;
    this.hideLegendTip();
    this.legendTipKey = key;
    this.legendTipTimer = window.setTimeout(() => {
      void this.showLegendTip(swatch);
    }, LEGEND_TIP_HOVER_DELAY_MS);
  }

  async showLegendTip(swatch) {
    const breaksKey = this.classBreaksKey();
    const classIndex = Number.parseInt(swatch.dataset.classIndex, 10);
    if (!Number.isInteger(classIndex)) return;

    const tipKey = `${breaksKey}#${classIndex}`;
    this.legendTipKey = tipKey;

    let classes = this.classBreaksCache.get(breaksKey);
    if (classes === undefined) {
      // Show the class straight away and let the numbers arrive; the first hover
      // on a year is the only one that waits, the rest are served from cache.
      this.renderLegendTip(classIndex, undefined);
      this.placeLegendTip(swatch);
      classes = await this.ensureClassBreaks(breaksKey);
      // The pointer may have left the bar, or the year moved on, while we waited.
      if (this.legendTipKey !== tipKey) return;
    }

    this.renderLegendTip(classIndex, classes);
    this.placeLegendTip(swatch);
  }

  hideLegendTip() {
    window.clearTimeout(this.legendTipTimer);
    this.legendTipTimer = null;
    this.legendTipKey = null;
    this.legendTip.hidden = true;
  }

  renderLegendTip(classIndex, classes) {
    const classBreak = this.findClassBreak(classes, classIndex);
    this.legendTipClassEl.textContent = `Class ${classIndex} of ${LEGEND_CLASS_COUNT}`;

    if (classes === undefined) {
      this.legendTipRangeEl.textContent = "Loading\u2026";
      this.legendTipCountEl.hidden = true;
    } else if (!classBreak) {
      // Either the lookup failed or the year holds no country values to class.
      this.legendTipRangeEl.textContent = "Value span unavailable";
      this.legendTipCountEl.hidden = true;
    } else {
      this.legendTipRangeEl.textContent = formatLegendRange(classBreak);
      const count = classBreak.countryCount;
      this.legendTipCountEl.textContent = count === 1 ? "1 country" : `${count} countries`;
      this.legendTipCountEl.hidden = !Number.isFinite(count);
    }

    this.legendTip.hidden = false;
  }

  placeLegendTip(swatch) {
    const anchor = swatch.getBoundingClientRect();
    const card = this.legendTip;
    const { offsetWidth: width, offsetHeight: height } = card;

    // The legend sits at the foot of the map, so the card goes above the bar and
    // only flips below when the dock has been pushed up against the top.
    const spaceAbove = anchor.top - LEGEND_TIP_GAP_PX - LEGEND_TIP_VIEWPORT_MARGIN_PX;
    const placeBelow = spaceAbove < height;
    card.classList.toggle("is-below", placeBelow);

    const top = placeBelow ? anchor.bottom + LEGEND_TIP_GAP_PX : anchor.top - LEGEND_TIP_GAP_PX - height;
    const anchorCenter = anchor.left + anchor.width / 2;
    const maxLeft = window.innerWidth - width - LEGEND_TIP_VIEWPORT_MARGIN_PX;
    const left = Math.min(
      Math.max(anchorCenter - width / 2, LEGEND_TIP_VIEWPORT_MARGIN_PX),
      Math.max(maxLeft, LEGEND_TIP_VIEWPORT_MARGIN_PX),
    );

    card.style.left = `${left}px`;
    card.style.top = `${Math.max(top, LEGEND_TIP_VIEWPORT_MARGIN_PX)}px`;
    // Keep the arrow on the hovered swatch even where the card is clamped.
    const arrowLeft = Math.min(Math.max(anchorCenter - left, LEGEND_TIP_ARROW_INSET_PX), width - LEGEND_TIP_ARROW_INSET_PX);
    card.style.setProperty("--arrow-left", `${arrowLeft}px`);
  }

  classBreaksKey(dataset = this.state.dataset, variable = this.state.variable, year = this.state.year) {
    return `${dataset}|${variable}|${year}`;
  }

  findClassBreak(classes, classIndex) {
    if (!Array.isArray(classes)) return null;
    return classes.find((entry) => entry.classIndex === classIndex) || null;
  }

  // The map colours by quantile, which says nothing about where a class starts
  // and ends; these are those edges, from the same country_scores() call the WMS
  // layer classes on.
  ensureClassBreaks(key) {
    if (this.classBreaksCache.has(key)) return Promise.resolve(this.classBreaksCache.get(key));
    const inFlight = this.classBreaksRequests.get(key);
    if (inFlight) return inFlight;

    const [dataset, variable, year] = key.split("|");
    const query = new URLSearchParams({ dataset, variable, year });
    const request = fetch(`/api/class-breaks?${query}`)
      .then((response) => {
        if (!response.ok) throw new Error(`Could not load class breaks: ${response.status}`);
        return response.json();
      })
      .then((payload) => (Array.isArray(payload?.classes) ? payload.classes : []))
      .catch((error) => {
        console.error(error);
        return null;
      })
      .then((classes) => {
        this.rememberClassBreaks(key, classes);
        return classes;
      })
      .finally(() => this.classBreaksRequests.delete(key));

    this.classBreaksRequests.set(key, request);
    return request;
  }

  rememberClassBreaks(key, classes) {
    this.classBreaksCache.set(key, classes);
    // Map iterates in insertion order, so the oldest entry is the first one out.
    while (this.classBreaksCache.size > CLASS_BREAKS_CACHE_LIMIT) {
      const oldestKey = this.classBreaksCache.keys().next().value;
      this.classBreaksCache.delete(oldestKey);
    }
  }

  refreshLegend() {
    const text = this.resolveLegendMeaning(this.state.dataset, this.state.variable);
    const variableTitle = this.metadataController.getVariableTitle(this.state.dataset, this.state.variable);
    const datasetMeta = this.meta.datasets[this.state.dataset];
    const datasetTitle = datasetMeta?.title || datasetMeta?.label || this.state.dataset;
    const polarity = this.metadataController.getActivePolarity();
    const legendColors = this.legendColorsForPolarity(polarity);

    if (this.legendTitleEl) this.legendTitleEl.textContent = text.title;
    if (this.legendSubtitleEl) {
      this.legendSubtitleEl.textContent = `${variableTitle} (${this.state.variable}) - ${datasetTitle}, ${this.state.year}`;
    }
    // Swatch i always stands for quantile class i + 1, low to high: the mapfile
    // reorders the classes per polarity, and reversing the colours here is what
    // keeps the bar reading left-to-right low-to-high whichever way it does.
    this.legendSwatchEls.forEach((swatch, index) => {
      swatch.style.background = legendColors[index];
      swatch.setAttribute("aria-label", `Quantile class ${index + 1} of ${LEGEND_CLASS_COUNT}`);
    });
    if (this.legendLowEl) this.legendLowEl.textContent = text.low;
    if (this.legendHighEl) this.legendHighEl.textContent = text.high;
    if (this.legendNoteEl) {
      const directionHint = this.legendDirectionHint(polarity);
      this.legendNoteEl.textContent = `${text.note} ${directionHint}`;
    }

    // The card on screen belongs to the variable-year that just left.
    this.hideLegendTip();
    // Autoplay walks a year per frame-ish; its breaks would be stale before
    // anyone could hover them, so those are fetched on hover instead.
    if (!this.state.isAutoPlaying) {
      void this.ensureClassBreaks(this.classBreaksKey());
    }

    window.requestAnimationFrame(() => this.rebalanceLegendPosition());
  }

  legendColorsForPolarity(polarity) {
    if (polarity === POLARITY_NEUTRAL) return LEGEND_COLORS_NEUTRAL;
    return polarity === POLARITY_POSITIVE ? LEGEND_COLORS_NEGATIVE.slice().reverse() : LEGEND_COLORS_NEGATIVE;
  }

  legendDirectionHint(polarity) {
    if (polarity === POLARITY_NEUTRAL) return "Higher values are mapped to darker green tones.";
    return polarity === POLARITY_POSITIVE
      ? "Higher values are mapped to blue tones."
      : "Higher values are mapped to red tones.";
  }

  rebalanceLegendPosition() {
    this.map?.invalidateSize({ pan: false });
  }

  installZoomIndicator() {
    const zoomControl = L.control({ position: "bottomleft" });
    zoomControl.onAdd = () => {
      const div = L.DomUtil.create("div", "zoom-display");
      div.textContent = `Zoom: ${formatZoom(this.map.getZoom())}`;
      return div;
    };
    zoomControl.addTo(this.map);

    // The reading follows a continuous zoom while it moves, not only where it
    // stops; the layer only needs to hear about it once it has stopped.
    this.map.on("zoom zoomlevelschange", () => {
      zoomControl.getContainer().textContent = `Zoom: ${formatZoom(this.map.getZoom())}`;
    });
    this.map.on("zoomend", () => {
      this.updateHexLayerForZoom();
    });
  }
}

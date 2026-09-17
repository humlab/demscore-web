import { BaseController } from "../core/BaseController.js";
import { readAreaOutlinesEnabled, writeAreaOutlinesEnabled } from "../core/preferences.js";

const POLARITY_POSITIVE = "positive";
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
const LEGEND_COLORS_NEGATIVE = ["#313695", "#4575b4", "#74add1", "#abd9e9", "#fdae61", "#f46d43", "#d73027"];
// The map reads as one world, so it never zooms out past the point where that
// world fills the window — the real floor is measured per window size in
// applyWorldFitMinZoom, and this is only the absolute limit that measurement is
// allowed to return.
const WORLD_BOUNDS = [
  [-85, -180],
  [85, 180],
];
const MIN_ZOOM_FLOOR = 0;
const MAX_ZOOM = 6;
// Zoom is continuous (zoomSnap 0) so the wheel and pinch land wherever they
// land; this is only the step the +/- buttons and the keyboard move by. Whole
// levels were too coarse a jump to frame a region with.
const ZOOM_DELTA = 0.25;
// Keep the hex layer generalized at world scale, then step into denser meshes
// as the user settles on regional views. Values match demscore.hex_mesh's
// precomputed 10km grid increments.
const HEX_RESOLUTION_STOPS = [
  { minZoom: 0, hexSizeM: 200000 },
  { minZoom: 2.75, hexSizeM: 120000 },
  { minZoom: 3.75, hexSizeM: 80000 },
  { minZoom: 4.75, hexSizeM: 50000 },
];

// Leaflet reports fractional zoom now, and "Zoom: 3.2500000000000004" is not a
// reading anyone wants.
function formatZoom(zoom) {
  return String(Math.round(zoom * 100) / 100);
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

    this.map = null;
    this.layerControl = null;
    this.hexLayerGroup = null;
    this.activeWmsLayer = null;
    this.pendingWmsLayer = null;

    this.legend = null;
    this.legendTitleEl = null;
    this.legendSubtitleEl = null;
    this.legendBarEl = null;
    this.legendLowEl = null;
    this.legendHighEl = null;
    this.legendNoteEl = null;

    this.loadingRevealTimer = null;
    this.demscoreBasemapPaneName = "demscoreBasemapPane";
    this.demscoreHexPaneName = "demscoreHexPane";
  }

  initialize() {
    const landmassBase = L.layerGroup([], {
      attribution: '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener noreferrer">Natural Earth</a>',
    });

    this.map = L.map("mapCanvas", {
      center: [20, 10],
      zoom: 2,
      // The floor is replaced by the measured world-fit zoom below; it starts
      // open because getBoundsZoom clamps its answer to the map's current min.
      minZoom: MIN_ZOOM_FLOOR,
      maxZoom: MAX_ZOOM,
      zoomSnap: 0,
      zoomDelta: ZOOM_DELTA,
      layers: [landmassBase],
      maxBounds: WORLD_BOUNDS,
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
    this.loadLandmassBaseLayer(landmassBase);

    this.map.on("resize", () => {
      // A taller or wider window fits the world at a different zoom, so the
      // floor is re-measured rather than fixed once at startup.
      this.applyWorldFitMinZoom();
      this.rebalanceLegendPosition();
    });
    window.addEventListener("resize", () => this.rebalanceLegendPosition());
  }

  // The zoom at which the whole world fits the window. Leaflet clamps
  // getBoundsZoom to the map's current minimum, so the floor comes off for the
  // measurement — otherwise a window that shrinks could never zoom back out far
  // enough to see the world it was showing a moment ago.
  applyWorldFitMinZoom() {
    const previousMin = this.map.options.minZoom;
    this.map.options.minZoom = MIN_ZOOM_FLOOR;
    const worldFit = this.map.getBoundsZoom(L.latLngBounds(WORLD_BOUNDS), false);
    this.map.options.minZoom = previousMin;

    const nextMin = Math.min(Math.max(worldFit, MIN_ZOOM_FLOOR), MAX_ZOOM);
    if (!Number.isFinite(nextMin) || nextMin === this.map.getMinZoom()) return;
    this.map.setMinZoom(nextMin);
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
    const activeHexSize = String(this.activeWmsLayer.wmsParams?.hex_size ?? "");
    if (activeHexSize === nextHexSize) return;

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
      bounds: L.latLngBounds(WORLD_BOUNDS),
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
    this.stopPendingLayerSwap();

    const nextLayer = this.createWmsLayer();
    this.hexLayerGroup.addLayer(nextLayer);
    nextLayer.setOpacity(0);
    this.pendingWmsLayer = nextLayer;

    this.showLoadingIndicator();
    nextLayer.once("load", () => {
      if (this.pendingWmsLayer !== nextLayer) return;
      nextLayer.setOpacity(1);
      this.hexLayerGroup.removeLayer(this.activeWmsLayer);
      this.activeWmsLayer = nextLayer;
      this.pendingWmsLayer = null;
      this.hideLoadingIndicator();
      if (onReady) onReady();
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
  }

  refreshLegend() {
    const text = this.resolveLegendMeaning(this.state.dataset, this.state.variable);
    const variableTitle = this.metadataController.getVariableTitle(this.state.dataset, this.state.variable);
    const datasetMeta = this.meta.datasets[this.state.dataset];
    const datasetTitle = datasetMeta?.title || datasetMeta?.label || this.state.dataset;
    const polarity = this.metadataController.getActivePolarity();
    const legendColors =
      polarity === POLARITY_POSITIVE ? LEGEND_COLORS_NEGATIVE.slice().reverse() : LEGEND_COLORS_NEGATIVE;

    if (this.legendTitleEl) this.legendTitleEl.textContent = text.title;
    if (this.legendSubtitleEl) {
      this.legendSubtitleEl.textContent = `${variableTitle} (${this.state.variable}) - ${datasetTitle}, ${this.state.year}`;
    }
    if (this.legendBarEl) {
      this.legendBarEl.innerHTML = legendColors
        .map((color) => `<span class="legend-swatch" style="background:${color}"></span>`)
        .join("");
    }
    if (this.legendLowEl) this.legendLowEl.textContent = text.low;
    if (this.legendHighEl) this.legendHighEl.textContent = text.high;
    if (this.legendNoteEl) {
      const directionHint =
        polarity === POLARITY_POSITIVE
          ? "Higher values are mapped to blue tones."
          : "Higher values are mapped to red tones.";
      this.legendNoteEl.textContent = `${text.note} ${directionHint}`;
    }

    window.requestAnimationFrame(() => this.rebalanceLegendPosition());
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

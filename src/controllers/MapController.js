import { BaseController } from "../core/BaseController.js";

const POLARITY_POSITIVE = "positive";
const LEGEND_COLORS_NEGATIVE = ["#313695", "#4575b4", "#74add1", "#abd9e9", "#fdae61", "#f46d43", "#d73027"];

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
  constructor({ state, meta, legendMeta, mapServerBase, metadataController }) {
    super();
    this.state = state;
    this.meta = meta;
    this.mapServerBase = mapServerBase;
    this.metadataController = metadataController;
    this.legendMeaning = compileLegendMeaning(legendMeta);

    this.loadingIndicator = this.getEl("loading-indicator");

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
    this.demscoreHexPaneName = "demscoreHexPane";
  }

  initialize() {
    const osm = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
      maxZoom: 20,
      subdomains: "abcd",
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    });

    const stamenTerrain = L.tileLayer(
      "https://tiles.stadiamaps.com/tiles/stamen_terrain_background/{z}/{x}/{y}{r}.png",
      {
        maxZoom: 18,
        attribution:
          "&copy; <a href=\"https://stadiamaps.com/\" target=\"_blank\" rel=\"noopener noreferrer\">Stadia Maps</a> " +
          "&copy; <a href=\"https://stamen.com/\" target=\"_blank\" rel=\"noopener noreferrer\">Stamen Design</a> " +
          "&copy; <a href=\"https://openmaptiles.org/\" target=\"_blank\" rel=\"noopener noreferrer\">OpenMapTiles</a> " +
          "&copy; OpenStreetMap contributors",
      },
    );

    const esriWorldImagery = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      {
        maxZoom: 19,
        attribution: "Tiles &copy; Esri",
      },
    );

    this.map = L.map("map", {
      center: [20, 10],
      zoom: 2,
      minZoom: 1,
      maxZoom: 4,
      layers: [osm],
      maxBounds: [
        [-85, -180],
        [85, 180],
      ],
      maxBoundsViscosity: 1.0,
      worldCopyJump: false,
    });

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
        "Stamen Terrain": stamenTerrain,
        "OpenStreetMap": osm,
        "Esri World Imagery": esriWorldImagery,
      },
      {
        "Demscore Hex Layer": this.hexLayerGroup,
      },
      { collapsed: false, position: "bottomleft" },
    );
    this.layerControl.addTo(this.map);

    this.initializeLegend();
    this.installZoomIndicator();

    this.map.on("resize", () => this.rebalanceLegendPosition());
    window.addEventListener("resize", () => this.rebalanceLegendPosition());
  }

  getMap() {
    return this.map;
  }

  getContainer() {
    return this.map.getContainer();
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

    this.activeWmsLayer.setParams({ hex_size: nextHexSize });
    if (this.pendingWmsLayer) {
      this.pendingWmsLayer.setParams({ hex_size: nextHexSize });
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
      layers: "hex_variable",
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
      bounds: L.latLngBounds([-85, -180], [85, 180]),
    });
  }

  hexSizeFromZoom() {
    const zoom = this.map.getZoom();
    if (zoom <= 2) return 200000;
    if (zoom <= 3) return 200000;
    return 200000;
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
    this.legend = L.control({ position: "bottomright" });

    this.legend.onAdd = () => {
      const div = L.DomUtil.create("div", "map-legend");
      div.innerHTML = `
        <div class="legend-title"></div>
        <div class="legend-subtitle"></div>
        <div class="legend-bar"></div>
        <div class="legend-labels"><span></span><span></span></div>
        <div class="legend-note"></div>`;

      this.legendTitleEl = div.querySelector(".legend-title");
      this.legendSubtitleEl = div.querySelector(".legend-subtitle");
      this.legendBarEl = div.querySelector(".legend-bar");
      this.legendLowEl = div.querySelector(".legend-labels span:first-child");
      this.legendHighEl = div.querySelector(".legend-labels span:last-child");
      this.legendNoteEl = div.querySelector(".legend-note");
      return div;
    };

    this.legend.addTo(this.map);
  }

  refreshLegend() {
    const text = this.resolveLegendMeaning(this.state.dataset, this.state.variable);
    const variableTitle = this.metadataController.getVariableTitle(this.state.dataset, this.state.variable);
    const datasetLabel = this.meta.datasets[this.state.dataset]?.label || this.state.dataset;
    const polarity = this.metadataController.getActivePolarity();
    const legendColors =
      polarity === POLARITY_POSITIVE ? LEGEND_COLORS_NEGATIVE.slice().reverse() : LEGEND_COLORS_NEGATIVE;

    if (this.legendTitleEl) this.legendTitleEl.textContent = text.title;
    if (this.legendSubtitleEl) {
      this.legendSubtitleEl.textContent = `${variableTitle} (${this.state.variable}) - ${datasetLabel}, ${this.state.year}`;
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

  rectsOverlap(a, b, gap = 0) {
    return !(
      a.right + gap <= b.left ||
      a.left >= b.right + gap ||
      a.bottom + gap <= b.top ||
      a.top >= b.bottom + gap
    );
  }

  rebalanceLegendPosition() {
    const legendEl = this.legend.getContainer();
    const layersEl = this.layerControl.getContainer();
    if (!legendEl || !layersEl) return;

    legendEl.style.marginBottom = "";

    const legendRect = legendEl.getBoundingClientRect();
    const layersRect = layersEl.getBoundingClientRect();
    const overlaps = this.rectsOverlap(legendRect, layersRect, 8);
    if (!overlaps) return;

    legendEl.style.marginBottom = `${Math.ceil(layersRect.height + 12)}px`;
  }

  installZoomIndicator() {
    const zoomControl = L.control({ position: "bottomleft" });
    zoomControl.onAdd = () => {
      const div = L.DomUtil.create("div", "zoom-display");
      div.textContent = `Zoom: ${this.map.getZoom()}`;
      return div;
    };
    zoomControl.addTo(this.map);

    this.map.on("zoomend", () => {
      zoomControl.getContainer().textContent = `Zoom: ${this.map.getZoom()}`;
      this.updateHexLayerForZoom();
    });
  }
}

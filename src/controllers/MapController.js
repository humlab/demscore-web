import { BaseController } from "../core/BaseController.js";
import { refreshIcons } from "../core/icons.js";
import { ol } from "../core/openlayers.js";
import {
  readAreaOutlinesEnabled,
  readMapPalette,
  readMapProjection,
  writeAreaOutlinesEnabled,
  writeMapPalette,
  writeMapProjection,
} from "../core/preferences.js";
import {
  CLASS_COUNT,
  DEFAULT_PALETTE_KEY,
  MAP_PALETTES,
  NO_DATA_COLOR,
  PALETTE_KEYS,
  SERVER_DEFAULT_PALETTE_KEY,
  legendColorsFor,
  paletteDescriptionFor,
  paletteLabelFor,
} from "../core/palettes.js";
import { ATTRIBUTION_OPEN_ATTR, buildAttributionHtml } from "../core/attribution.js";
import {
  DEFAULT_PROJECTION_KEY,
  PROJECTION_KEYS,
  getMapProjection,
  resolutionForZoom,
  transferCenter,
  worldFitResolution,
  zoomForResolution,
} from "../core/projection.js";

// Polarity no longer branches here: which colours a polarity takes is a
// question for core/palettes.js, which is also what generates the mapfile side
// of the same answer.
const LAND_BASEMAP_COLOR = "#fffaf0";
// Adjacent quantile classes can be a shade apart, which is the whole reason the
// outlines exist, so they start on and the toggle is there to take them off.
const AREA_OUTLINES_DEFAULT = true;
// demscore.country_scores() is what both the map and the legend are built on,
// so the swatch count is not a styling choice. It comes from core/palettes.js
// because every ramp there is cut to the same number.
const LEGEND_CLASS_COUNT = CLASS_COUNT;
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

// The third choice in the View switch, beside the two projections. It is not a
// projection and never reaches `setProjection`; it is here because the three are
// one question -- how to show this year -- and a reader who wants the numbers
// rather than the picture is making the same choice as one who wants equal area
// rather than equal angle. DemscoreApp owns what it does; this file owns the
// control that asks for it.
const TABLE_VIEW_KEY = "table";
const VIEW_CHOICE_KEYS = [...PROJECTION_KEYS, TABLE_VIEW_KEY];
const VIEW_CHOICE_ICONS = {
  equalEarth: "globe-2",
  webMercator: "map",
  [TABLE_VIEW_KEY]: "table",
};
const TABLE_VIEW_TITLE = "This year as a sortable table of countries, instead of the map";

const MIN_ZOOM_FLOOR = 0;
// Clear space kept between the fitted world and the panels floating over the
// map, so the northernmost and southernmost hexagons are not drawn flush
// against them.
const WORLD_FIT_GUTTER_PX = 8;
// However tall the panels get on a short window, the world is fitted to at
// least this share of the map's height; past that, it is the panels' turn to
// stand on it, and the reader can pan.
const WORLD_FIT_MIN_HEIGHT_SHARE = 0.5;
const MAX_ZOOM = 6;
const INITIAL_CENTER_LON_LAT = [10, 20];
const INITIAL_ZOOM = 2;
// The land sits under the hexagons and neither takes a click; the numbers are
// the pane z-indexes the Leaflet version used, kept so the order is readable
// against the rest of the stack.
const BASEMAP_Z_INDEX = 100;
const HEX_Z_INDEX = 350;
// A swap lands when the year's tiles are on the map. The map's own rendercomplete
// is the best reading of that, but it is a map-wide one: it waits on every tile
// queued anywhere -- including the ones left behind by years autoplay has already
// walked past -- and on the browser settling every request, which a tile fetch
// hitting a MapServer busy with the preloader's own reads may take a very long
// time to do, or never do at all. Autoplay schedules its next year from that
// signal, so a swap that never lands stops the timeline dead, which is what
// "Animate stops after one year while the tiles are still coming in" was. The
// pending layer's own tiles reporting back is therefore a second way to land,
// and a deadline is the third.
//
// The quiet window is there because tiles are queued in batches: the counters
// touch zero between two batches of the same layer, and a moment with nothing
// starting is what tells that seam from the end of the layer.
const PENDING_LAYER_QUIET_MS = 120;
// How long a layer that has begun arriving is given to carry on arriving. A slow
// MapServer resets this with every tile it answers, so a genuinely slow year is
// waited for; a year with a tile that is not coming back is shown as far as it
// got, and the missing tiles paint in behind it once the layer is the live one.
const PENDING_LAYER_STALL_MS = 3000;
// A cap on the whole wait once a layer has begun arriving, where the stall timer
// above caps only the gap between two arrivals. A layer being fed a tile at a
// time -- which is what a swap competing with the read-ahead for the connection
// pool looks like -- resets the stall timer forever and never trips it, so
// without this the only thing left to land the swap is the deadline: ten seconds
// of a blank map, and then the whole year at once. Past this the year is shown
// as far as it got and the rest paints in behind it, which is what the stall
// timer already does for the year that stops arriving.
const PENDING_LAYER_REVEAL_MS = 2000;
// The ceiling for a layer that has not answered at all, where there is no
// arrival rate to judge it by and nothing to show even if it is given up on.
// Only this case reaches it now: one tile back arms the reveal cap above.
const PENDING_LAYER_DEADLINE_MS = 10000;
// Which way the tile grid rounds a continuous resolution to a discrete tile
// resolution. Zero means nearest, which is what ol/layer/Tile asks for by
// default -- and the preload has to ask the same question, or it names tiles the
// map never wants.
const TILE_Z_DIRECTION = 0;
// Zoom is continuous, so the wheel and pinch land wherever they land; this is
// only the step the +/- buttons and the keyboard move by. Whole levels were too
// coarse a jump to frame a region with.
const ZOOM_DELTA = 0.25;
const ZOOM_DURATION_MS = 250;
// How long a swap has to be taking before it is worth showing, and the longer
// fuse before it is worth *saying*. See showLoadingIndicator.
const LOADING_SPINNER_REVEAL_MS = 500;
const LOADING_ANNOUNCE_MS = 1500;
// How much larger than the world on screen a downloaded frame is fitted to; see
// getExportView.
const EXPORT_FIT_MARGIN = 1.03;
// Zoom is continuous, and "Zoom: 3.2500000000000004" is not a reading anyone
// wants.
function formatZoom(zoom) {
  return String(Math.round(zoom * 100) / 100);
}

// Variables range from shares in [0, 1] to GDP figures in the millions, and the
// legend has one narrow line to say where a class starts and ends, so the
// magnitude picks the form rather than a single fixed precision.
export function formatLegendValue(value) {
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

// The same span written for a reader rather than for a narrow line. An en dash
// is a dash on screen and anything from "en dash" to silence in a screen
// reader, so the word is spelled out where the text is only ever spoken.
export function speakLegendRange(classBreak) {
  const low = formatLegendValue(classBreak?.min);
  const high = formatLegendValue(classBreak?.max);
  return low === high ? low : `${low} to ${high}`;
}

export function speakCountryCount(count) {
  if (!Number.isFinite(count)) return "";
  return count === 1 ? "1 country" : `${count} countries`;
}

function compileLegendMeaning(legendMeta) {
  const meaning = {
    defaults: {
      title: "Quantile class (country-year)",
      low: "Lower value",
      high: "Higher value",
      note: "Colours show relative rank for the selected year.",
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
  constructor({
    state,
    meta,
    legendMeta,
    attributionMeta,
    mapServerBase,
    metadataController,
    onLayerParamsChange,
    onStateChange,
    onOpenAttribution,
    onViewChange,
  }) {
    super();
    this.state = state;
    this.meta = meta;
    this.mapServerBase = mapServerBase;
    this.metadataController = metadataController;
    this.legendMeaning = compileLegendMeaning(legendMeta);
    // Built once, here, rather than per layer: createWmsLayer() runs on every
    // projection, palette, year and outline change, and an attribution assembled
    // per call is an attribution that can come out different per call.
    this.attributionHtml = buildAttributionHtml(attributionMeta);
    this.onOpenAttribution = typeof onOpenAttribution === "function" ? onOpenAttribution : () => {};
    this.onLayerParamsChange = typeof onLayerParamsChange === "function" ? onLayerParamsChange : () => {};
    // Fired from refreshLegend, which is the one place every change of what the
    // map is showing passes through. MapDataController hangs the spoken summary
    // off it.
    this.onStateChange = typeof onStateChange === "function" ? onStateChange : () => {};
    // The View switch picks a projection or the table; the table half is not
    // this controller's to act on, so it is handed back to DemscoreApp, which
    // owns `state.view`. The switch still reads `state.view` directly for its
    // own selected state -- one radiogroup cannot have its answer in two places.
    this.onViewChange = typeof onViewChange === "function" ? onViewChange : () => {};
    this.areaOutlinesEnabled = readAreaOutlinesEnabled(AREA_OUTLINES_DEFAULT);
    // Whether the map is the view on screen. The table view covers it rather
    // than unmounting it -- see the note over #tableView in index.html -- so the
    // OpenLayers map keeps its view, its size and its zoom, and only the tile
    // fetching stops. A GetMap for a year nobody can see is a MapServer render
    // and a cache entry bought for nothing.
    this.drawingEnabled = true;
    this.projectionKey = readMapProjection(PROJECTION_KEYS, DEFAULT_PROJECTION_KEY);
    this.paletteKey = readMapPalette(PALETTE_KEYS, DEFAULT_PALETTE_KEY);

    this.loadingIndicator = this.getEl("loading-indicator");
    this.loadingStatusEl = this.getEl("mapLoadingStatus");
    this.legendTip = this.getEl("legendTooltip");
    this.legendTipClassEl = this.getEl("legendTooltipClass");
    this.legendTipRangeEl = this.getEl("legendTooltipRange");
    this.legendTipCountEl = this.getEl("legendTooltipCount");

    this.map = null;
    this.landLayer = null;
    this.landGeoJson = null;
    this.hexLayerGroup = null;
    this.activeWmsLayer = null;
    this.pendingWmsLayer = null;
    this.pendingLayerOnReady = null;
    this.pendingLayerCleanups = [];
    // Resolved every time a swap lands or is cancelled. The preloader waits on
    // this before any fetch it cannot answer from the cache, so the year the map
    // is drawing is never queued behind a read-ahead.
    this.layerSwapWaiters = [];
    this.viewListeners = [];
    this.zoomReadoutEl = null;
    this.viewButtons = [];
    this.palettePanel = null;
    this.paletteButton = null;
    this.paletteValueEl = null;
    this.palettePopup = null;
    this.paletteOptions = [];
    this.paletteActiveIndex = 0;
    this.paletteSwatchEls = new Map();
    this.layerToggleInputs = [];
    this.outlineToggle = null;
    this.displayOptionsEl = null;
    this.mapChoiceDashboardEl = null;

    this.legend = null;
    this.legendBarEl = null;
    this.legendLowEl = null;
    this.legendHighEl = null;
    this.legendNoDataEl = null;
    this.legendSwatchEls = [];

    // Keyed dataset|variable|year. A value of null is a remembered failure, so a
    // pointer resting on the bar does not retry the same request per swatch.
    this.classBreaksCache = new Map();
    this.classBreaksRequests = new Map();
    this.legendTipTimer = null;
    this.legendTipKey = null;

    this.loadingRevealTimer = null;
    this.loadingAnnounceTimer = null;

    // How much of the map's top and foot the timeline and the dashboard stand
    // on, as DemscoreApp measures them. See measureWorldFit.
    this.worldFitInsets = { top: 0, bottom: 0 };
  }

  initialize() {
    this.projection = getMapProjection(this.projectionKey);

    // The same string on both sources on purpose. OpenLayers keys attributions
    // by their text and shows each once, so this prints a single line -- and it
    // keeps printing it when either the land or the hex layer is switched off in
    // the display options. The hex layer is the one derived from the licensed
    // sources and used to be the one with no attribution at all.
    this.landLayer = new ol.layer.Vector({
      source: new ol.source.Vector({
        attributions: this.attributionHtml,
      }),
      style: new ol.style.Style({
        fill: new ol.style.Fill({ color: LAND_BASEMAP_COLOR }),
        stroke: new ol.style.Stroke({ color: LAND_BASEMAP_COLOR, width: 1 }),
      }),
      zIndex: BASEMAP_Z_INDEX,
      // Off since present-day countries with no value became grey hexagons:
      // with the land under them, every coast showed a cream fringe where the
      // hexagons' edge and the coastline disagree. Kept as a developer switch
      // behind Shift+D ("Landmasses"), which is where it lived before.
      visible: false,
    });

    // The hexagons live in a group of their own because a swap is two layers at
    // once -- the one on screen and the one loading behind it.
    this.hexLayerGroup = new ol.layer.Group({ zIndex: HEX_Z_INDEX });

    this.map = new ol.Map({
      target: "mapCanvas",
      layers: [this.landLayer, this.hexLayerGroup],
      // The world-fit floor cannot be measured until the map has a size, so this
      // view is provisional; applyWorldFit replaces it as soon as it can.
      view: this.createView({
        center: ol.proj.fromLonLat(INITIAL_CENTER_LON_LAT, this.projection.projection),
        resolution: resolutionForZoom(INITIAL_ZOOM),
      }),
      // The defaults include a rotate control and a rotating drag; the world is
      // read north-up here and the hex mesh has no rotated form to serve.
      controls: [
        new ol.control.Zoom({ delta: ZOOM_DELTA, duration: ZOOM_DURATION_MS }),
        new ol.control.Attribution({ collapsible: false }),
      ],
      interactions: ol.interaction.defaults.defaults({
        altShiftDragRotate: false,
        pinchRotate: false,
      }),
    });

    // The attribution control rewrites its own list whenever the sources change,
    // so the button inside it is not an element that can be bound once. The
    // listener sits on the map's viewport and finds it by attribute instead.
    this.map.getViewport().addEventListener("click", (event) => {
      const button = event.target.closest(`[${ATTRIBUTION_OPEN_ATTR}]`);
      if (!button) return;
      event.preventDefault();
      // The button is handed on so focus can come back to it, but the control
      // may have rebuilt it by then -- AboutController checks it is still in the
      // document before focusing it.
      this.onOpenAttribution(button);
    });

    // The dashboard first: the legend is written out as part of it now,
    // so the panel has to exist before there is anywhere to put it.
    this.installDisplayOptions();
    this.initializeLegend();
    this.installZoomIndicator();
    this.applyWorldFit();
    this.bindViewEvents();

    this.activeWmsLayer = this.createWmsLayer();
    this.hexLayerGroup.getLayers().push(this.activeWmsLayer);

    this.loadLandmassBaseLayer();

    // OpenLayers watches the map element itself, so this fires for a window
    // resize and for the panel changing width alike. A taller or wider window
    // fits the world at a different zoom, so the floor is re-measured rather
    // than fixed once at startup.
    this.map.on("change:size", () => this.applyWorldFit());
    // Zoom is continuous and there is no separate zoomend: moveend is where a
    // pan and a zoom both come to rest, and the mesh only needs re-picking once
    // the view has settled.
    this.map.on("moveend", () => this.updateHexLayerForZoom());
  }

  // A view belongs to one projection and cannot be moved to another, so this is
  // what the projection toggle rebuilds.
  //
  // `extent` with `constrainOnlyCenter` is the whole panning rule: the centre of
  // the window has to stay on the globe, so any point can be brought to the
  // middle of the screen and no further. The looser reading -- keeping the whole
  // viewport inside the world -- is the one that cannot be used: the world is a
  // fixed box in a window of whatever shape, and at zoom 3.73 in a 740px-tall
  // map it stands 1484px high, so nothing north of about 35N could ever be
  // centred and the only way to look straight at Europe would be to zoom in
  // until it happened to land in the middle.
  //
  // The box is `viewExtent`, not the world box: everything south of 60S is
  // cream and dataless, so it is not worth a share of the scale. See
  // VIEW_SOUTH_LIMIT_LAT in core/projection.js. Antarctica can still be panned
  // to -- this bounds the centre of the window, not what gets drawn.
  createView({ center, resolution }) {
    return new ol.View({
      projection: this.projection.projection,
      extent: this.projection.viewExtent,
      resolutions: this.viewResolutions(),
      constrainOnlyCenter: true,
      // The edge of the world is a wall, not a rubber band: a drag that reaches
      // it stops there rather than overshooting and easing back.
      smoothExtentConstraint: false,
      smoothResolutionConstraint: false,
      constrainResolution: false,
      enableRotation: false,
      multiWorld: false,
      center,
      resolution,
    });
  }

  bindViewEvents() {
    ol.Observable.unByKey(this.viewListeners);
    const view = this.map.getView();
    // The readout follows a continuous zoom while it moves, not only where it
    // stops.
    this.viewListeners = [view.on("change:resolution", () => this.updateZoomReadout())];
    this.updateZoomReadout();
  }

  // The ladder the view may zoom along: the world fit at the coarse end,
  // halving from there, and MAX_ZOOM's resolution exactly at the fine end.
  //
  // It has to be spelled out. Given only a floor and a ceiling, OpenLayers keeps
  // the floor and then rounds the *span* down to a whole number of levels, so a
  // MAX_ZOOM of 6 came out as 5.52 in one window and 5.72 in another -- how far
  // in the map can go is not something that should depend on the shape of the
  // window, and a ceiling that moves when the sidebar does is worse than one
  // that is merely wrong.
  //
  // Halving from the fit rather than from zoom zero is what keeps the +/- step
  // honest: OpenLayers counts a zoom level as one entry of this array, and every
  // delta in the app -- the buttons, the keyboard, the wheel -- assumes a level
  // is a factor of two. Only the last step is short, by however far the world
  // fit falls off the ladder, and it is the one step nobody counts.
  viewResolutions() {
    const finest = resolutionForZoom(MAX_ZOOM);
    // Before the map has a size there is nothing to fit the world to, so the
    // ladder starts at the coarsest zoom instead and applyWorldFit rebuilds it.
    const measured = this.measureWorldFit() || resolutionForZoom(MIN_ZOOM_FLOOR);
    const coarsest = Math.max(
      Math.min(measured, resolutionForZoom(MIN_ZOOM_FLOOR)),
      finest * 2,
    );

    const resolutions = [];
    for (let resolution = coarsest; resolution > finest; resolution /= 2) {
      resolutions.push(resolution);
    }
    resolutions.push(finest);
    return resolutions;
  }

  // A window of a different shape fits the world at a different zoom, and the
  // ladder is built around that zoom, so the view is rebuilt rather than
  // adjusted -- a view's resolutions cannot be changed once it has them.
  applyWorldFit() {
    const view = this.map.getView();
    const resolutions = this.viewResolutions();
    if (resolutions[0] === view.getResolutions()?.[0]) return;

    this.map.setView(this.createView({
      center: view.getCenter(),
      resolution: view.getResolution(),
    }));
    this.bindViewEvents();
  }

  // The resolution at which the whole of this projection's view box fits the
  // window, or 0 before the map has a size to measure. The view box is the
  // world with the empty south cropped off, so this is the zoom the populated
  // part of the world is fitted at.
  //
  // Fitted to the part of the window nothing floats over. The timeline across
  // the top and the dashboard across the foot are both over the map rather than
  // beside it, and a world fitted to the whole canvas put Canada and Greenland
  // under the one and Australia and Patagonia under the other at the furthest
  // a reader could zoom out -- so the widest view never showed the world.
  measureWorldFit() {
    const size = this.map?.getSize();
    if (!size || !size[0] || !size[1]) return 0;
    const { top, bottom } = this.worldFitInsets;
    const covered = top + bottom + 2 * WORLD_FIT_GUTTER_PX;
    const height = Math.max(size[1] - covered, size[1] * WORLD_FIT_MIN_HEIGHT_SHARE);
    return worldFitResolution(this.projection.viewExtent, [size[0], height]);
  }

  // DemscoreApp measures the panels and reports each as it changes: a new
  // variable can change the timeline's height, and folding either panel away
  // gives its space back to the world view.
  setWorldFitInset(side, px) {
    if (!(side in this.worldFitInsets) || !Number.isFinite(px)) return;
    const value = Math.max(0, px);
    if (this.worldFitInsets[side] === value) return;
    this.worldFitInsets[side] = value;
    if (this.map) this.applyWorldFit();
  }

  // Web Mercator metres per pixel, read off the resolution rather than taken
  // from the view. See resolutionForZoom in core/projection.js for why the two
  // are not the same number.
  getZoom() {
    const resolution = this.map?.getView().getResolution();
    return Number.isFinite(resolution) ? zoomForResolution(resolution) : INITIAL_ZOOM;
  }

  getProjectionKey() {
    return this.projectionKey;
  }

  // Swapping the plane the map is drawn in rebuilds three things, because none
  // of them can be converted in place: the view, which belongs to its
  // projection; the land outlines, which were projected when they were read; and
  // the WMS layer, whose tiles were cut to the old grid and asked of MapServer
  // in the old SRS.
  setProjection(key) {
    if (!PROJECTION_KEYS.includes(key) || key === this.projectionKey) return;

    const view = this.map.getView();
    const center = transferCenter(view.getCenter(), this.projectionKey, key);
    // The scale carries across as a multiple of the world view rather than as a
    // number of metres per pixel. The two worlds are different sizes -- Mercator
    // is 40075km wide against Equal Earth's 34488km, and half as tall again --
    // so keeping the metres would turn a world view into a view of the Atlantic.
    // Keeping the multiple means a world view stays a world view and a look at
    // Europe stays a look at Europe.
    const worldViews = view.getResolution() / this.measureWorldFit();

    this.projectionKey = key;
    this.projection = getMapProjection(key);
    writeMapProjection(key);

    this.map.setView(this.createView({
      center,
      resolution: this.measureWorldFit() * worldViews,
    }));
    this.bindViewEvents();
    this.renderLandBasemap();

    this.stopPendingLayerSwap();
    this.hexLayerGroup.getLayers().clear();
    this.activeWmsLayer = this.createWmsLayer();
    this.hexLayerGroup.getLayers().push(this.activeWmsLayer);

    this.syncDisplayOptions();
    // Every tile URL now names a different SRS and a different BBOX, so the
    // preload marks count tiles nobody will ask for again.
    this.onLayerParamsChange();
  }

  getMap() {
    return this.map;
  }

  // The dashboard is a child of the pane rather than of the canvas, so the
  // table view -- which covers the canvas -- has to leave room for it at its
  // foot. DemscoreApp measures it; this is the only way to reach it.
  getMapChoiceDashboard() {
    return this.mapChoiceDashboardEl;
  }

  // For a control that sits over the map but is not the map's own -- the
  // map-only button. OpenLayers only holds a click back from the map when the
  // element is in its stop-event container, which is what a Control puts it in.
  addMapControl(element) {
    this.map.addControl(new ol.control.Control({ element }));
  }

  getContainer() {
    return this.map.getTargetElement();
  }

  async loadLandmassBaseLayer() {
    try {
      const response = await fetch("/api/basemap/land");
      if (!response.ok) {
        throw new Error(`Could not load land basemap: ${response.status}`);
      }
      // Kept in lon/lat, not as projected features: the projection toggle reads
      // it again rather than converting what is already on the map.
      this.landGeoJson = await response.json();
      this.renderLandBasemap();
    } catch (error) {
      console.error(error);
    }
  }

  // The outlines are not densified before projecting. Both projections curve or
  // stretch what a lat/lon edge should follow, so a long straight one is drawn
  // as a chord of the curve it belongs to; measured against Natural Earth 110m
  // in Equal Earth the worst segment in the world (the 141W Alaska/Yukon border)
  // is off by 6.3km, which is 0.2px at the world view and 2.6px at MAX_ZOOM.
  // Not worth a densify step; re-measure before adding one.
  renderLandBasemap() {
    const source = this.landLayer.getSource();
    source.clear();
    if (!this.landGeoJson) return;

    source.addFeatures(
      new ol.format.GeoJSON().readFeatures(this.landGeoJson, {
        dataProjection: "EPSG:4326",
        featureProjection: this.projection.projection,
      }),
    );
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
    const incomingHexSize = String(incomingLayer?.getSource()?.getParams()?.hex_size ?? "");
    if (incomingHexSize === nextHexSize) return;

    this.loadNextLayer();
  }

  // The tile-grid stop the visible tiles are cut at.
  //
  // Zoom is continuous, so between tile-grid stops the grid keeps asking for one
  // discrete resolution and scales what comes back. Rounding the map's own zoom
  // here would name tiles it never asks for, and the preload marks would then be
  // reporting on the wrong ones -- so the grid is asked exactly the question the
  // tile renderer asks it.
  getVisibleTileZoom() {
    if (!this.map) return null;

    const resolution = this.map.getView().getResolution();
    if (!Number.isFinite(resolution)) return null;

    return this.projection.tileGrid.getZForResolution(resolution, TILE_Z_DIRECTION);
  }

  getVisibleTileCoords() {
    if (!this.map) return [];

    const view = this.map.getView();
    const size = this.map.getSize();
    if (!size || !size[0] || !size[1]) return [];

    const z = this.getVisibleTileZoom();
    if (z === null) return [];

    const tileGrid = this.projection.tileGrid;
    // The grid's own tile range at this zoom, which is what keeps the preload
    // off tiles that fall outside the world box.
    const worldRange = tileGrid.getFullTileRange(z);
    const coords = [];

    tileGrid.forEachTileCoord(view.calculateExtent(size), z, ([tileZ, x, y]) => {
      if (worldRange && !worldRange.containsXY(x, y)) return;
      coords.push([tileZ, x, y]);
    });

    return coords;
  }

  getVisibleWmsTileUrls(paramOverrides = {}) {
    const source = this.activeWmsLayer?.getSource();
    if (!source) return [];

    // The URLs are spelled by a source of its own rather than by the one on
    // screen. updateParams() on a live source drops its tiles and refetches
    // them, and the preloader asks this for a different year every time.
    const speller = new ol.source.TileWMS({
      url: this.mapServerBase,
      projection: this.projection.projection,
      tileGrid: this.projection.tileGrid,
      params: { ...source.getParams(), ...paramOverrides },
      hidpi: false,
    });
    const tileUrl = speller.getTileUrlFunction();
    const urls = this.getVisibleTileCoords()
      .map((coords) => tileUrl(coords, 1, this.projection.projection))
      .filter(Boolean);

    return [...new Set(urls)];
  }

  // ---- downloads ------------------------------------------------------------
  //
  // A downloaded image or video is drawn from tiles of its own, not read off the
  // canvas on screen. The screen holds one year at a time, swaps it in when it
  // is "drawn enough" (see whenPendingLayerDrawn) and covers the edges with the
  // timeline and the dashboard; a file needs every tile of every year, at a
  // size of its own, and must not move the map the reader is looking at.

  // Where a download looks, frozen when it starts.
  //
  // `matchScreen` is the screen exactly -- its centre and its scale, in a frame
  // the pane's own size -- so it is the same tiles the map asked for, served
  // from whatever the read-ahead has already cached. Otherwise the frame is
  // fitted to the part of the screen that has the world in it: a world view on
  // screen has sky and sea above and below the map, and fitting those into a
  // 16:9 frame as well drew the world at half the frame's width.
  //
  // The mesh is the one on screen even where the frame's scale would pick
  // another: a reader who framed Europe at 50 km expects 50 km hexagons in the
  // file, not whatever the HD frame's zoom happens to round to.
  getExportView(width, height, { matchScreen = false } = {}) {
    const view = this.map.getView();
    const size = this.map.getSize();
    let center = view.getCenter();
    let resolution = view.getResolution();
    if (!matchScreen && size && size[0] && size[1]) {
      const visible = view.calculateExtent(size);
      const world = this.projection.viewExtent;
      const box = [
        Math.max(visible[0], world[0]),
        Math.max(visible[1], world[1]),
        Math.min(visible[2], world[2]),
        Math.min(visible[3], world[3]),
      ];
      if (box[2] > box[0] && box[3] > box[1]) {
        // A little air around the box, or the islands either side of the
        // antimeridian are cut in half by the frame's edge.
        resolution = EXPORT_FIT_MARGIN * Math.max((box[2] - box[0]) / width, (box[3] - box[1]) / height);
        center = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
      }
    }
    const halfWidth = (resolution * width) / 2;
    const halfHeight = (resolution * height) / 2;
    return {
      width,
      height,
      resolution,
      extent: [center[0] - halfWidth, center[1] - halfHeight, center[0] + halfWidth, center[1] + halfHeight],
      projection: this.projection,
      params: this.buildWmsParams(),
    };
  }

  // The tiles one year of an export view is made of, each with the box it
  // covers in the frame's pixels. The edges are rounded from the tile's own
  // extent rather than stepped by a rounded tile size, so neighbours meet
  // exactly and no hairline of ocean shows between them.
  getExportTileRequests(exportView, year) {
    const { extent, resolution, projection } = exportView;
    const tileGrid = projection.tileGrid;
    const z = tileGrid.getZForResolution(resolution, TILE_Z_DIRECTION);
    const worldRange = tileGrid.getFullTileRange(z);
    const speller = new ol.source.TileWMS({
      url: this.mapServerBase,
      projection: projection.projection,
      tileGrid,
      params: { ...exportView.params, year: String(year) },
      hidpi: false,
    });
    const tileUrl = speller.getTileUrlFunction();
    const requests = [];

    tileGrid.forEachTileCoord(extent, z, (coord) => {
      if (worldRange && !worldRange.containsXY(coord[1], coord[2])) return;
      const url = tileUrl(coord, 1, projection.projection);
      if (!url) return;
      const [minX, minY, maxX, maxY] = tileGrid.getTileCoordExtent(coord);
      const left = Math.round((minX - extent[0]) / resolution);
      const right = Math.round((maxX - extent[0]) / resolution);
      const top = Math.round((extent[3] - maxY) / resolution);
      const bottom = Math.round((extent[3] - minY) / resolution);
      requests.push({ url, left, top, width: right - left, height: bottom - top });
    });

    return requests;
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
    this.cancelPendingLayerWatch();
    if (!this.pendingWmsLayer) return;
    this.hexLayerGroup.getLayers().remove(this.pendingWmsLayer);
    this.pendingWmsLayer = null;
    this.hideLoadingIndicator();
    this.releaseLayerSwapWaiters();
  }

  cancelPendingLayerWatch() {
    const cleanups = this.pendingLayerCleanups;
    this.pendingLayerCleanups = [];
    for (const cleanup of cleanups) cleanup();
  }

  // Whether the map is part-way through putting a year on screen. The read-ahead
  // asks before every request that would have to go to MapServer, because those
  // are the moments its requests are in the way of the map's own -- see
  // DemscoreApp.takePreloadNetworkTurn.
  hasPendingLayerSwap() {
    return this.pendingWmsLayer !== null;
  }

  // Resolves as soon as no swap is in flight. The preloader holds its next
  // request here during autoplay: MapServer renders one tile at a time per
  // worker, so a dozen read-ahead requests queued in front of the frame on its
  // way to the screen is the difference between animating at the speed tiles
  // arrive and appearing to stop.
  whenLayerSwapSettles() {
    if (!this.pendingWmsLayer) return Promise.resolve();

    return new Promise((resolve) => {
      this.layerSwapWaiters.push(resolve);
    });
  }

  // Every path that clears pendingWmsLayer ends here, which is what keeps the
  // promise above from outliving the swap it was waiting on.
  releaseLayerSwapWaiters() {
    const waiters = this.layerSwapWaiters;
    this.layerSwapWaiters = [];
    for (const resolve of waiters) resolve();
  }

  // The GetMap parameters for what the map is drawing now. The live layer and
  // the download (see getExportTileRequests) both spell their requests from
  // this, so a downloaded frame is the same request the map makes -- and is
  // served from the same caches.
  buildWmsParams() {
    const polarity = this.metadataController.getActivePolarity();
    // Blue-Red requests leave `palette` out, because that is what MapServer
    // paints unnamed and the long-lived cache is warm under those URLs. This is
    // the *server's* default, not the reader's -- see palettes.js.
    const explicitlyNamePalette = this.paletteKey !== SERVER_DEFAULT_PALETTE_KEY;
    return {
      LAYERS: this.wmsLayerNames(),
      STYLES: "",
      FORMAT: "image/png",
      TRANSPARENT: true,
      // 1.1.1 rather than OpenLayers' default 1.3.0: 1.3.0 would spell the
      // projection as CRS and reorder the BBOX for north-east axis order,
      // which is a second thing to get right for no gain here.
      VERSION: "1.1.1",
      dataset: this.state.dataset,
      variable: this.state.variable,
      polarity,
      year: String(this.state.year),
      hex_size: String(this.hexSizeFromZoom()),
      ...(explicitlyNamePalette ? { palette: this.paletteKey } : {}),
    };
  }

  createWmsLayer() {
    const source = new ol.source.TileWMS({
      url: this.mapServerBase,
      projection: this.projection.projection,
      attributions: this.attributionHtml,
      // The grid is the world box cut by the shared resolution ladder, so the
      // BBOX of every request is derived from the same two numbers the mapfile
      // and the mapcache preloader use.
      tileGrid: this.projection.tileGrid,
      params: this.buildWmsParams(),
      // No high-DPI request. A retina screen would otherwise ask MapServer for a
      // doubled tile with MAP_RESOLUTION appended, which is a different URL per
      // device -- a separate tile cache per device, and preload marks describing
      // tiles no one else will ever fetch.
      hidpi: false,
      wrapX: false,
      // The hexagons are the data. Fading them in reads as the map changing its
      // mind, and during autoplay it would never settle.
      transition: 0,
    });

    return new ol.layer.Tile({
      source,
      // Nearest tile-grid resolution, which is what getVisibleTileCoords assumes
      // when it names the tiles for the preloader.
      zDirection: TILE_Z_DIRECTION,
    });
  }

  // Which MapServer layers this projection's mesh lives in, in drawing order --
  // MapServer draws them in the order they are named here.
  //
  // The outline layer is drawn over the fills from a precomputed edge table;
  // asking for both in the same GetMap keeps them in step -- one image, one
  // cache entry, and no window where outlines from the previous year sit over
  // this year's colours.
  wmsLayerNames() {
    const { fill, outline } = this.projection.wmsLayers;
    const names = [fill];
    if (this.areaOutlinesEnabled) names.push(outline);
    return names.join(",");
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

  // One bottom-left stack replacing what Leaflet spread over a layers control
  // and a custom one: whether equal-colour areas are outlined, and which of the
  // two layers are on. The projection and colour choices live together in the
  // bottom-centre map dashboard.
  //
  // OpenLayers has no layer switcher of its own, which is the price of it
  // drawing everything into one canvas rather than into stacked panes.
  installDisplayOptions() {
    const container = document.createElement("div");
    container.className = "ol-unselectable map-display-stack";
    container.innerHTML = `
      <div class="zoom-display map-display-extra"></div>
      <div class="map-display-options map-display-extra">
        <label class="map-display-option">
          <input type="checkbox" data-layer="land" />
          <span>Landmasses</span>
        </label>
        <label class="map-display-option">
          <input type="checkbox" data-layer="hex" />
          <span>Demscore Hex Layer</span>
        </label>
      </div>`;

    this.layerToggleInputs = Array.from(container.querySelectorAll("input[data-layer]"));
    for (const input of this.layerToggleInputs) {
      const layer = input.dataset.layer === "land" ? this.landLayer : this.hexLayerGroup;
      input.addEventListener("change", () => layer.setVisible(input.checked));
    }

    this.displayOptionsEl = container;
    this.syncDisplayOptions();
    this.installDisplayExtrasShortcut();

    // The control sits over the map, and OpenLayers only holds a click back from
    // the map when the element is in the stop-event container, which is what
    // ol.control.Control puts it in.
    this.map.addControl(new ol.control.Control({ element: container }));

    this.installMapChoiceDashboard();
  }

  // The map dashboard: one row along the foot of the map -- the View switch, the
  // legend with the colour-scheme dropdown built into it, the outline switch,
  // Export (the Download dialog) and the button that folds it down to its legend. It was two rows (labelled sections over their
  // controls, and a strip of swatch buttons for the schemes), which made it the
  // tallest thing on the map after the timeline; the client's mockup put it on
  // one row with the schemes behind a dropdown.
  installMapChoiceDashboard() {
    const container = document.createElement("div");
    container.className = "ol-unselectable map-choice-dashboard";
    container.innerHTML = `
      <div class="map-choice-section map-view-panel">
        <span id="mapViewLabel" class="visually-hidden">View</span>
        <div class="map-view-switch" role="radiogroup" aria-labelledby="mapViewLabel">
          ${VIEW_CHOICE_KEYS.map((key) => {
            const isTable = key === TABLE_VIEW_KEY;
            // With one projection on offer, its name is not a choice the
            // switch is asking about: the question is map or table.
            const label = isTable ? "Table" : PROJECTION_KEYS.length === 1 ? "Map" : getMapProjection(key).label;
            const title = isTable ? TABLE_VIEW_TITLE : getMapProjection(key).title;
            // A rule before the table only when there are projections to part
            // it from: two ways of drawing the picture, and then not a picture.
            const rule = isTable && PROJECTION_KEYS.length > 1 ? '<span class="map-view-divider" aria-hidden="true"></span>' : "";
            return `${rule}
              <button class="map-view-choice" type="button" role="radio" value="${key}" title="${title}">
                <i class="map-view-icon" data-lucide="${VIEW_CHOICE_ICONS[key]}" aria-hidden="true"></i>
                <span>${label}</span>
              </button>`;
          }).join("")}
        </div>
      </div>
      <span class="map-choice-divider" aria-hidden="true"></span>
      <!-- The legend, and the colour-scheme picker as part of it: the ramp is
           what the scheme chose, so the ramp is where it is changed. It is the
           key to the map, so it is what is left when the dashboard is folded --
           picker included. initializeLegend() binds the scale.

           The picker is a button that opens a listbox of the schemes, each
           shown as its name over its ramp -- the "select-only" pattern, written
           out because a native <select> cannot draw a ramp in an option. The
           listbox takes focus when it opens and points at its options with
           aria-activedescendant. A click on the ramp or its end labels opens
           it too; the button is the keyboard's way in, since each swatch is
           already a tab stop of its own for its value card. -->
      <div class="map-choice-section map-legend-panel">
        <div class="legend-scale" role="group" aria-label="Map legend">
          <div class="legend-bar"></div>
          <div class="legend-labels"><span></span><span></span></div>
          <p class="legend-nodata">
            <span class="legend-nodata-swatch" aria-hidden="true"></span>
            <span class="legend-nodata-label">No data</span>
          </p>
          <button
            id="mapPaletteButton"
            class="map-palette-button"
            type="button"
            aria-haspopup="listbox"
            aria-expanded="false"
            aria-controls="mapPaletteListbox"
            aria-labelledby="mapPaletteLabel mapPaletteCurrent"
          >
            <span id="mapPaletteLabel" class="visually-hidden">Colours</span>
            <span id="mapPaletteCurrent" class="visually-hidden"></span>
            <i class="map-palette-button-icon" data-lucide="palette" aria-hidden="true"></i>
            <i class="map-palette-button-chevron" data-lucide="chevron-up" aria-hidden="true"></i>
          </button>
        </div>
        <div
          id="mapPaletteListbox"
          class="map-palette-popup"
          role="listbox"
          aria-labelledby="mapPalettePopupLabel"
          tabindex="-1"
          hidden
        >
          <p id="mapPalettePopupLabel" class="map-palette-popup-label">Colour scheme</p>
          ${PALETTE_KEYS.map((key) => {
            const palette = MAP_PALETTES[key];
            return `<div id="mapPaletteOption-${key}" class="map-palette-option" role="option" data-value="${key}" aria-selected="false">
              <span class="map-palette-option-head">
                <span class="map-palette-name">${palette.label}</span>
                <i class="map-palette-check" data-lucide="check" aria-hidden="true"></i>
              </span>
              <span class="map-palette-swatches" data-palette-swatches="${key}" aria-hidden="true">${palette.band.colors
                .map((color) => `<i style="background: ${color}"></i>`)
                .join("")}</span>
            </div>`;
          }).join("")}
        </div>
      </div>
      <span class="map-choice-divider" aria-hidden="true"></span>
      <div class="map-choice-section map-outline-panel">
        <label class="map-outline-toggle" for="areaOutlineToggle">
          <input id="areaOutlineToggle" type="checkbox" aria-label="Outline equal values" />
          <span class="map-outline-switch" aria-hidden="true">
            <span class="map-outline-track">
              <span class="map-outline-thumb"></span>
            </span>
          </span>
          <span id="mapOutlineCopy" class="map-outline-copy">Outline equal values</span>
        </label>
      </div>
      <span class="map-choice-divider" aria-hidden="true"></span>
      <!-- Opens the Download dialog: this year as an image, or a span of years
           as a video. MapExportController binds it by id. -->
      <div class="map-choice-section map-export-panel">
        <button
          id="mapExportBtn"
          class="map-export-button"
          type="button"
          aria-haspopup="dialog"
          title="Download an image or a video of the map"
        >
          <i data-lucide="download" aria-hidden="true"></i>
          <span>Export</span>
        </button>
      </div>
      <span class="map-choice-divider map-collapse-divider" aria-hidden="true"></span>
      <!-- Folds the dashboard down to its legend; see sidebarCollapseBtn in
           index.html. PanelCollapseController owns its label and state. -->
      <button
        id="dashboardCollapseBtn"
        type="button"
        class="panel-collapse-button panel-collapse-dashboard"
        aria-expanded="true"
        aria-label="Hide the map controls, keeping the legend"
        title="Hide the map controls, keeping the legend"
      >
        <i data-lucide="chevron-down" aria-hidden="true"></i>
      </button>`;

    this.viewButtons = Array.from(container.querySelectorAll(".map-view-choice"));
    for (const button of this.viewButtons) {
      button.addEventListener("click", () => this.chooseView(button.value));
    }
    const viewSwitch = container.querySelector(".map-view-switch");
    viewSwitch.addEventListener("keydown", (event) => this.onViewKeydown(event));

    // The whole legend panel, not just the button: a click on the ramp opens the
    // list as well, and it must count as inside for the outside-click and
    // focusout checks below, or pressing the ramp to close the list would shut
    // it on pointerdown and reopen it on click.
    this.palettePanel = container.querySelector(".map-legend-panel");
    this.paletteButton = container.querySelector("#mapPaletteButton");
    this.paletteValueEl = container.querySelector("#mapPaletteCurrent");
    this.palettePopup = container.querySelector("#mapPaletteListbox");
    this.paletteOptions = Array.from(container.querySelectorAll(".map-palette-option"));
    this.paletteActiveIndex = 0;
    const togglePalettePopup = () => {
      if (this.palettePopup.hidden) this.openPalettePopup();
      else this.closePalettePopup(true);
    };
    this.paletteButton.addEventListener("click", togglePalettePopup);
    // The ramp and its end labels, not the no-data patch: that grey is the same
    // in every scheme, so it is not what the list changes.
    for (const el of container.querySelectorAll(".legend-bar, .legend-labels")) {
      el.addEventListener("click", () => {
        this.hideLegendTip();
        togglePalettePopup();
      });
    }
    this.paletteButton.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      this.openPalettePopup();
    });
    this.palettePopup.addEventListener("keydown", (event) => this.onPalettePopupKeydown(event));
    this.palettePopup.addEventListener("focusout", (event) => {
      if (!this.palettePanel.contains(event.relatedTarget)) this.closePalettePopup(false);
    });
    for (const [index, option] of this.paletteOptions.entries()) {
      option.addEventListener("pointermove", () => this.setPaletteActive(index));
      option.addEventListener("click", () => {
        this.setPalette(option.dataset.value);
        this.closePalettePopup(true);
      });
    }
    document.addEventListener("pointerdown", (event) => {
      if (!this.palettePopup.hidden && !this.palettePanel.contains(event.target)) this.closePalettePopup(false);
    });

    this.outlineToggle = container.querySelector("#areaOutlineToggle");
    this.outlineToggle.addEventListener("change", () => this.setAreaOutlinesEnabled(this.outlineToggle.checked));
    this.paletteSwatchEls = new Map(
      PALETTE_KEYS.map((key) => [
        key,
        Array.from(container.querySelectorAll(`[data-palette-swatches="${key}"] i`)),
      ]),
    );

    this.mapChoiceDashboardEl = container;
    this.syncViewSelector();
    this.syncPaletteSelector();
    this.syncOutlineToggle();
    this.syncPaletteSwatches();
    refreshIcons();
    // A child of the pane, not an OpenLayers control. A control lives inside
    // `#mapCanvas`, and the table view covers that element and makes it
    // `inert` -- so a View switch parked in there would be hidden and
    // unfocusable in exactly the view a reader needs it to get back out of.
    // Outside the map element it is not in the map's event path at all, which
    // is what the stop-event container was buying.
    this.getEl("map").append(container);
  }

  openPalettePopup() {
    this.palettePopup.hidden = false;
    this.paletteButton.setAttribute("aria-expanded", "true");
    this.setPaletteActive(Math.max(0, PALETTE_KEYS.indexOf(this.paletteKey)));
    this.palettePopup.focus();
  }

  // `returnFocus` when the reader closed it from inside (a choice, Escape);
  // not when focus or a click has already gone somewhere else.
  closePalettePopup(returnFocus) {
    if (this.palettePopup.hidden) return;
    this.palettePopup.hidden = true;
    this.paletteButton.setAttribute("aria-expanded", "false");
    this.palettePopup.removeAttribute("aria-activedescendant");
    if (returnFocus) this.paletteButton.focus();
  }

  setPaletteActive(index) {
    this.paletteActiveIndex = index;
    this.paletteOptions.forEach((option, optionIndex) => {
      option.classList.toggle("is-active", optionIndex === index);
    });
    const active = this.paletteOptions[index];
    if (active) this.palettePopup.setAttribute("aria-activedescendant", active.id);
  }

  onPalettePopupKeydown(event) {
    const last = this.paletteOptions.length - 1;
    switch (event.key) {
      case "ArrowDown":
        this.setPaletteActive(Math.min(last, this.paletteActiveIndex + 1));
        break;
      case "ArrowUp":
        this.setPaletteActive(Math.max(0, this.paletteActiveIndex - 1));
        break;
      case "Home":
        this.setPaletteActive(0);
        break;
      case "End":
        this.setPaletteActive(last);
        break;
      case "Enter":
      case " ":
        this.setPalette(this.paletteOptions[this.paletteActiveIndex]?.dataset.value);
        this.closePalettePopup(true);
        break;
      case "Escape":
        // Held here: Escape is also what leaves map-only, and closing a
        // dropdown should not do that as well.
        event.stopPropagation();
        this.closePalettePopup(true);
        break;
      case "Tab":
        this.closePalettePopup(false);
        return;
      default:
        return;
    }
    event.preventDefault();
  }

  // The three-way answer to "how do I want to see this year". Two of the three
  // are projections and go to setProjection; the third is the table, and it is
  // DemscoreApp that owns that. Picking a projection while the table is on
  // screen means both: the projection is set on the map underneath and the map
  // is what comes back, which is the only reading of that click that does not
  // leave the reader looking at a table they just asked to change the shape of.
  chooseView(key) {
    if (key === TABLE_VIEW_KEY) {
      this.onViewChange(TABLE_VIEW_KEY);
      return;
    }
    this.setProjection(key);
    this.onViewChange("map");
  }

  onViewKeydown(event) {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(event.key)) return;

    event.preventDefault();
    const currentIndex = this.currentViewChoiceIndex();
    const lastIndex = VIEW_CHOICE_KEYS.length - 1;
    let nextIndex = currentIndex;
    if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = lastIndex;
    } else {
      const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
      nextIndex = (currentIndex + direction + VIEW_CHOICE_KEYS.length) % VIEW_CHOICE_KEYS.length;
    }

    this.chooseView(VIEW_CHOICE_KEYS[nextIndex]);
    this.viewButtons[nextIndex]?.focus();
  }

  // Which of the three is answered. The table wins when it is on screen: the
  // projection it will come back to is remembered but is not the answer to this
  // question while nothing is being projected.
  currentViewChoiceIndex() {
    if (this.state.view === TABLE_VIEW_KEY) return VIEW_CHOICE_KEYS.length - 1;
    return Math.max(0, PROJECTION_KEYS.indexOf(this.projectionKey));
  }

  // The zoom reading and layer switches are there for whoever is working on the
  // map, and stay out of the way until Shift+D asks for them.
  installDisplayExtrasShortcut() {
    document.addEventListener("keydown", (event) => {
      if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key !== "D" && event.key !== "d") return;
      // Not while a field has the caret: Shift+D is a capital D there.
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (target.isContentEditable || target.closest("input, textarea, select")) return;
      }
      event.preventDefault();
      this.displayOptionsEl.classList.toggle("shows-extras");
    });
  }

  syncDisplayOptions() {
    if (!this.displayOptionsEl) return;

    this.syncViewSelector();
    this.syncPaletteSelector();
    this.syncPaletteSwatches();
    this.syncOutlineToggle();
    for (const input of this.layerToggleInputs) {
      const layer = input.dataset.layer === "land" ? this.landLayer : this.hexLayerGroup;
      input.checked = layer.getVisible();
    }
  }

  // The picker is a preview of the active map, not a catalogue of every
  // palette's ramp: it shows the ramp the way round the active variable's
  // polarity draws it, so the previews stay truthful when the variable changes.
  syncPaletteSwatches() {
    const polarity = this.metadataController.getActivePolarity();
    for (const key of PALETTE_KEYS) {
      const colors = legendColorsFor(key, polarity);
      const swatches = this.paletteSwatchEls.get(key) || [];
      swatches.forEach((swatch, index) => {
        swatch.style.background = colors[index];
      });
    }
    this.syncPaletteLabels(polarity);
  }

  // A scheme's name is the same for every variable; its tooltip says whether the
  // variable on the map has a better end, so a neutral one is not told it does.
  syncPaletteLabels(polarity = this.metadataController.getActivePolarity()) {
    for (const option of this.paletteOptions || []) {
      const key = option.dataset.value;
      const name = option.querySelector(".map-palette-name");
      if (name) name.textContent = paletteLabelFor(key);
      option.title = paletteDescriptionFor(key, polarity);
    }
    if (this.paletteValueEl) this.paletteValueEl.textContent = paletteLabelFor(this.paletteKey);
    // The button shows no words, so the pointer gets them here; the keyboard
    // and screen readers get them from the hidden spans that name it.
    if (this.paletteButton) this.paletteButton.title = `Colours: ${paletteLabelFor(this.paletteKey)}`;
  }

  syncOutlineToggle() {
    if (this.outlineToggle) this.outlineToggle.checked = this.areaOutlinesEnabled;
  }

  syncViewSelector() {
    if (!this.mapChoiceDashboardEl) return;

    const selected = this.currentViewChoiceIndex();
    this.viewButtons.forEach((button, index) => {
      const active = index === selected;
      button.classList.toggle("is-selected", active);
      button.setAttribute("aria-checked", active ? "true" : "false");
      button.tabIndex = active ? 0 : -1;
    });
    // An outline is a thing the picture has and the table has not, so the
    // control for it is turned off rather than left to do nothing when pressed.
    const outlinePanel = this.mapChoiceDashboardEl.querySelector(".map-outline-panel");
    if (outlinePanel) outlinePanel.inert = this.state.view === TABLE_VIEW_KEY;
  }

  syncPaletteSelector() {
    if (!this.mapChoiceDashboardEl) return;
    for (const option of this.paletteOptions) {
      const selected = option.dataset.value === this.paletteKey;
      option.classList.toggle("is-selected", selected);
      option.setAttribute("aria-selected", selected ? "true" : "false");
    }
    this.syncPaletteLabels();
  }


  // The mesh MapServer is asked for at this zoom, in the metres of whichever
  // plane the map is drawn in -- so switching projection switches ladders as
  // well as layers. See hexResolutionStops in core/projection.js.
  hexSizeFromZoom() {
    const zoom = this.getZoom();
    const stops = this.projection.hexResolutionStops;
    let hexSize = stops[0].hexSizeM;

    for (const stop of stops) {
      if (zoom >= stop.minZoom) {
        hexSize = stop.hexSizeM;
      }
    }

    return hexSize;
  }

  // The spinner is `aria-hidden`, which is right for the ordinary case: most
  // swaps land inside the half second before it is even shown, and a reader
  // does not want "loading, loaded" between every year. The spoken status is
  // therefore on a longer fuse than the spinner -- past LOADING_ANNOUNCE_MS the
  // wait has stopped being a flicker and started being a question -- and it is
  // never armed during an animation, where a year a second is the point.
  showLoadingIndicator() {
    this.clearLoadingTimers();
    this.loadingRevealTimer = window.setTimeout(() => {
      this.loadingRevealTimer = null;
      this.loadingIndicator.classList.add("is-loading");
    }, LOADING_SPINNER_REVEAL_MS);

    if (this.state.isAutoPlaying) return;
    this.loadingAnnounceTimer = window.setTimeout(() => {
      this.loadingAnnounceTimer = null;
      this.setLoadingStatus("Loading map…");
    }, LOADING_ANNOUNCE_MS);
  }

  hideLoadingIndicator() {
    const wasAnnounced = this.loadingStatusEl?.textContent !== "";
    this.clearLoadingTimers();
    this.loadingIndicator.classList.remove("is-loading");
    // Only worth saying if the start of the wait was worth saying; otherwise
    // "Map updated" arrives out of nowhere for a swap nobody was told about.
    this.setLoadingStatus(wasAnnounced ? "Map updated." : "");
  }

  clearLoadingTimers() {
    for (const key of ["loadingRevealTimer", "loadingAnnounceTimer"]) {
      if (this[key] === null) continue;
      window.clearTimeout(this[key]);
      this[key] = null;
    }
  }

  setLoadingStatus(text) {
    if (!this.loadingStatusEl || this.loadingStatusEl.textContent === text) return;
    this.loadingStatusEl.textContent = text;
  }

  // Whether the map is the view on screen, and therefore whether a change of
  // year is worth a GetMap. Switching away drops whatever swap was in flight;
  // switching back asks for the year the timeline has meanwhile moved to, which
  // may be a long way from the one the layer still holds.
  setDrawingEnabled(enabled) {
    const next = enabled !== false;
    if (next === this.drawingEnabled) return;
    this.drawingEnabled = next;

    if (!next) {
      this.stopPendingLayerSwap();
      return;
    }
    this.loadNextLayer();
  }

  loadNextLayer(onReady) {
    // Nothing to draw into: the table view is over the map. The callback is
    // still answered, because the thing waiting on it may be an autoplay frame
    // and a frame that is never answered stops the timeline with the button
    // still reading "Pause".
    if (!this.drawingEnabled) {
      if (typeof onReady === "function") onReady();
      return;
    }

    // A reload can land while a swap is still in flight -- a zoom crossing a hex
    // resolution stop mid-autoplay is the usual way. The superseded layer's
    // continuation moves onto the new layer instead of dying with it: autoplay
    // schedules its next year from that callback, so dropping it froze the
    // timeline while the button still read "Pause".
    const carriedOnReady = this.pendingLayerOnReady;
    this.stopPendingLayerSwap();
    const readyCallback = typeof onReady === "function" ? onReady : carriedOnReady;

    const nextLayer = this.createWmsLayer();
    // Invisible, not hidden: OpenLayers renders a zero-opacity layer as usual
    // and only drops it at the compositing step, so its tiles are requested
    // while the layer on screen carries on showing the year that is leaving.
    nextLayer.setOpacity(0);
    this.hexLayerGroup.getLayers().push(nextLayer);
    this.pendingWmsLayer = nextLayer;
    this.pendingLayerOnReady = readyCallback;

    this.showLoadingIndicator();
    this.whenPendingLayerDrawn(nextLayer, () => {
      if (this.pendingWmsLayer !== nextLayer) return;
      nextLayer.setOpacity(1);
      this.hexLayerGroup.getLayers().remove(this.activeWmsLayer);
      this.activeWmsLayer = nextLayer;
      this.pendingWmsLayer = null;
      this.pendingLayerOnReady = null;
      this.hideLoadingIndicator();
      this.releaseLayerSwapWaiters();
      if (readyCallback) readyCallback();
    });
  }

  // Leaflet's tile layer had a "load" event of its own. OpenLayers counts
  // loading across the whole map instead and fires rendercomplete on the first
  // frame where nothing is queued, loading or half-drawn. That is the reading to
  // prefer -- it is the only one that also covers a layer whose tiles were all
  // already in OpenLayers' own cache and so never load at all -- but it is not
  // one to depend on alone, because it speaks for the whole map: one tile
  // request anywhere that never settles holds it back forever, and with it the
  // autoplay frame waiting on this swap. See PENDING_LAYER_QUIET_MS.
  //
  // So the swap also lands when the pending layer's own tiles have all reported
  // back -- loaded or errored, an errored tile being one OpenLayers itself stops
  // waiting for -- when a layer that was arriving stops arriving, and, failing
  // all of those, on a deadline. Whichever comes first takes the swap; the rest
  // are unbound with it.
  //
  // That count is against the tiles the view asks for rather than against the
  // ones that happen to have started, because OpenLayers starts them in waves:
  // the map loads at most 16 at once, so a layer's tiles can all report back
  // while the rest of them are still queued behind another year's leftovers, and
  // a swap landed there would put a half-drawn year on screen.
  //
  // The map only bothers to work out whether a frame was complete when someone
  // is listening, so a stale "yes" can be dispatched from the tick before the
  // layer was added. One postrender of our own is what tells the two apart.
  whenPendingLayerDrawn(layer, onDrawn) {
    const source = layer.getSource();
    // Zero means the view could not be measured; then only the map's own reading
    // and the deadline can land the swap.
    const expectedTiles = this.getVisibleTileCoords().length;
    let drawnSinceAdded = false;
    let landed = false;
    let started = 0;
    let reported = 0;
    let quietTimer = null;
    let stallTimer = null;
    let revealTimer = null;

    const land = () => {
      if (landed) return;
      landed = true;
      this.cancelPendingLayerWatch();
      onDrawn();
    };

    const clearQuietTimer = () => {
      if (quietTimer === null) return;
      window.clearTimeout(quietTimer);
      quietTimer = null;
    };

    // Armed by the first tile to come back and pushed forward by every tile
    // after it, so it measures the gap between arrivals rather than the length
    // of the wait. A layer that has not answered at all never arms it: there is
    // no rate to call slow yet, and the deadline is what covers that.
    const restartStallTimer = () => {
      if (stallTimer !== null) window.clearTimeout(stallTimer);
      stallTimer = window.setTimeout(land, PENDING_LAYER_STALL_MS);
    };

    // Armed by the first tile to come back and never pushed forward after that:
    // it measures the whole wait, not the gap the stall timer measures.
    const armRevealTimer = () => {
      if (revealTimer !== null) return;
      revealTimer = window.setTimeout(land, PENDING_LAYER_REVEAL_MS);
    };

    const listeners = [
      this.map.on("postrender", () => {
        drawnSinceAdded = true;
      }),
      this.map.on("rendercomplete", () => {
        if (!drawnSinceAdded) return;
        land();
      }),
      source.on("tileloadstart", () => {
        started += 1;
        clearQuietTimer();
      }),
      ...["tileloadend", "tileloaderror"].map((type) =>
        source.on(type, () => {
          reported += 1;
          restartStallTimer();
          armRevealTimer();
          if (expectedTiles === 0 || started < expectedTiles || reported < started) return;
          clearQuietTimer();
          quietTimer = window.setTimeout(() => {
            quietTimer = null;
            if (reported >= started) land();
          }, PENDING_LAYER_QUIET_MS);
        }),
      ),
    ];

    const deadline = window.setTimeout(land, PENDING_LAYER_DEADLINE_MS);

    this.pendingLayerCleanups.push(() => {
      ol.Observable.unByKey(listeners);
      clearQuietTimer();
      if (stallTimer !== null) window.clearTimeout(stallTimer);
      if (revealTimer !== null) window.clearTimeout(revealTimer);
      window.clearTimeout(deadline);
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

  // The legend -- the ramp, the two ends of it, and the colour that means "no
  // value" -- is a key to the picture and sits in the map dashboard, with the
  // colour-scheme picker built into it. Its markup is written out with the rest
  // of the dashboard in installMapChoiceDashboard(); this binds it.
  //
  // It used to be one dock across the foot of the pane, 154px of the window
  // spent on a block that was mostly air, and a whole map away from either of
  // the things it belonged to. The scale is a group with a name: seven swatches
  // and a no-data patch are one key, and a reader landing on the first swatch
  // should hear what it is part of.
  initializeLegend() {
    const div = this.mapChoiceDashboardEl.querySelector(".legend-scale");

    this.legendBarEl = div.querySelector(".legend-bar");
    this.legendLowEl = div.querySelector(".legend-labels span:first-child");
    this.legendHighEl = div.querySelector(".legend-labels span:last-child");
    this.legendNoDataEl = div.querySelector(".legend-nodata");
    // A present-day country with no value for this variable and year is drawn
    // as grey hexagons (class 99 in the mapfile). The swatch is painted from
    // the same NO_DATA_COLOR in core/palettes.js the mapfile class is generated
    // from, so the two cannot drift apart.
    const noDataNote = "Countries with no value for this variable and year are drawn as grey hexagons.";
    this.legendNoDataEl.title = noDataNote;
    // A `title` is a mouse affordance: it never reaches the keyboard, and this
    // element is not focusable to begin with. The sentence is the only thing
    // that says what the grey on the map means, so it is in the text as well.
    const noDataText = document.createElement("span");
    noDataText.className = "visually-hidden";
    noDataText.textContent = ` — ${noDataNote}`;
    this.legendNoDataEl.appendChild(noDataText);
    this.legend = div;
    this.legend.style.setProperty("--no-data-color", NO_DATA_COLOR);

    // The swatches are built once and only recoloured afterwards: rebuilding the
    // bar per refresh would drop the focus and the hover the tooltip hangs off.
    //
    // `role="img"` with a tab stop rather than a button: the card is a reading
    // of the swatch and not an action on it. A click on the ramp does open the
    // scheme list, but that is the ramp's, not one swatch's, and the keyboard
    // reaches it through the button at the end of the legend.
    // What that costs is that the card cannot be the swatch's only voice — a
    // reader arriving on one hears its `aria-label` and nothing else — so the
    // label carries the class number, the value span and the country count in
    // full, and `applyLegendSwatchLabels` rewrites it as soon as the numbers
    // land. `aria-describedby` pointing at the card was the other way round and
    // would have described an element that is `hidden` most of the time.
    this.legendBarEl.innerHTML = Array.from({ length: LEGEND_CLASS_COUNT }, (_, index) =>
      `<span class="legend-swatch" data-class-index="${index + 1}" role="img" tabindex="0"></span>`)
      .join("");
    this.legendSwatchEls = Array.from(this.legendBarEl.querySelectorAll(".legend-swatch"));
    this.bindLegendTooltip();
  }

  bindLegendTooltip() {
    this.legendBarEl.addEventListener("pointerover", (event) => {
      // Touch and pen have no hover to rest on; a tap opens the scheme list.
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

    let breaks = this.classBreaksCache.get(breaksKey);
    if (breaks === undefined) {
      // Show the class straight away and let the numbers arrive; the first hover
      // on a year is the only one that waits, the rest are served from cache.
      this.renderLegendTip(classIndex, undefined);
      this.placeLegendTip(swatch);
      breaks = await this.ensureClassBreaks(breaksKey);
      // The pointer may have left the bar, or the year moved on, while we waited.
      if (this.legendTipKey !== tipKey) return;
    }

    this.renderLegendTip(classIndex, breaks);
    this.placeLegendTip(swatch);
  }

  hideLegendTip() {
    window.clearTimeout(this.legendTipTimer);
    this.legendTipTimer = null;
    this.legendTipKey = null;
    this.legendTip.hidden = true;
  }

  renderLegendTip(classIndex, breaks) {
    const classBreak = this.findClassBreak(breaks, classIndex);
    const classCount = this.classCountForBreaks(breaks);
    this.legendTipClassEl.textContent = `Class ${classIndex} of ${classCount}`;

    if (breaks === undefined) {
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

  findClassBreak(breaks, classIndex) {
    if (!Array.isArray(breaks?.classes)) return null;
    return breaks.classes.find((entry) => entry.classIndex === classIndex) || null;
  }

  classCountForBreaks(breaks = this.getCachedClassBreaks()) {
    const classIndexes = Array.isArray(breaks?.classes)
      ? breaks.classes.map((entry) => entry.classIndex).filter(Number.isInteger)
      : [];
    return classIndexes.length > 0 ? Math.max(...classIndexes) : LEGEND_CLASS_COUNT;
  }

  // Whatever has already been answered for this key, without asking: `undefined`
  // for a key never fetched, `null` for one whose fetch failed. The map summary
  // reads through this so that a year going past during autoplay never starts a
  // request of its own.
  getCachedClassBreaks(key = this.classBreaksKey()) {
    return this.classBreaksCache.get(key);
  }

  // The map colours by quantile, which says nothing about where a class starts
  // and ends; these are those edges, from the same country_scores() call the WMS
  // layer classes on. The two country totals come back with them, because the
  // spoken summary of the map needs to say how much of the world this year
  // actually covers and this is the request already being made for it.
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
      .then((payload) => ({
        classes: Array.isArray(payload?.classes) ? payload.classes : [],
        countriesWithData: Number.isFinite(payload?.countriesWithData) ? payload.countriesWithData : null,
        countriesTotal: Number.isFinite(payload?.countriesTotal) ? payload.countriesTotal : null,
      }))
      .catch((error) => {
        console.error(error);
        return null;
      })
      .then((breaks) => {
        this.rememberClassBreaks(key, breaks);
        // The swatches carry their spans in their accessible names, so the
        // names can only be complete once this has landed. Only for the key the
        // map is actually on: a stale year's numbers on the live bar would be
        // worse than none.
        if (key === this.classBreaksKey()) this.applyLegendSwatchLabels(breaks);
        return breaks;
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
    const polarity = this.metadataController.getActivePolarity();
    const legendColors = this.legendColorsForPolarity(polarity);
    this.syncPaletteSwatches();

    // Swatch i always stands for quantile class i + 1, low to high: the mapfile
    // reorders the classes per polarity, and reversing the colours here is what
    // keeps the bar reading left-to-right low-to-high whichever way it does.
    this.legendSwatchEls.forEach((swatch, index) => {
      swatch.style.background = legendColors[index];
    });
    // Whatever is already known for this variable-year; the request started
    // below (or an earlier hover's) rewrites them when it lands.
    this.applyLegendSwatchLabels(this.getCachedClassBreaks());
    // `title` because the two are clipped to one line where the pane is narrow;
    // see the note on `.legend-labels` in the narrow-dashboard block.
    if (this.legendLowEl) {
      this.legendLowEl.textContent = text.low;
      this.legendLowEl.title = text.low;
    }
    if (this.legendHighEl) {
      this.legendHighEl.textContent = text.high;
      this.legendHighEl.title = text.high;
    }
    // The card on screen belongs to the variable-year that just left.
    this.hideLegendTip();
    // Autoplay walks a year per frame-ish; its breaks would be stale before
    // anyone could hover them, so those are fetched on hover instead.
    if (!this.state.isAutoPlaying) {
      void this.ensureClassBreaks(this.classBreaksKey());
    }

    // Everything that reads the map without looking at it hangs off this one
    // call, because refreshLegend is the single place every change of dataset,
    // variable, year or polarity passes through — including an autoplay frame.
    this.onStateChange();
  }

  // A swatch has to say what it stands for on its own: it is a coloured box,
  // the card that explains it is only there while it is hovered or focused, and
  // a colour is exactly the thing some readers of this page cannot use. Until
  // the class breaks land there is only the class number to give, which is
  // still better than "image".
  applyLegendSwatchLabels(breaks) {
    const classCount = this.classCountForBreaks(breaks);
    this.legendSwatchEls.forEach((swatch, index) => {
      const classIndex = index + 1;
      const visible = classIndex <= classCount;
      swatch.hidden = !visible;
      const base = `Quantile class ${classIndex} of ${classCount}`;
      const classBreak = this.findClassBreak(breaks, classIndex);
      if (!visible || !classBreak) {
        swatch.setAttribute("aria-label", base);
        return;
      }
      const countries = speakCountryCount(classBreak.countryCount);
      swatch.setAttribute(
        "aria-label",
        `${base}: ${speakLegendRange(classBreak)}${countries ? `, ${countries}` : ""}`,
      );
    });
  }

  // How the colours on the map are to be read, in words, for whoever is
  // building the map's non-visual equivalent. Everything here is already on the
  // legend; this is the one place it can be had as data rather than as DOM.
  describeLegend() {
    const polarity = this.metadataController.getActivePolarity();
    const text = this.resolveLegendMeaning(this.state.dataset, this.state.variable);
    return {
      title: text.title,
      low: text.low,
      high: text.high,
      note: text.note,
      lowMeans: text.lowMeans || "",
      highMeans: text.highMeans || "",
      takeaway: text.takeaway || "",
      polarity,
      classCount: this.classCountForBreaks(),
      paletteLabel: paletteLabelFor(this.paletteKey),
      projectionTitle: this.projection?.title || this.projectionKey,
      noDataNote: "Countries with no value for this variable and year are drawn as grey hexagons.",
    };
  }

  // The bar reads low-to-high left to right in every scheme. A scheme that
  // honours polarity has its band reversed for positive and neutral polarity here,
  // and the mapfile does the same reversal in SQL (`base + (8 - class_idx)`),
  // so the bar and the map cannot disagree about which end is which.
  legendColorsForPolarity(polarity) {
    return legendColorsFor(this.paletteKey, polarity);
  }

  getPaletteKey() {
    return this.paletteKey;
  }

  // Switching schemes repaints every hexagon, which means new tiles: the scheme
  // rides in the tile URL, so the old ones stay cached and valid under their own
  // key and the preload marks -- which count tiles under the URL the map was
  // making -- stop describing what is cached until the run restarts.
  setPalette(key) {
    if (!PALETTE_KEYS.includes(key) || key === this.paletteKey) return;

    this.paletteKey = key;
    writeMapPalette(key);
    this.syncDisplayOptions();
    this.loadNextLayer();
    this.refreshLegend();
    this.onLayerParamsChange();
  }

  installZoomIndicator() {
    this.zoomReadoutEl = this.displayOptionsEl.querySelector(".zoom-display");
    this.updateZoomReadout();
  }

  updateZoomReadout() {
    if (!this.zoomReadoutEl) return;
    this.zoomReadoutEl.textContent = `Zoom: ${formatZoom(this.getZoom())}`;
  }
}

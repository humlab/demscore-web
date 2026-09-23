import { BaseController } from "../core/BaseController.js";
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
  PALETTE_KEYS,
  directionHintFor,
  getPalette,
  legendColorsFor,
} from "../core/palettes.js";
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

const MIN_ZOOM_FLOOR = 0;
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
  constructor({ state, meta, legendMeta, mapServerBase, metadataController, onLayerParamsChange, onStateChange }) {
    super();
    this.state = state;
    this.meta = meta;
    this.mapServerBase = mapServerBase;
    this.metadataController = metadataController;
    this.legendMeaning = compileLegendMeaning(legendMeta);
    this.onLayerParamsChange = typeof onLayerParamsChange === "function" ? onLayerParamsChange : () => {};
    // Fired from refreshLegend, which is the one place every change of what the
    // map is showing passes through. MapDataController hangs the spoken summary
    // off it.
    this.onStateChange = typeof onStateChange === "function" ? onStateChange : () => {};
    this.areaOutlinesEnabled = readAreaOutlinesEnabled(AREA_OUTLINES_DEFAULT);
    this.projectionKey = readMapProjection(PROJECTION_KEYS, DEFAULT_PROJECTION_KEY);
    this.paletteKey = readMapPalette(PALETTE_KEYS, DEFAULT_PALETTE_KEY);

    this.loadingIndicator = this.getEl("loading-indicator");
    this.loadingStatusEl = this.getEl("mapLoadingStatus");
    this.legendDock = this.getEl("mapLegendDock");
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
    this.projectionButtons = [];
    this.paletteButtons = [];
    this.paletteSwatchEls = new Map();
    this.layerToggleInputs = [];
    this.outlineToggle = null;
    this.displayOptionsEl = null;
    this.mapChoiceDashboardEl = null;

    this.legend = null;
    this.legendTitleEl = null;
    this.legendSubtitleEl = null;
    this.legendBarEl = null;
    this.legendLowEl = null;
    this.legendHighEl = null;
    this.legendNoteEl = null;
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
  }

  initialize() {
    this.projection = getMapProjection(this.projectionKey);

    this.landLayer = new ol.layer.Vector({
      source: new ol.source.Vector({
        attributions:
          '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener noreferrer">Natural Earth</a>',
      }),
      style: new ol.style.Style({
        fill: new ol.style.Fill({ color: LAND_BASEMAP_COLOR }),
        stroke: new ol.style.Stroke({ color: LAND_BASEMAP_COLOR, width: 1 }),
      }),
      zIndex: BASEMAP_Z_INDEX,
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

    this.initializeLegend();
    this.installDisplayOptions();
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
    window.addEventListener("resize", () => this.rebalanceLegendPosition());
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
  measureWorldFit() {
    const size = this.map?.getSize();
    if (!size || !size[0] || !size[1]) return 0;
    return worldFitResolution(this.projection.viewExtent, size);
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

  createWmsLayer() {
    const polarity = this.metadataController.getActivePolarity();
    // Default requests normally leave `palette` out to keep the long-lived
    // cache warm. Neutral Default now has its own ramp, though, so spelling it
    // out gives that changed rendering a fresh URL instead of reusing the old
    // neutral-Viridis tiles.
    const explicitlyNamePalette = this.paletteKey !== DEFAULT_PALETTE_KEY || polarity === "neutral";
    const source = new ol.source.TileWMS({
      url: this.mapServerBase,
      projection: this.projection.projection,
      // The grid is the world box cut by the shared resolution ladder, so the
      // BBOX of every request is derived from the same two numbers the mapfile
      // and the mapcache preloader use.
      tileGrid: this.projection.tileGrid,
      params: {
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
      },
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
  // The inset layer carries the half-size hexagons given to countries too small
  // to be dealt a cell of their own at this size, and it has to come after the
  // fills because those hexagons overlap the cell they sit on. The outline layer
  // is drawn over both from a precomputed edge table; asking for all of them in
  // the same GetMap keeps them in step -- one image, one cache entry, and no
  // window where outlines from the previous year sit over this year's colours.
  wmsLayerNames() {
    const { fill, inset, outline } = this.projection.wmsLayers;
    const names = [fill, inset];
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

  installMapChoiceDashboard() {
    const container = document.createElement("div");
    container.className = "ol-unselectable map-choice-dashboard";
    container.innerHTML = `
      <div class="map-choice-section map-projection-panel">
        <p id="mapProjectionLabel" class="map-choice-label">Projection</p>
        <div class="map-projection-switch" role="radiogroup" aria-labelledby="mapProjectionLabel">
          <span class="map-projection-selection" aria-hidden="true"></span>
          ${PROJECTION_KEYS.map((key) => {
            const projection = getMapProjection(key);
            const icon = key === "webMercator" ? "map" : "globe-2";
            return `
              <button class="map-projection-choice" type="button" role="radio" value="${key}" title="${projection.title}">
                <i class="map-projection-icon" data-lucide="${icon}" aria-hidden="true"></i>
                <span>${projection.label}</span>
              </button>`;
          }).join("")}
        </div>
      </div>
      <span class="map-choice-divider" aria-hidden="true"></span>
      <div class="map-choice-section map-palette-panel">
        <p id="mapPaletteLabel" class="map-choice-label">Colours</p>
        <div class="map-palette-list" role="radiogroup" aria-labelledby="mapPaletteLabel">
          <span class="map-palette-selection" aria-hidden="true"></span>
          ${PALETTE_KEYS.map((key) => {
            const palette = MAP_PALETTES[key];
            return `<button class="map-palette-option" type="button" role="radio" value="${key}" title="${palette.description}">
              <span class="map-palette-swatches" data-palette-swatches="${key}" aria-hidden="true">${palette.signed.colors
                .map((color) => `<i style="--palette-swatch: ${color}"></i>`)
                .join("")}</span>
              <span class="map-palette-name">${palette.label}</span>
            </button>`;
          }).join("")}
        </div>
        <div class="map-palette-mobile">
          <span class="map-palette-mobile-swatches" data-current-palette-swatches aria-hidden="true">${Array.from({ length: CLASS_COUNT })
            .map(() => "<i></i>")
            .join("")}</span>
          <select class="map-palette-select" aria-labelledby="mapPaletteLabel">
            ${PALETTE_KEYS.map((key) => {
              const palette = MAP_PALETTES[key];
              return `<option value="${key}">${palette.label}</option>`;
            }).join("")}
          </select>
        </div>
      </div>
      <span class="map-choice-divider" aria-hidden="true"></span>
      <div class="map-choice-section map-outline-panel">
        <p id="mapOutlineLabel" class="map-choice-label">Outlines</p>
        <label class="map-outline-toggle" for="areaOutlineToggle">
          <input id="areaOutlineToggle" type="checkbox" aria-labelledby="mapOutlineLabel mapOutlineCopy" />
          <span class="map-outline-switch" aria-hidden="true">
            <span class="map-outline-track">
              <span class="map-outline-thumb"></span>
            </span>
          </span>
          <span id="mapOutlineCopy" class="map-outline-copy">Equal-colour areas</span>
        </label>
      </div>`;

    this.projectionButtons = Array.from(container.querySelectorAll(".map-projection-choice"));
    for (const button of this.projectionButtons) {
      button.addEventListener("click", () => this.setProjection(button.value));
    }
    const projectionSwitch = container.querySelector(".map-projection-switch");
    projectionSwitch.addEventListener("keydown", (event) => this.onProjectionKeydown(event));
    this.paletteButtons = Array.from(container.querySelectorAll("[data-palette-swatches]")).map((swatches) =>
      swatches.closest("button"),
    );
    for (const button of this.paletteButtons) {
      button.addEventListener("click", () => this.setPalette(button.value));
    }
    const list = container.querySelector(".map-palette-list");
    list.addEventListener("keydown", (event) => this.onPaletteKeydown(event));
    this.paletteSelect = container.querySelector(".map-palette-select");
    this.paletteSelect.addEventListener("change", () => this.setPalette(this.paletteSelect.value));
    this.outlineToggle = container.querySelector("#areaOutlineToggle");
    this.outlineToggle.addEventListener("change", () => this.setAreaOutlinesEnabled(this.outlineToggle.checked));
    this.paletteSwatchEls = new Map(
      PALETTE_KEYS.map((key) => [
        key,
        Array.from(container.querySelectorAll(`[data-palette-swatches="${key}"] i`)),
      ]),
    );
    this.currentPaletteSwatchEls = Array.from(container.querySelectorAll("[data-current-palette-swatches] i"));

    this.mapChoiceDashboardEl = container;
    this.syncProjectionSelector();
    this.syncPaletteSelector();
    this.syncOutlineToggle();
    this.syncPaletteSwatches();
    if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.lucide.createIcons();
    }
    this.map.addControl(new ol.control.Control({ element: container }));
  }

  onPaletteKeydown(event) {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(event.key)) return;

    event.preventDefault();
    const currentIndex = Math.max(0, PALETTE_KEYS.indexOf(this.paletteKey));
    const lastIndex = PALETTE_KEYS.length - 1;
    let nextIndex = currentIndex;
    if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = lastIndex;
    } else {
      const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
      nextIndex = (currentIndex + direction + PALETTE_KEYS.length) % PALETTE_KEYS.length;
    }

    this.setPalette(PALETTE_KEYS[nextIndex]);
    this.paletteButtons[nextIndex]?.focus();
  }

  onProjectionKeydown(event) {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(event.key)) return;

    event.preventDefault();
    const currentIndex = Math.max(0, PROJECTION_KEYS.indexOf(this.projectionKey));
    const lastIndex = PROJECTION_KEYS.length - 1;
    let nextIndex = currentIndex;
    if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = lastIndex;
    } else {
      const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
      nextIndex = (currentIndex + direction + PROJECTION_KEYS.length) % PROJECTION_KEYS.length;
    }

    this.setProjection(PROJECTION_KEYS[nextIndex]);
    this.projectionButtons[nextIndex]?.focus();
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

    this.syncProjectionSelector();
    this.syncPaletteSelector();
    this.syncPaletteSwatches();
    this.syncOutlineToggle();
    for (const input of this.layerToggleInputs) {
      const layer = input.dataset.layer === "land" ? this.landLayer : this.hexLayerGroup;
      input.checked = layer.getVisible();
    }
  }

  // The picker is a preview of the active map, not a catalogue of every
  // palette's signed ramp. A neutral variable takes each scheme's dedicated
  // sequential ramp, so the previews stay truthful when the variable changes.
  syncPaletteSwatches() {
    const polarity = this.metadataController.getActivePolarity();
    for (const key of PALETTE_KEYS) {
      const colors = legendColorsFor(key, polarity);
      const swatches = this.paletteSwatchEls.get(key) || [];
      swatches.forEach((swatch, index) => {
        swatch.style.background = colors[index];
      });
    }
    const currentColors = legendColorsFor(this.paletteKey, polarity);
    this.currentPaletteSwatchEls?.forEach((swatch, index) => {
      swatch.style.background = currentColors[index];
    });
  }

  syncOutlineToggle() {
    if (this.outlineToggle) this.outlineToggle.checked = this.areaOutlinesEnabled;
  }

  syncProjectionSelector() {
    if (!this.mapChoiceDashboardEl) return;

    const selected = Math.max(0, PROJECTION_KEYS.indexOf(this.projectionKey));
    const projectionSwitch = this.mapChoiceDashboardEl.querySelector(".map-projection-switch");
    projectionSwitch?.style.setProperty("--selected", selected);
    this.projectionButtons.forEach((button, index) => {
      const active = index === selected;
      button.classList.toggle("is-selected", active);
      button.setAttribute("aria-checked", active ? "true" : "false");
      button.tabIndex = active ? 0 : -1;
    });
  }

  syncPaletteSelector() {
    if (!this.mapChoiceDashboardEl) return;

    const selected = Math.max(0, PALETTE_KEYS.indexOf(this.paletteKey));
    const list = this.mapChoiceDashboardEl.querySelector(".map-palette-list");
    list?.style.setProperty("--selected", selected);
    list?.style.setProperty("--column", selected % 2);
    list?.style.setProperty("--row", Math.floor(selected / 2));
    if (this.paletteSelect) this.paletteSelect.value = this.paletteKey;
    this.paletteButtons.forEach((button, index) => {
      const active = index === selected;
      button.classList.toggle("is-selected", active);
      button.setAttribute("aria-checked", active ? "true" : "false");
      button.tabIndex = active ? 0 : -1;
    });
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

  initializeLegend() {
    const div = document.createElement("div");
    div.className = "map-legend";
    div.innerHTML = `
      <div class="legend-copy">
        <div class="legend-title"></div>
        <div class="legend-subtitle"></div>
        <!-- The way into the map's contents that does not go through the
             picture. MapDataController binds it; the button lives here because
             the legend is where "what am I looking at" already is. -->
        <button id="mapDataTableBtn" type="button" class="legend-data-button" aria-haspopup="dialog">
          Data table
        </button>
      </div>
      <div class="legend-scale">
        <div class="legend-bar"></div>
        <div class="legend-labels"><span></span><span></span></div>
        <p class="legend-nodata">
          <span class="legend-nodata-swatch" aria-hidden="true"></span>
          <span>No data</span>
        </p>
        <div class="legend-note"></div>
      </div>`;

    this.legendTitleEl = div.querySelector(".legend-title");
    this.legendSubtitleEl = div.querySelector(".legend-subtitle");
    this.legendBarEl = div.querySelector(".legend-bar");
    this.legendLowEl = div.querySelector(".legend-labels span:first-child");
    this.legendHighEl = div.querySelector(".legend-labels span:last-child");
    this.legendNoteEl = div.querySelector(".legend-note");
    this.legendNoDataEl = div.querySelector(".legend-nodata");
    // A country with no value for this variable and year is simply not drawn,
    // and neither is its outline, so what shows through is the land basemap.
    // That reads as a colour on the map but was not one the legend spoke for,
    // which left the cream over Greenland or Antarctica looking like a shade
    // the ramp had run out of. The swatch is painted from the basemap's own
    // colour so the two cannot drift apart.
    const noDataNote =
      "Areas with no value for this variable and year keep the plain land colour — no hexagons and no outline.";
    this.legendNoDataEl.title = noDataNote;
    // A `title` is a mouse affordance: it never reaches the keyboard, and this
    // element is not focusable to begin with. The sentence is the only thing
    // that says what the cream on the map means, so it is in the text as well.
    const noDataText = document.createElement("span");
    noDataText.className = "visually-hidden";
    noDataText.textContent = ` — ${noDataNote}`;
    this.legendNoDataEl.appendChild(noDataText);
    this.legend = div;
    this.legend.style.setProperty("--land-basemap", LAND_BASEMAP_COLOR);
    this.legendDock.append(div);

    // The swatches are built once and only recoloured afterwards: rebuilding the
    // bar per refresh would drop the focus and the hover the tooltip hangs off.
    //
    // `role="img"` with a tab stop rather than a button: there is nothing to
    // activate, the card is a reading of the swatch and not an action on it.
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
    const variableTitle = this.metadataController.getVariableTitle(this.state.dataset, this.state.variable);
    const datasetMeta = this.meta.datasets[this.state.dataset];
    const datasetTitle = datasetMeta?.title || datasetMeta?.label || this.state.dataset;
    const polarity = this.metadataController.getActivePolarity();
    const legendColors = this.legendColorsForPolarity(polarity);
    this.syncPaletteSwatches();

    if (this.legendTitleEl) this.legendTitleEl.textContent = text.title;
    if (this.legendSubtitleEl) {
      this.legendSubtitleEl.textContent = `${variableTitle} (${this.state.variable}) - ${datasetTitle}, ${this.state.year}`;
    }
    // Swatch i always stands for quantile class i + 1, low to high: the mapfile
    // reorders the classes per polarity, and reversing the colours here is what
    // keeps the bar reading left-to-right low-to-high whichever way it does.
    this.legendSwatchEls.forEach((swatch, index) => {
      swatch.style.background = legendColors[index];
    });
    // Whatever is already known for this variable-year; the request started
    // below (or an earlier hover's) rewrites them when it lands.
    this.applyLegendSwatchLabels(this.getCachedClassBreaks());
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
      directionHint: this.legendDirectionHint(polarity),
      polarity,
      classCount: this.classCountForBreaks(),
      paletteLabel: getPalette(this.paletteKey).label,
      projectionTitle: this.projection?.title || this.projectionKey,
      noDataNote: "Areas with no value for this variable and year are drawn as plain land, with no hexagons.",
    };
  }

  // The bar reads low-to-high left to right in every scheme. A scheme that
  // honours polarity has its signed band reversed for positive polarity here,
  // and the mapfile does the same reversal in SQL (`base + (8 - class_idx)`),
  // so the bar and the map cannot disagree about which end is which.
  legendColorsForPolarity(polarity) {
    return legendColorsFor(this.paletteKey, polarity);
  }

  legendDirectionHint(polarity) {
    return directionHintFor(this.paletteKey, polarity);
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

  rebalanceLegendPosition() {
    this.map?.updateSize();
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

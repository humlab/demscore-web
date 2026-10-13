import { BaseController } from "./core/BaseController.js";
import { BackendClient } from "./core/BackendClient.js";
import { refreshIcons } from "./core/icons.js";
import { readMapSelection, writeMapSelection, readMapView, writeMapView } from "./core/preferences.js";
import { AboutController } from "./controllers/AboutController.js";
import { MetadataController } from "./controllers/MetadataController.js";
import { LayerPreloadController } from "./controllers/LayerPreloadController.js";
import { MapController } from "./controllers/MapController.js";
import { MapDataController } from "./controllers/MapDataController.js";
import { MapExportController } from "./controllers/MapExportController.js";
import { PanelCollapseController } from "./controllers/PanelCollapseController.js";
import { TableViewController } from "./controllers/TableViewController.js";

// The two readings of a year the app can be on. Map is the default: it is
// what this application is, and the table is the second way of reading the
// same `demscore.country_scores()` call.
const VIEW_KEYS = ["map", "table"];
const DEFAULT_VIEW_KEY = "map";

export class DemscoreApp extends BaseController {
  constructor() {
    super();

    this.backendClient = new BackendClient();

    this.meta = null;
    this.state = null;
    this.metadataController = null;
    this.mapController = null;
    this.mapDataController = null;
    this.tableViewController = null;
    this.aboutController = null;
    this.mapExportController = null;
    this.layerPreloadController = null;

    this.yearSlider = null;
    this.yearDisplay = null;
    this.yearDisplayHero = null;
    this.timelineSelectedMarker = null;
    this.timelineScale = null;
    this.timelinePreloadTrack = null;
    this.timelineWrap = null;
    this.yearPlayBtn = null;
    this.speedButton = null;
    this.speedPopup = null;
    this.speedOptions = [];
    this.speedActiveIndex = 0;
    this.speedDisplay = null;

    this.markerDragPointerId = null;
    this.applyYear = null;
    this.restartPreload = null;
    this.preloadSegments = [];
    this.preloadSnapshot = null;
    this.redrawTimelineScale = null;

    this.autoPlayTicket = 0;
    this.autoPlayWatchdog = null;
    // The tail of the read-ahead queue while it is standing aside for the map;
    // see takePreloadNetworkTurn.
    this.preloadNetworkTurn = Promise.resolve();
    // The mark the pointer is on and where the pointer was, so a cache state
    // arriving mid-hover can rewrite the card that is already open rather than
    // leaving it stale -- and rewrite it where it already is.
    this.hoveredSegment = null;
    this.markTooltipPointer = null;
    // How many countries each year of the variable on screen carries, from
    // /api/year-counts. `key` is dataset|variable; `counts` stays null until
    // the request lands, and the bars fall back to the strip's buckets until
    // then.
    this.yearCounts = null;

    this.AUTO_PLAY_MIN_SPEED = 1;
    this.AUTO_PLAY_MAX_SPEED = 8;
    // Each frame waits for the map to say the year is drawn, which is what lets
    // autoplay run at the speed tiles arrive rather than at a fixed rate it
    // cannot keep. A frame that never reports back would end the animation with
    // the button still reading "Pause", so the wait has a ceiling. MapController
    // has one of its own, below this; reaching this one means the answer was
    // lost rather than late -- a swap cancelled out from under the frame.
    this.AUTO_PLAY_FRAME_CEILING_MS = 12000;
    this.PRELOAD_SEGMENT_MAX_PX = 18;
    this.PRELOAD_SEGMENT_GAP_PX = 2;
    // The gap is at most this share of a year's slot, so on a long series --
    // V-Dem's 236 years in a few hundred pixels -- a year is still a visible
    // bar rather than a 1px sliver between two 2px gaps.
    this.PRELOAD_SEGMENT_GAP_SHARE = 0.3;
    this.TIMELINE_DENSE_TICK_SPAN = 24;
    // How tall a read-ahead mark is drawn, in the px the CSS reserves for the
    // band (`--coverage-band-height`). A mark for years that carry any data at
    // all is floored well clear of nothing, so a thin stretch reads as thin
    // rather than as absent -- absent is the hairline `.is-unavailable` draws.
    this.COVERAGE_BAND_PX = 20;
    this.COVERAGE_BAR_MIN_PX = 5;
    // Clearance around the two end-year labels. They are the ones that say what
    // the variable's span is, so where a ladder label lands on top of one it is
    // the ladder label that goes.
    this.TIMELINE_EDGE_LABEL_GAP_PX = 10;
    // How far below the band the mark card still answers: enough to cover the
    // tick marks and their labels, which are part of the same axis.
    this.TIMELINE_AXIS_HOVER_SLACK_PX = 34;
    this.TIMELINE_TOOLTIP_GAP_PX = 16;
    this.TOOLTIP_VIEWPORT_MARGIN_PX = 10;
  }

  async start() {
    await this.backendClient.hydrateRuntime();

    const [meta, legendMeta, polarityMeta, coverageMeta, topicsMeta, attributionMeta] = await Promise.all([
      this.backendClient.fetchJson("/api/config/variables", "Could not load variables config"),
      this.backendClient.fetchJson("/api/config/legend-semantics", "Could not load legend semantics config"),
      this.backendClient.fetchJson("/api/config/variable-polarity", "Could not load variable polarity config"),
      // Precomputed by scripts/build_variable_coverage.sh; the strips are decoration
      // on a list that works without them, so a missing file must not fail startup.
      this.backendClient
        .fetchJson("/api/config/variable-coverage", "Could not load variable coverage config")
        .catch(() => null),
      // Curated, hand-maintained, and only used to group a list that still works
      // ungrouped — so a missing file must not fail startup either.
      this.backendClient
        .fetchJson("/api/config/variable-topics", "Could not load variable topics config")
        .catch(() => null),
      // Generated by scripts/build_attribution.sh. A failure here must not stop
      // the app -- but it does cost the credit line its links and the dialog its
      // detail, so core/attribution.js falls back to naming the licensed sources
      // from a constant rather than to saying nothing.
      this.backendClient
        .fetchJson("/api/config/attribution", "Could not load attribution config")
        .catch(() => null),
    ]);

    if (!meta || typeof meta !== "object" || !meta.datasets || !meta.defaults) {
      throw new Error("web-backend variables payload is missing required datasets/defaults sections");
    }

    const storedSelection = readMapSelection();
    const storedDataset =
      storedSelection?.dataset && meta.datasets[storedSelection.dataset] ? storedSelection.dataset : null;
    const initialDataset = storedDataset || meta.defaults.dataset;
    const initialYear = storedDataset && Number.isInteger(storedSelection?.year)
      ? storedSelection.year
      : meta.defaults.year;

    this.meta = meta;
    this.state = {
      dataset: initialDataset,
      variable: storedDataset && typeof storedSelection?.variable === "string"
        ? storedSelection.variable
        : meta.defaults.variable,
      year: initialYear,
      // Which of the two readings of the year is on screen. Map is the default
      // for a first visit; after that it is whichever one the reader left it
      // on, like the projection and the colour scheme.
      view: readMapView(VIEW_KEYS, DEFAULT_VIEW_KEY),
      isAutoPlaying: false,
      autoPlaySpeed: 4,
      autoPlayTimer: null,
    };

    this.cacheTimelineElements();

    this.metadataController = new MetadataController({
      meta,
      polarityMeta,
      coverageMeta,
      topicsMeta,
      selectionPreference: storedSelection,
      state: this.state,
      backendClient: this.backendClient,
    });
    await this.metadataController.initialize();

    // Before the map, because the map's attribution control carries one of the
    // buttons that opens this dialog.
    this.aboutController = new AboutController({ meta, attributionMeta });
    this.aboutController.initialize();

    this.mapController = new MapController({
      state: this.state,
      meta,
      legendMeta,
      attributionMeta,
      mapServerBase: this.backendClient.mapServerBase,
      metadataController: this.metadataController,
      // Toggling the area outlines rewrites the tile URLs, so the preload has to
      // start over against the request the map is now making. Do it
      // immediately: until the run resets, the timeline marks are describing
      // the old URL even though the map is already asking for the new one.
      onLayerParamsChange: () => this.startReadAhead(),
      // refreshLegend() is the one place every change of what the map draws
      // passes through, which is why the non-visual reading of the map hangs
      // off it rather than off each of the half-dozen callers.
      onStateChange: () => {
        this.mapDataController?.refresh();
        this.tableViewController?.refresh();
      },
      // The credit line asks about the boundaries, so that is the section it lands on.
      onOpenAttribution: (opener) => this.aboutController.open(opener, "boundary"),
      // The View switch in the map dashboard is one radiogroup over three
      // answers, two of them projections and the third the table. The map owns
      // the projections; `state.view` is owned here, so the third comes back.
      onViewChange: (view) => this.setView(view),
    });
    this.mapController.initialize();

    // After the map, because the dashboard it folds and the map-only button it
    // adds are both the map's. A panel going away changes how much of the pane
    // the table view has to keep clear of, so the insets are measured again.
    this.panelCollapseController = new PanelCollapseController({
      mapController: this.mapController,
      onLayoutChange: () => {
        this.syncTimelineInset();
        this.syncDashboardInset();
      },
    });
    this.panelCollapseController.initialize();

    this.mapDataController = new MapDataController({
      state: this.state,
      meta,
      metadataController: this.metadataController,
      mapController: this.mapController,
    });
    this.mapDataController.initialize();

    // After the map, because the class swatch in each row is painted from the
    // legend's own ramp -- the same colours, through the same polarity-aware
    // reversal, so the two views cannot end up describing one year in two
    // colour schemes.
    this.tableViewController = new TableViewController({
      state: this.state,
      meta,
      attributionMeta,
      metadataController: this.metadataController,
      mapController: this.mapController,
      // The read-ahead marks on the timeline are fed by whichever view is on
      // screen: tiles while the map is, rows while the table is. A mark means
      // "this year is ready" either way, and it would be a lie if it went on
      // describing tiles nobody is fetching.
      onPrefetchUpdate: (snapshot) => {
        if (this.state.view !== "table") return;
        this.renderPreloadState(snapshot);
      },
    });
    this.tableViewController.initialize();

    // The Download dialog. It draws from the selection as it stands when it
    // opens, so a running animation is stopped first: a video of years the
    // timeline is meanwhile walking past would be a picture of nothing in
    // particular.
    this.mapExportController = new MapExportController({
      state: this.state,
      meta,
      mapController: this.mapController,
      metadataController: this.metadataController,
      attributionMeta,
      getCoverage: () => this.getActiveTimelineCoverage(),
      onBeforeOpen: () => {
        if (this.state.isAutoPlaying) this.stopAutoPlay();
      },
    });
    this.mapExportController.initialize();

    this.layerPreloadController = new LayerPreloadController({
      state: this.state,
      metadataController: this.metadataController,
      mapController: this.mapController,
      cacheEnabled: this.backendClient.cacheEnabled,
      onUpdate: (snapshot) => {
        if (this.state.view !== "map") return;
        this.renderPreloadState(snapshot);
      },
      // Autoplay is the one time the map and the read-ahead want the same
      // MapServer at the same moment, and the map is the one somebody is
      // watching.
      waitForNetworkTurn: () => this.takePreloadNetworkTurn(),
    });
    await this.layerPreloadController.initialize();

    this.bindDomainEvents();
    this.bindTimelineEvents();

    this.refreshTimelineForActiveVariable();
    this.rememberMapSelection();

    this.renderSpeedOptions();
    this.renderAutoPlaySpeed();
    this.updatePlayButton();
    // Before the first refresh, so a remembered table view never opens a layer
    // swap it would cancel in the next statement. The layer the map was built
    // with has already asked for its tiles; this is about the second one.
    this.mapController.setDrawingEnabled(this.state.view === "map");
    this.mapController.refresh();

    // Last, and through the same path a click on the switcher takes, so there
    // is one statement of what each view turns on and off. A remembered table
    // view therefore never starts the tile read-ahead at all, rather than
    // starting it and cancelling it a moment later.
    this.syncViewSwitch();
    this.applyView({ initial: true });
  }

  // ---- the two views ------------------------------------------------------

  // How much of the top of the map pane the timeline is standing on.
  //
  // `.table-view` reads it for the padding that keeps its first rows out from
  // under the overlay.
  // Measured rather than written down: the overlay's height changes with the
  // window width and with the variable's year span.
  syncTimelineInset() {
    // Map-only hides the timeline, and then it stands on nothing.
    if (this.panelCollapseController?.isMapOnly()) {
      this.mapContainer.style.setProperty("--timeline-inset", "0px");
      this.mapController.setWorldFitInset("top", 0);
      return;
    }
    const height = this.timelineOverlayEl?.getBoundingClientRect().height;
    if (!Number.isFinite(height) || height <= 0) return;
    // The overlay's own top offset is 12px; the rest is the gutter between it
    // and the first thing below it.
    this.mapContainer.style.setProperty("--timeline-inset", `${Math.round(height) + 20}px`);
    this.mapController.setWorldFitInset("top", Math.round(height) + 20);
  }

  // ...and how much of the foot of it the map dashboard is standing on, for the
  // same reason: the dashboard floats over the map, so the map does not care,
  // but the table view is a document under it and its last rows would be read
  // through a translucent panel. Measured from the canvas rather than from the
  // pane, because the pane's own foot is a breakpoint away from the canvas's.
  syncDashboardInset() {
    const dashboard = this.mapController.getMapChoiceDashboard();
    if (!dashboard) return;
    // Map-only hides it outright, and a hidden element measures as a box at the
    // viewport's origin -- which would read as the dashboard covering the whole
    // canvas. Only the world fit cares then; the table view is not on screen.
    if (this.panelCollapseController?.isMapOnly() || dashboard.getClientRects().length === 0) {
      this.mapController.setWorldFitInset("bottom", 0);
      return;
    }
    const inset = this.mapCanvas.getBoundingClientRect().bottom - dashboard.getBoundingClientRect().top;
    if (!Number.isFinite(inset) || inset <= 0) return;
    this.mapContainer.style.setProperty("--dashboard-inset", `${Math.round(inset)}px`);
    this.mapController.setWorldFitInset("bottom", Math.round(inset));
  }

  // The switcher lives in the map dashboard now, built and bound by
  // MapController alongside the two projections it shares a radiogroup with.
  // What is left here is the half of the answer this class owns: `state.view`,
  // and what each view turns on and off.
  syncViewSwitch() {
    this.mapController.syncViewSelector();
  }

  setView(view) {
    if (!VIEW_KEYS.includes(view) || view === this.state.view) return;

    this.state.view = view;
    writeMapView(view);
    this.syncViewSwitch();
    this.applyView();
  }

  // What each view turns on and off. Both the switcher and startup come through
  // here, so there is one statement of it rather than two that have to agree.
  applyView({ initial = false } = {}) {
    const showingTable = this.state.view === "table";

    this.mapContainer.classList.toggle("is-table-view", showingTable);
    // Covered, not unmounted: OpenLayers keeps its view, its size and its zoom
    // while the table is over it. `inert` is what takes the hidden map out of
    // the tab order and out of the accessibility tree -- a canvas nobody can
    // see should not be somewhere the keyboard can land.
    this.mapCanvas.inert = showingTable;

    if (showingTable) {
      // The tile read-ahead is for tiles nobody is going to look at. Its marks
      // go with it: the table's own read-ahead takes over the timeline.
      this.layerPreloadController.cancel();
      this.mapController.setDrawingEnabled(false);
      this.tableViewController.activate();
    } else {
      this.tableViewController.deactivate();
      // Asks for the year the timeline has meanwhile moved to, which may be a
      // long way from the one the layer still holds.
      this.mapController.setDrawingEnabled(true);
      this.layerPreloadController.start();
    }

    if (initial) return;

    // A frame may be in flight against the view that has just been left, and
    // its answer would schedule the next year from a source that is no longer
    // pacing the animation. Retire it and take the next frame from the new one.
    if (this.state.isAutoPlaying) {
      this.autoPlayTicket += 1;
      this.scheduleAutoPlayTick();
    }
  }

  // What paces an autoplay frame, which is the view on screen: the map is done
  // when its tiles are drawn, the table when its rows are. Neither is a timer --
  // the animation runs at the rate the data arrives, so a slow stretch plays
  // slowly instead of skipping.
  // The read-ahead belongs to the view on screen, the same way the pacing does.
  // The map reads tiles ahead; the table reads rows ahead. Everything that used
  // to reach for the tile preloader by name comes through here instead, so a
  // reader in the table view never warms a tile.
  startReadAhead() {
    if (this.state.view === "table") {
      this.tableViewController.startPrefetch();
      return;
    }
    this.layerPreloadController.start();
  }

  advanceAutoPlayFrame(onReady) {
    if (this.state.view === "table") {
      this.tableViewController.advanceAutoPlayFrame(onReady);
      return;
    }
    this.mapController.advanceAutoPlayLayer(onReady);
  }

  cacheTimelineElements() {
    this.yearSlider = this.getEl("yearSlider");
    this.yearDisplay = this.getEl("yearDisplay");
    this.yearDisplayHero = this.getEl("yearDisplayHero");
    this.timelineSelectedMarker = this.getEl("timelineSelectedMarker");
    this.timelineScale = this.getEl("timelineScale");
    this.timelinePreloadTrack = this.getEl("timelinePreloadTrack");
    this.timelineMarkTooltip = this.getEl("timelineMarkTooltip");
    this.timelineWrap = this.getEl("timelineWrap");
    this.yearPlayBtn = this.getEl("yearPlayBtn");
    this.speedButton = this.getEl("speedButton");
    this.speedPopup = this.getEl("speedListbox");
    this.speedDisplay = this.getEl("speedDisplay");
    this.timelineOverlayEl = this.getEl("timeline-overlay");
    this.mapContainer = this.getEl("map");
    this.mapCanvas = this.getEl("mapCanvas");
  }

  bindDomainEvents() {
    this.metadataController.bindEvents({
      onBeforeDatasetChange: () => {
        this.stopAutoPlay();
      },
      onDatasetChange: async () => {
        this.refreshTimelineForActiveVariable();
        this.rememberMapSelection();
        this.mapController.refresh();
        this.startReadAhead();
      },
      onVariableChange: () => {
        this.refreshTimelineForActiveVariable();
        this.rememberMapSelection();
        this.mapController.refresh();
        this.startReadAhead();
      },
    });

    this.applyYear = this.debounce(() => this.mapController.refresh(), 400);
    this.restartPreload = this.debounce(() => this.startReadAhead(), 300);
    // Zoom is continuous and OpenLayers has no separate zoomend: moveend is
    // where a pan and a zoom both come to rest.
    this.mapController.getMap().on("moveend", () => this.restartPreload());
    this.redrawTimelineScale = this.debounce(() => {
      const coverage = this.getActiveTimelineCoverage();
      this.renderTimelineScale(coverage.yearMin, coverage.yearMax, coverage.availableYears);
    }, 150);
    window.addEventListener("resize", () => {
      this.updateTimelineMarker();
      this.redrawTimelineScale();
      this.syncTimelineInset();
      this.syncDashboardInset();
    });
  }

  bindTimelineEvents() {
    this.yearSlider.addEventListener("input", () => {
      const parsed = Number.parseInt(this.yearSlider.value, 10);
      this.scrubToYear(parsed, false);
    });

    this.yearSlider.addEventListener("change", () => {
      if (!this.state.isAutoPlaying) {
        this.restartPreload();
      }
    });

    this.yearPlayBtn.addEventListener("click", () => {
      if (this.state.isAutoPlaying) {
        this.stopAutoPlay();
      } else {
        this.startAutoPlay();
      }
    });

    // The overlay changes height when the timeline is rebuilt for a new
    // variable, not only when the window moves, so this watches the element
    // rather than the window alone.
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(() => this.syncTimelineInset()).observe(this.timelineOverlayEl);
      const dashboard = this.mapController.getMapChoiceDashboard();
      if (dashboard) new ResizeObserver(() => this.syncDashboardInset()).observe(dashboard);
      // The marks are laid out in pixels now (see buildPreloadSegmentLayout), so
      // a track that changes width without the window doing so -- the sidebar
      // folding away -- has to lay them out again rather than stretch them.
      let trackWidth = this.timelinePreloadTrack.clientWidth;
      new ResizeObserver(() => {
        const width = this.timelinePreloadTrack.clientWidth;
        if (width === trackWidth) return;
        trackWidth = width;
        this.redrawTimelineScale?.();
      }).observe(this.timelinePreloadTrack);
    }
    this.syncTimelineInset();
    this.syncDashboardInset();
    this.bindTimelineMarkTooltip();
    this.timelineSelectedMarker.addEventListener("pointerdown", (event) => this.startMarkerDrag(event));
    this.timelineSelectedMarker.addEventListener("pointermove", (event) => this.moveMarkerDrag(event));
    this.timelineSelectedMarker.addEventListener("pointerup", (event) => this.endMarkerDrag(event));
    this.timelineSelectedMarker.addEventListener("pointercancel", (event) => this.endMarkerDrag(event));

    this.bindSpeedDropdown();
  }

  getActiveTimelineCoverage() {
    const coverage = this.metadataController.getActiveVariableCoverage();
    if (coverage) return coverage;

    const ds = this.metadataController.getDatasetConfig();
    const yearMin = Number.isInteger(ds?.yearMin) ? ds.yearMin : Number(this.state.year);
    const yearMax = Number.isInteger(ds?.yearMax) ? ds.yearMax : yearMin;
    return {
      yearMin,
      yearMax,
      availableYears: Array.from({ length: Math.max(0, yearMax - yearMin + 1) }, (_value, index) => yearMin + index),
      countryCountsByYear: {},
    };
  }

  findNearestAvailableYear(targetYear, availableYears) {
    if (!Array.isArray(availableYears) || availableYears.length === 0) return targetYear;

    let nearest = availableYears[0];
    let nearestDelta = Math.abs(targetYear - nearest);
    for (const year of availableYears) {
      const delta = Math.abs(targetYear - year);
      if (delta < nearestDelta || (delta === nearestDelta && year > nearest)) {
        nearest = year;
        nearestDelta = delta;
      }
    }
    return nearest;
  }

  findNextAvailableYear(currentYear, availableYears) {
    if (!Array.isArray(availableYears)) return null;
    return availableYears.find((year) => year > currentYear) ?? null;
  }

  refreshTimelineForActiveVariable() {
    const coverage = this.getActiveTimelineCoverage();
    this.setTimelineBounds(coverage);
    void this.loadYearCounts();
  }

  // Per-year country counts for the variable on screen, for the hover card and
  // the bar heights. Asked once per variable; a response for a variable the
  // reader has already left is dropped. A failure leaves the counts null, which
  // is the bucketed strip and a card without a number -- what was there before.
  async loadYearCounts() {
    const { dataset, variable } = this.state;
    const key = `${dataset}|${variable}`;
    if (this.yearCounts?.key === key) return;
    this.yearCounts = { key, counts: null };

    let payload;
    try {
      const query = new URLSearchParams({ dataset, variable });
      payload = await this.backendClient.fetchJson(`/api/year-counts?${query}`, "Could not load year counts");
    } catch (error) {
      console.warn(error);
      return;
    }
    if (this.yearCounts?.key !== key || !payload?.counts) return;
    this.yearCounts.counts = payload.counts;

    this.applyCoverageHeights();
    if (this.hoveredSegment && !this.timelineMarkTooltip.hidden) {
      this.showMarkTooltip(this.hoveredSegment);
    }
  }

  // The count for one year of the variable on screen: a number, 0 for a year
  // with nothing, or undefined while the counts are not in yet.
  getYearCount(year) {
    const { dataset, variable } = this.state;
    if (this.yearCounts?.key !== `${dataset}|${variable}` || !this.yearCounts.counts) return undefined;
    return this.yearCounts.counts[year] ?? 0;
  }

  rememberMapSelection() {
    writeMapSelection({
      dataset: this.state.dataset,
      variable: this.state.variable,
      year: this.state.year,
    });
  }

  setTimelineBounds(coverage) {
    // coverage changes mean the preload run restarts, so the previous fill state no longer applies
    this.preloadSnapshot = null;
    const yearMin = coverage.yearMin;
    const yearMax = coverage.yearMax;
    const availableYears = coverage.availableYears;

    this.yearSlider.min = String(yearMin);
    this.yearSlider.max = String(yearMax);

    if (this.state.year < yearMin || this.state.year > yearMax) {
      this.state.year = Math.min(Math.max(this.state.year, yearMin), yearMax);
    }
    this.state.year = this.findNearestAvailableYear(this.state.year, availableYears);

    this.yearSlider.value = String(this.state.year);
    this.renderTimelineScale(yearMin, yearMax, availableYears);
    this.refreshYearDisplay({ coverage });

    if (this.state.isAutoPlaying && this.findNextAvailableYear(this.state.year, availableYears) === null) {
      this.stopAutoPlay();
    }
  }

  setYear(nextYear, immediate = false) {
    const coverage = this.getActiveTimelineCoverage();
    const bounded = Math.min(Math.max(nextYear, coverage.yearMin), coverage.yearMax);
    const clamped = this.findNearestAvailableYear(bounded, coverage.availableYears);
    if (clamped === this.state.year && !immediate) return false;

    this.state.year = clamped;
    this.yearSlider.value = String(this.state.year);
    // `bounded` is the year that was actually asked for; where it is not the
    // year we landed on, the slider says so instead of silently skipping.
    this.refreshYearDisplay({ coverage, requestedYear: bounded });
    this.rememberMapSelection();

    if (immediate) {
      this.mapController.refresh();
    } else {
      this.applyYear();
    }

    return true;
  }

  scrubToYear(parsedYear, immediateFinal = false) {
    if (Number.isNaN(parsedYear)) return;

    if (this.state.isAutoPlaying) {
      this.mapController.stopPendingLayerSwap();
      this.setYear(parsedYear, true);
      this.scheduleAutoPlayTick();
      return;
    }

    this.setYear(parsedYear, immediateFinal);
  }

  yearFromClientX(clientX) {
    const rect = this.timelineWrap.getBoundingClientRect();
    if (rect.width <= 0) return this.state.year;

    const rawPct = (clientX - rect.left) / rect.width;
    const pct = Math.max(0, Math.min(1, rawPct));
    const yearMin = Number.parseInt(this.yearSlider.min, 10);
    const yearMax = Number.parseInt(this.yearSlider.max, 10);

    if (!Number.isFinite(yearMin) || !Number.isFinite(yearMax)) return this.state.year;
    const span = yearMax - yearMin;
    return span > 0 ? Math.round(yearMin + pct * span) : yearMin;
  }

  // ---- The hover card on the read-ahead marks ----
  // The marks are one row doing two jobs -- how tall is how much data, how full
  // is how much is cached -- which buys back the height a second row cost but is
  // not something a reader can be expected to work out. So hovering one says it.
  //
  // The listener is on the wrap rather than on the marks: `#yearSlider` is
  // stretched over the whole wrap to catch scrub gestures, and the marks are
  // `pointer-events: none` so they do not eat them. Events from the slider bubble
  // to the wrap, so this reads them without taking any.
  bindTimelineMarkTooltip() {
    this.timelineWrap.addEventListener("pointermove", (event) => {
      // Touch and pen scrub; only a hovering mouse gets the card.
      if (event.pointerType && event.pointerType !== "mouse") return;
      if (this.markerDragPointerId !== null) return this.hideMarkTooltip();

      const segment = this.segmentAtClientX(event.clientX);
      if (!segment || !this.isNearTimelineAxis(event.clientY)) return this.hideMarkTooltip();
      this.markTooltipPointer = { x: event.clientX, y: event.clientY };
      this.showMarkTooltip(segment);
    });
    this.timelineWrap.addEventListener("pointerleave", () => this.hideMarkTooltip());
    this.timelineWrap.addEventListener("pointerdown", () => this.hideMarkTooltip());
  }

  // The band plus the ruler under it. Lower down, the wrap is still a scrub
  // surface but there is nothing there to explain -- it is the map.
  isNearTimelineAxis(clientY) {
    const band = this.timelinePreloadTrack.getBoundingClientRect();
    if (band.height <= 0) return false;
    return clientY >= band.top - 6 && clientY <= band.bottom + this.TIMELINE_AXIS_HOVER_SLACK_PX;
  }

  // One segment per year, so the year under the pointer is exactly one of them.
  segmentAtClientX(clientX) {
    if (this.preloadSegments.length === 0) return null;
    const year = this.yearFromClientX(clientX);
    return this.preloadSegments.find((segment) => segment.years.includes(year)) || null;
  }

  // The card says one thing about one year: how many countries the variable
  // has a value for in it. That is the same figure the legend's coverage and
  // the spoken summary give for the year on the map, counted the same way.
  describeSegmentData(segment) {
    const [year] = segment.years;
    if (segment.dataYears.length === 0) return "No data for this year";
    const count = this.getYearCount(year);
    if (count === undefined) return "Has data";
    return `${count} ${count === 1 ? "country" : "countries"} with data`;
  }

  // The year and its country count, and nothing else. It used to add the
  // read-ahead's state ("Map tiles ready", a leftover from debugging it) and a
  // note on what the bar heights mean; both went at the client's request.
  showMarkTooltip(segment) {
    this.timelineMarkTooltip.innerHTML = "";

    const heading = document.createElement("p");
    heading.className = "timeline-mark-tooltip-years";
    heading.textContent = String(segment.years[0]);
    this.timelineMarkTooltip.appendChild(heading);

    const item = document.createElement("p");
    item.className = "timeline-mark-tooltip-line";
    item.textContent = this.describeSegmentData(segment);
    this.timelineMarkTooltip.appendChild(item);

    this.timelineMarkTooltip.hidden = false;
    this.hoveredSegment = segment;
    this.positionMarkTooltip();
  }

  // Below the pointer and clamped to the window, the way a native tooltip would
  // sit. Above the pointer is not an option: the timeline is pinned to the top
  // of the map and there is nothing up there to put it in.
  positionMarkTooltip() {
    if (!this.markTooltipPointer) return;
    const { x: clientX, y: clientY } = this.markTooltipPointer;
    const box = this.timelineMarkTooltip.getBoundingClientRect();
    const margin = this.TOOLTIP_VIEWPORT_MARGIN_PX;
    const left = Math.min(
      Math.max(margin, clientX - box.width / 2),
      Math.max(margin, window.innerWidth - box.width - margin),
    );
    const top = Math.min(
      clientY + this.TIMELINE_TOOLTIP_GAP_PX,
      Math.max(margin, window.innerHeight - box.height - margin),
    );
    this.timelineMarkTooltip.style.left = `${Math.round(left)}px`;
    this.timelineMarkTooltip.style.top = `${Math.round(top)}px`;
  }

  hideMarkTooltip() {
    if (this.timelineMarkTooltip.hidden) return;
    this.timelineMarkTooltip.hidden = true;
    this.hoveredSegment = null;
    this.markTooltipPointer = null;
  }

  startMarkerDrag(event) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    this.markerDragPointerId = event.pointerId;
    this.timelineSelectedMarker.classList.add("is-dragging");

    if (this.timelineSelectedMarker.setPointerCapture) {
      this.timelineSelectedMarker.setPointerCapture(event.pointerId);
    }

    this.scrubToYear(this.yearFromClientX(event.clientX), false);
  }

  moveMarkerDrag(event) {
    if (this.markerDragPointerId === null || event.pointerId !== this.markerDragPointerId) return;
    event.preventDefault();
    this.scrubToYear(this.yearFromClientX(event.clientX), false);
  }

  endMarkerDrag(event) {
    if (this.markerDragPointerId === null || event.pointerId !== this.markerDragPointerId) return;
    event.preventDefault();
    this.scrubToYear(this.yearFromClientX(event.clientX), true);
    if (!this.state.isAutoPlaying) {
      this.restartPreload();
    }

    if (this.timelineSelectedMarker.hasPointerCapture?.(event.pointerId)) {
      this.timelineSelectedMarker.releasePointerCapture(event.pointerId);
    }

    this.markerDragPointerId = null;
    this.timelineSelectedMarker.classList.remove("is-dragging");
  }

  getAutoPlayStepMs() {
    const speed = Math.max(this.AUTO_PLAY_MIN_SPEED, Number(this.state.autoPlaySpeed) || this.AUTO_PLAY_MIN_SPEED);
    return Math.round(1000 / speed);
  }

  setAutoPlaySpeed(nextSpeed) {
    const parsed = Number(nextSpeed);
    if (!Number.isFinite(parsed)) return;

    const clamped = Math.min(this.AUTO_PLAY_MAX_SPEED, Math.max(this.AUTO_PLAY_MIN_SPEED, Math.round(parsed)));
    if (clamped === this.state.autoPlaySpeed) return;

    this.state.autoPlaySpeed = clamped;
    this.renderAutoPlaySpeed();
    if (this.state.isAutoPlaying) {
      this.scheduleAutoPlayTick();
    }
  }

  // ---- the speed dropdown ----
  //
  // The speed square is a button that opens a listbox of speeds under it -- the
  // select-only pattern, as in the Colours dropdown in MapController: the
  // listbox takes focus and points at its options with aria-activedescendant.

  describeSpeed(speed) {
    return `${speed} ${speed === 1 ? "year" : "years"} per second`;
  }

  renderSpeedOptions() {
    this.speedPopup.innerHTML = "";
    this.speedOptions = [];
    for (let speed = this.AUTO_PLAY_MIN_SPEED; speed <= this.AUTO_PLAY_MAX_SPEED; speed += 1) {
      const option = document.createElement("div");
      option.id = `speedOption-${speed}`;
      option.className = "speed-option";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      option.setAttribute("aria-label", this.describeSpeed(speed));
      option.dataset.speed = String(speed);
      option.textContent = `${speed}\u00d7`;
      this.speedPopup.appendChild(option);
      this.speedOptions.push(option);
    }
  }

  bindSpeedDropdown() {
    this.speedButton.addEventListener("click", () => {
      if (this.speedPopup.hidden) this.openSpeedPopup();
      else this.closeSpeedPopup(true);
    });
    this.speedButton.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      this.openSpeedPopup();
    });
    this.speedPopup.addEventListener("keydown", (event) => this.onSpeedPopupKeydown(event));
    this.speedPopup.addEventListener("focusout", (event) => {
      if (!this.speedButton.parentElement.contains(event.relatedTarget)) this.closeSpeedPopup(false);
    });
    // Delegated: the options are written after this runs (renderSpeedOptions).
    this.speedPopup.addEventListener("pointermove", (event) => {
      const index = this.speedOptions.indexOf(event.target.closest(".speed-option"));
      if (index >= 0 && index !== this.speedActiveIndex) this.setSpeedActive(index);
    });
    this.speedPopup.addEventListener("click", (event) => {
      const option = event.target.closest(".speed-option");
      if (!option) return;
      this.setAutoPlaySpeed(option.dataset.speed);
      this.closeSpeedPopup(true);
    });
    document.addEventListener("pointerdown", (event) => {
      if (!this.speedPopup.hidden && !this.speedButton.parentElement.contains(event.target)) this.closeSpeedPopup(false);
    });
  }

  openSpeedPopup() {
    this.speedPopup.hidden = false;
    this.speedButton.setAttribute("aria-expanded", "true");
    const current = this.speedOptions.findIndex((option) => Number(option.dataset.speed) === this.state.autoPlaySpeed);
    this.setSpeedActive(Math.max(0, current));
    this.speedPopup.focus();
  }

  // `returnFocus` when it was closed from inside (a choice, Escape); not when
  // focus or a click has already gone somewhere else.
  closeSpeedPopup(returnFocus) {
    if (this.speedPopup.hidden) return;
    this.speedPopup.hidden = true;
    this.speedButton.setAttribute("aria-expanded", "false");
    this.speedPopup.removeAttribute("aria-activedescendant");
    if (returnFocus) this.speedButton.focus();
  }

  setSpeedActive(index) {
    this.speedActiveIndex = index;
    this.speedOptions.forEach((option, optionIndex) => option.classList.toggle("is-active", optionIndex === index));
    const active = this.speedOptions[index];
    if (active) this.speedPopup.setAttribute("aria-activedescendant", active.id);
  }

  onSpeedPopupKeydown(event) {
    const last = this.speedOptions.length - 1;
    switch (event.key) {
      case "ArrowDown":
        this.setSpeedActive(Math.min(last, this.speedActiveIndex + 1));
        break;
      case "ArrowUp":
        this.setSpeedActive(Math.max(0, this.speedActiveIndex - 1));
        break;
      case "Home":
        this.setSpeedActive(0);
        break;
      case "End":
        this.setSpeedActive(last);
        break;
      case "Enter":
      case " ":
        this.setAutoPlaySpeed(this.speedOptions[this.speedActiveIndex]?.dataset.speed);
        this.closeSpeedPopup(true);
        break;
      case "Escape":
        // Held here: Escape is also what leaves map-only.
        event.stopPropagation();
        this.closeSpeedPopup(true);
        break;
      case "Tab":
        this.closeSpeedPopup(false);
        return;
      default:
        return;
    }
    event.preventDefault();
  }

  // The button's reading, its name and the selected option, from the one
  // number. The speed is years per second (getAutoPlayStepMs), so that is what
  // it is called.
  renderAutoPlaySpeed() {
    const speed = this.state.autoPlaySpeed;
    this.speedDisplay.textContent = `${speed}\u00d7`;
    this.speedButton.setAttribute("aria-label", `Animation speed: ${this.describeSpeed(speed)}`);
    for (const option of this.speedOptions) {
      option.setAttribute("aria-selected", Number(option.dataset.speed) === speed ? "true" : "false");
    }
  }

  clearAutoPlayTimer() {
    if (this.state.autoPlayTimer !== null) {
      window.clearTimeout(this.state.autoPlayTimer);
      this.state.autoPlayTimer = null;
    }
  }

  updatePlayButton() {
    const iconName = this.state.isAutoPlaying ? "pause" : "play";

    // Icon only, at the client's request: the word "Animate" is gone, so the
    // name lives in `aria-label` and, for the pointer, `title`.
    this.yearPlayBtn.innerHTML = `<i data-lucide="${iconName}" aria-hidden="true"></i>`;
    refreshIcons();

    this.yearPlayBtn.setAttribute("aria-label", this.state.isAutoPlaying ? "Pause timeline" : "Play timeline");
    this.yearPlayBtn.title = this.state.isAutoPlaying ? "Pause" : "Play";
  }

  // What the preloader asks before every request it has to go to MapServer for.
  //
  // The year on its way to the screen comes first: a request waits for the swap
  // to land, and for whatever read-ahead request is already out, so at most one
  // year nobody is looking at yet is ever being rendered ahead of the one they
  // are. Reading a year the cache already holds is not a request and never
  // waits, which is how the animation runs at full speed across what was
  // preloaded.
  //
  // Two things make a swap worth standing aside for, and they cover different
  // stretches of time. Every autoplay frame is one, so the whole animation is
  // held to a single read-ahead request at a time. Outside autoplay there are
  // only the occasional ones -- a variable, a dataset, a year, a zoom crossing a
  // hex stop -- and between them the read-ahead should run flat out, so the
  // question is asked of the map rather than assumed.
  //
  // It used to be assumed: outside autoplay the read-ahead never stood aside at
  // all. A variable change starts a run over every year in coverage, and its
  // requests go out before the map's, because loadNextLayer only reaches the
  // network on the next render frame where the run reaches it within a few
  // microtasks. Twelve fetches then held the connection pool -- six per origin
  // on HTTP/1.1 -- against tile loads the browser already ranks below them,
  // because OpenLayers loads tiles as detached Images. The year the user had
  // just asked for arrived a tile at a time behind a hundred-odd requests a
  // second for years they had not, and did not finish until the run did.
  async takePreloadNetworkTurn() {
    if (!this.state.isAutoPlaying && !this.mapController.hasPendingLayerSwap()) return null;

    const ahead = this.preloadNetworkTurn;
    let releaseTurn;
    this.preloadNetworkTurn = new Promise((resolve) => {
      releaseTurn = resolve;
    });

    await ahead;
    await this.mapController.whenLayerSwapSettles();

    return releaseTurn;
  }

  clearAutoPlayWatchdog() {
    if (this.autoPlayWatchdog === null) return;
    window.clearTimeout(this.autoPlayWatchdog);
    this.autoPlayWatchdog = null;
  }

  stopAutoPlay() {
    this.state.isAutoPlaying = false;
    this.clearAutoPlayTimer();
    // Any frame still waiting on the map belongs to the animation that is
    // ending, so its answer must not schedule a year after it.
    this.autoPlayTicket += 1;
    this.clearAutoPlayWatchdog();
    this.updatePlayButton();
    this.mapController.getContainer().classList.remove("autoplay-active");
    this.mapController.stopPendingLayerSwap();
  }

  scheduleAutoPlayTick() {
    this.clearAutoPlayTimer();
    this.clearAutoPlayWatchdog();
    if (!this.state.isAutoPlaying) return;

    this.state.autoPlayTimer = window.setTimeout(() => {
      if (!this.state.isAutoPlaying) return;

      const coverage = this.getActiveTimelineCoverage();
      const nextYear = this.findNextAvailableYear(this.state.year, coverage.availableYears);
      if (nextYear === null) {
        this.stopAutoPlay();
        return;
      }

      this.state.year = nextYear;
      this.yearSlider.value = String(this.state.year);
      this.refreshYearDisplay({ coverage });
      this.rememberMapSelection();
      this.mapController.refreshLegend();

      // The frame this tick is about to ask for. A scrub, a pause or a later
      // tick retires the ticket, so a late answer from a frame that has been
      // superseded cannot schedule a year on top of the one that replaced it.
      const ticket = (this.autoPlayTicket += 1);
      let continued = false;
      const continueAfterFrame = () => {
        if (continued || ticket !== this.autoPlayTicket) return;
        continued = true;
        if (this.state.isAutoPlaying) {
          this.scheduleAutoPlayTick();
        }
      };

      // The year is drawn, or it is given up on: either way the timeline moves.
      this.autoPlayWatchdog = window.setTimeout(continueAfterFrame, this.AUTO_PLAY_FRAME_CEILING_MS);
      this.advanceAutoPlayFrame(continueAfterFrame);
    }, this.getAutoPlayStepMs());
  }

  startAutoPlay() {
    const coverage = this.getActiveTimelineCoverage();
    if (this.findNextAvailableYear(this.state.year, coverage.availableYears) === null) {
      this.scrubToYear(coverage.availableYears[0] ?? coverage.yearMin, false);
    }

    this.state.isAutoPlaying = true;
    this.updatePlayButton();
    this.mapController.getContainer().classList.add("autoplay-active");
    // Pressing Animate mid-preload used to mean racing it: a dozen read-ahead
    // requests were already in flight, and the first frame queued behind them.
    // Restarting the run drops those, re-anchors the queue on the year the
    // animation starts from, and from here on the read-ahead waits its turn
    // (see waitForNetworkTurn). Years already cached keep their marks: the run
    // asks for the same thing, so it resumes rather than starts over.
    this.startReadAhead();
    this.scheduleAutoPlayTick();
  }

  refreshYearDisplay({ coverage = null, requestedYear = null } = {}) {
    const yearText = String(this.state.year);
    this.yearDisplay.textContent = yearText;
    this.yearDisplayHero.textContent = yearText;
    this.yearSlider.setAttribute("aria-valuetext", this.describeYear(this.state.year, coverage, requestedYear));
    this.updateTimelineMarker();
    this.highlightTimelineTick(this.state.year);
  }

  // What the slider says its value is, rather than the bare number a range
  // input announces on its own.
  //
  // The year axis runs over the whole dataset span while a variable often
  // covers a fraction of it, so a step of one on the slider can be a jump of
  // five on the map: `setYear` snaps to the nearest year that has data. On
  // screen the preload track shows which years those are; from the keyboard
  // there was nothing at all, and the value simply skipped. Saying that the
  // year moved further than asked is the whole point of this string.
  describeYear(year, coverage = null, requestedYear = null) {
    const available = (coverage || this.getActiveTimelineCoverage()).availableYears;
    if (!available.includes(year)) return `${year}, no data`;
    if (Number.isInteger(requestedYear) && requestedYear !== year) {
      return `${year}, nearest year with data`;
    }
    return String(year);
  }

  updateTimelineMarker() {
    const yearMin = Number.parseInt(this.yearSlider.min, 10);
    const yearMax = Number.parseInt(this.yearSlider.max, 10);
    const span = yearMax - yearMin;
    const pct = span > 0 ? ((this.state.year - yearMin) / span) * 100 : 50;
    const clampedPct = Math.max(0, Math.min(100, pct));
    this.timelineWrap.style.setProperty("--selected-pct", `${clampedPct}%`);
    this.highlightCurrentSegment();
  }

  // The year on the map is the one mark drawn in the playhead's colour, so
  // where the timeline is stands out of the run of marks around it even where
  // the marks are only a few pixels wide and the marker line is lost among them.
  highlightCurrentSegment() {
    for (const segment of this.preloadSegments) {
      segment.el?.classList.toggle("is-current", segment.years.includes(this.state.year));
    }
  }

  highlightTimelineTick(year) {
    const ticks = this.timelineScale.querySelectorAll(".timeline-tick");
    let closestTick = null;
    let closestDelta = Number.POSITIVE_INFINITY;

    for (const tick of ticks) {
      const tickYear = Number.parseInt(tick.dataset.year || "", 10);
      if (Number.isNaN(tickYear)) continue;
      const delta = Math.abs(tickYear - year);
      if (delta < closestDelta) {
        closestDelta = delta;
        closestTick = tick;
      }
    }

    for (const tick of ticks) {
      tick.classList.toggle("is-selected", tick === closestTick);
    }
  }

  buildTimelineTickYears(yearMin, yearMax) {
    if (yearMin > yearMax) return [];
    if (yearMin === yearMax) return [{ year: yearMin, major: true, edge: null }];

    const span = yearMax - yearMin;

    // Short spans get a tick on every year, endpoints included: the step ladder
    // below only ticks *inside* the range, which leaves a two-year dataset with
    // no scale at all.
    if (span <= this.TIMELINE_DENSE_TICK_SPAN) {
      const labelStep = Math.ceil((span + 1) / 6);
      return Array.from({ length: span + 1 }, (_value, offset) => {
        const year = yearMin + offset;
        return {
          year,
          major: offset % labelStep === 0 || year === yearMax,
          edge: year === yearMin ? "start" : year === yearMax ? "end" : null,
        };
      });
    }

    let minorStep;
    let majorStep;
    if (span <= 60) {
      minorStep = 5;
      majorStep = 10;
    } else if (span <= 150) {
      minorStep = 10;
      majorStep = 50;
    } else if (span <= 300) {
      minorStep = 25;
      majorStep = 50;
    } else {
      minorStep = 50;
      majorStep = 100;
    }

    const start = Math.ceil(yearMin / minorStep) * minorStep;
    const ticks = [{ year: yearMin, major: true, edge: "start" }];
    for (let y = start; y <= yearMax; y += minorStep) {
      if (y > yearMin && y < yearMax) {
        ticks.push({ year: y, major: y % majorStep === 0, edge: null });
      }
    }
    ticks.push({ year: yearMax, major: true, edge: "end" });

    // The ladder is a round-number scale and says nothing about the variable on
    // the map: for V-Dem it reads 1800..2000 whichever variable is selected, and
    // where a series actually begins and ends was left to be inferred from where
    // the marks stop. The two ends are the one part of the axis that is about
    // this variable, so they are always drawn and always labelled; a ladder
    // label that collides with one loses its label in renderTimelineScale.
    return ticks;
  }

  buildPreloadSegments(yearMin, yearMax, availableYearSet) {
    const yearCount = Math.max(1, yearMax - yearMin + 1);
    const span = Math.max(1, yearCount - 1);
    const trackWidth = this.timelinePreloadTrack.clientWidth || this.timelineWrap.clientWidth || 0;
    // Each box is centred on one slice of the year axis, so consecutive boxes sit
    // exactly one slice apart: (yearCount / segments) years through the same
    // year -> pixel scale the ticks use. Sizing them off trackWidth / (segments - 1)
    // overstated that distance and quietly ate into the gap between boxes.
    const pxPerYear = trackWidth / span;
    // One mark per year, always. They used to be buckets of several years once
    // the track was too narrow for a 14px mark each, and then a mark -- and the
    // card over it -- spoke for a span, so "how many countries in this year"
    // had no single answer. A long series now gets thin marks instead.
    const segmentCount = yearCount;
    const spacing = trackWidth > 0 ? pxPerYear : 0;
    const gap = Math.min(this.PRELOAD_SEGMENT_GAP_PX, spacing * this.PRELOAD_SEGMENT_GAP_SHARE);
    const boxWidth = spacing > 0
      ? Math.min(this.PRELOAD_SEGMENT_MAX_PX, spacing - gap)
      : this.PRELOAD_SEGMENT_MAX_PX;
    const layoutBox = this.buildPreloadSegmentLayout(trackWidth, yearCount, spacing, gap);

    const segments = [];
    for (let index = 0; index < segmentCount; index += 1) {
      const firstOffset = Math.floor((index * yearCount) / segmentCount);
      const lastOffset = Math.floor(((index + 1) * yearCount) / segmentCount) - 1;
      const years = [];
      for (let offset = firstOffset; offset <= lastOffset; offset += 1) {
        years.push(yearMin + offset);
      }
      // Drawn at the centre of the continuous slice, not at the midpoint of the
      // whole years it happens to hold: bucket sizes alternate between k and
      // k + 1 years, so integer midpoints jitter each box by up to half a year
      // and neighbours visibly bunch up and drift apart along the track.
      const centerYear = yearMin + ((index + 0.5) * yearCount) / segmentCount - 0.5;
      segments.push({
        years,
        centerYear,
        dataYears: years.filter((year) => availableYearSet.has(year)),
        box: layoutBox ? layoutBox(index) : null,
      });
    }

    // Whether the marks tile the track or stand apart as beads used to decide
    // whether a baseline was drawn behind them. The marks are bars now and the
    // floor is always there, so the spacing no longer changes anything.
    return { segments, boxWidth };
  }

  // Where each mark sits, in whole device pixels.
  //
  // The marks used to be placed at a percentage and centred with a transform, so
  // with a spacing like 12.3px every edge landed somewhere inside a pixel and was
  // antialiased there. A 2px gap then rendered as anything from a crisp pair of
  // pixels to a grey smear that closed it, depending on where it fell, and a long
  // series showed it as banding: runs of marks fused together, then a clean gap,
  // then another run.
  //
  // So every slot boundary is rounded to a device pixel first and each mark
  // fills its slot less the gap. The gap is one whole number of device pixels
  // everywhere, which is the regularity the eye reads; what absorbs the rounding
  // is the marks' width, which then differs by at most one device pixel between
  // neighbours. Where the slot is wider than a mark may be, the mark keeps its
  // fixed width and is centred in it instead. Returns null before the track has
  // a width, and the marks fall back to the stylesheet's percentage layout.
  buildPreloadSegmentLayout(trackWidth, yearCount, spacing, gap) {
    if (!(trackWidth > 0) || !(spacing > 0)) return null;
    const dpr = window.devicePixelRatio || 1;
    const toDevice = (px) => Math.round(px * dpr);
    const gapDevice = toDevice(gap);
    const maxDevice = toDevice(this.PRELOAD_SEGMENT_MAX_PX);
    const leadDevice = Math.floor(gapDevice / 2);
    // Mark i is centred on i * spacing, so its slot runs half a spacing either
    // side of that -- the first and last marks hang over the track's ends, as
    // they always have.
    const boundary = (index) => toDevice((index - 0.5) * spacing);

    return (index) => {
      const slotStart = boundary(index);
      const slotEnd = boundary(index + 1);
      let left = slotStart + leadDevice;
      let width = Math.max(1, slotEnd - slotStart - gapDevice);
      if (width > maxDevice) {
        left = toDevice(index * spacing) - Math.floor(maxDevice / 2);
        width = maxDevice;
      }
      return { left: left / dpr, width: width / dpr };
    };
  }

  // The year each of the precomputed strip's buckets starts at, built the same
  // way scripts/build_variable_coverage.sh cut them -- `yearMin + floor(i * span
  // / buckets)`, which spreads the remainder instead of piling it on the last
  // bucket. Rebuilding the edges rather than inverting that expression is the
  // only way to be sure a year lands in the bucket it was counted into.
  buildCoverageBucketEdges(yearMin, yearMax, buckets) {
    const span = yearMax - yearMin + 1;
    return Array.from({ length: buckets + 1 }, (_value, index) =>
      yearMin + Math.floor((index * span) / buckets),
    );
  }

  // How tall each read-ahead mark is drawn: the same coverage shape the variable
  // list draws under every row and the card shows in full, read out of the same
  // precomputed file, so one variable is one shape wherever it appears.
  //
  // The marks carry it rather than a row of their own. A bar above a box said
  // two things about the same years in two places, and the box's own fill was
  // already the second dimension this needed -- so the height is the coverage
  // and the fill is the cache.
  //
  // Per-year counts would be finer than the precomputed buckets, but
  // `countryCountsByYear` is a field the client reads and the backend has never
  // sent, and filling it for 165 variables would about triple a 163 KB config
  // fetch made on every load.
  //
  // Returns null when there is nothing to scale against -- no entry for this
  // variable, or a file whose years no longer match the ones the map is drawing.
  // Every mark then falls back to the flat `--track-height` the CSS gives it,
  // which is what the timeline looked like before any of this.
  buildCoverageHeightLookup(yearMin, yearMax) {
    // Exact per-year counts, once /api/year-counts has answered: the same ramp
    // the strip's digits are cut from (level = 1 + 8 * count / dataset max, see
    // scripts/build_variable_coverage.sh), only per year and unrounded, so a bar
    // here is its year and not the mean of the bucket it fell in.
    const datasetMax = this.metadataController.getCoverageDatasetMax(this.state.dataset);
    if (datasetMax && this.getYearCount(yearMin) !== undefined) {
      return (years) => {
        const counts = years.map((year) => this.getYearCount(year) || 0);
        const mean = counts.reduce((sum, value) => sum + value, 0) / counts.length;
        if (mean <= 0) return null;
        const ratio = Math.min(1, mean / datasetMax);
        return this.COVERAGE_BAR_MIN_PX + ratio * (this.COVERAGE_BAND_PX - this.COVERAGE_BAR_MIN_PX);
      };
    }

    const entry = this.metadataController.getCoverageStripData(this.state.dataset, this.state.variable);
    const buckets = entry?.levels?.length ?? 0;
    if (buckets === 0 || entry.yearMin !== yearMin || entry.yearMax !== yearMax) return null;

    const edges = this.buildCoverageBucketEdges(yearMin, yearMax, buckets);
    const levelAt = (year) => {
      for (let index = buckets - 1; index >= 0; index -= 1) {
        if (year >= edges[index]) return Number(entry.levels[index]);
      }
      return Number(entry.levels[0]);
    };

    // The strip's buckets are coarser than the read-ahead segments (about six
    // years against four), so a segment takes the mean of the buckets its years
    // fall in. That resamples a coarse signal onto finer columns; it repeats
    // detail rather than inventing it.
    return (years) => {
      const levels = years
        .filter((year) => year >= yearMin && year <= yearMax)
        .map(levelAt)
        .filter((level) => Number.isFinite(level));
      if (levels.length === 0) return null;

      const level = levels.reduce((sum, value) => sum + value, 0) / levels.length;
      if (level <= 0) return null;
      // Same ramp as the list strips, so a bar here and a bar there mean the
      // same thing: level 1 sits at the floor, level 9 fills the band.
      const height =
        this.COVERAGE_BAR_MIN_PX +
        ((Math.min(9, level) - 1) / 8) * (this.COVERAGE_BAND_PX - this.COVERAGE_BAR_MIN_PX);
      return Math.max(this.COVERAGE_BAR_MIN_PX, height);
    };
  }

  // Redraws the bar heights in place when the per-year counts land after the
  // scale was drawn. In place rather than through renderTimelineScale(), which
  // would throw away the read-ahead fill every bar is carrying.
  applyCoverageHeights() {
    if (this.preloadSegments.length === 0) return;
    const years = this.preloadSegments.flatMap((segment) => segment.years);
    const coverageHeight = this.buildCoverageHeightLookup(Math.min(...years), Math.max(...years));
    if (!coverageHeight) return;
    for (const segment of this.preloadSegments) {
      if (!segment.el || segment.dataYears.length === 0) continue;
      const height = coverageHeight(segment.years);
      if (height !== null) segment.el.style.height = `${height.toFixed(1)}px`;
    }
  }

  // The end-year labels are the point of the exercise, so a ladder label that
  // runs into one is dropped rather than moved: moving it would put a round
  // number somewhere it is not. Measured rather than estimated, because the
  // width of "1789" depends on the font the browser actually used.
  dropTimelineLabelsNearEdges() {
    const edgeLabels = [...this.timelineScale.querySelectorAll(".timeline-tick.is-edge-start, .timeline-tick.is-edge-end")]
      .map((tick) => tick.querySelector(".timeline-tick-label"))
      .filter(Boolean)
      .map((label) => label.getBoundingClientRect());
    if (edgeLabels.length === 0) return;

    for (const tick of this.timelineScale.querySelectorAll(".timeline-tick:not(.is-edge-start):not(.is-edge-end)")) {
      const label = tick.querySelector(".timeline-tick-label");
      if (!label) continue;
      const box = label.getBoundingClientRect();
      const collides = edgeLabels.some(
        (edge) =>
          box.left - this.TIMELINE_EDGE_LABEL_GAP_PX < edge.right &&
          box.right + this.TIMELINE_EDGE_LABEL_GAP_PX > edge.left,
      );
      // The mark stays: it is a year on the ladder either way, and only the
      // number had nowhere to go.
      if (collides) label.remove();
    }
  }

  renderTimelineScale(yearMin, yearMax, availableYears = []) {
    // The scale is about to exist, so the placeholder rule and the hidden marker
    // give way to it. Idempotent: every later redraw passes through here too.
    this.timelineWrap.classList.remove("is-awaiting-data");
    this.timelineScale.innerHTML = "";
    this.timelinePreloadTrack.innerHTML = "";
    this.preloadSegments = [];
    // The segments it pointed at are about to be replaced.
    this.hideMarkTooltip();
    const ticks = this.buildTimelineTickYears(yearMin, yearMax);
    const span = yearMax - yearMin;
    const availableYearSet = new Set(availableYears);
    // A single-year coverage has no span to spread over, so everything centres.
    const yearPct = (year) => (span > 0 ? ((year - yearMin) / span) * 100 : 50);

    const { segments, boxWidth } = this.buildPreloadSegments(yearMin, yearMax, availableYearSet);
    // on the wrap, not the track: marker positioning and segment sizing both
    // read this same value.
    this.timelineWrap.style.setProperty("--preload-box-width", `${boxWidth}px`);

    const coverageHeight = this.buildCoverageHeightLookup(yearMin, yearMax);
    for (const segment of segments) {
      segment.el = document.createElement("span");
      segment.el.className = `timeline-preload-segment${segment.dataYears.length > 0 ? "" : " is-unavailable"}`;
      if (segment.box) {
        segment.el.classList.add("is-pixel-snapped");
        segment.el.style.left = `${segment.box.left}px`;
        segment.el.style.width = `${segment.box.width}px`;
      } else {
        segment.el.style.left = `${yearPct(segment.centerYear)}%`;
      }
      segment.el.style.setProperty("--preload-progress", "0%");
      // Years with nothing to draw keep the hairline the stylesheet gives them:
      // a mark floored at the coverage minimum would claim data they do not have.
      const height = segment.dataYears.length > 0 && coverageHeight ? coverageHeight(segment.years) : null;
      if (height !== null) segment.el.style.height = `${height.toFixed(1)}px`;
      this.timelinePreloadTrack.appendChild(segment.el);
      this.preloadSegments.push(segment);
    }

    for (const { year, major, edge } of ticks) {
      const tick = document.createElement("div");
      tick.className = `timeline-tick${major ? " is-major" : ""}${edge ? ` is-edge-${edge}` : ""}`;
      tick.dataset.year = String(year);
      tick.style.left = `${yearPct(year)}%`;

      const mark = document.createElement("span");
      mark.className = "timeline-tick-mark";
      tick.appendChild(mark);

      if (major) {
        const label = document.createElement("span");
        label.className = "timeline-tick-label";
        label.textContent = String(year);
        tick.appendChild(label);
      }

      this.timelineScale.appendChild(tick);
    }

    this.dropTimelineLabelsNearEdges();
    this.highlightTimelineTick(this.state.year);
    this.highlightCurrentSegment();

    if (this.preloadSnapshot) {
      this.renderPreloadState(this.preloadSnapshot);
    }
  }

  renderPreloadState(snapshot) {
    this.preloadSnapshot = snapshot;
    const { statusByYear, progressByYear } = snapshot;

    for (const segment of this.preloadSegments) {
      const { el, dataYears } = segment;
      if (dataYears.length === 0) continue;

      let progressSum = 0;
      let loadedCount = 0;
      let failedCount = 0;
      let loadingCount = 0;
      for (const year of dataYears) {
        const yearStatus = statusByYear.get(year) || "pending";
        if (yearStatus === "loaded") {
          loadedCount += 1;
          progressSum += 1;
        } else if (yearStatus === "failed") {
          failedCount += 1;
        } else {
          if (yearStatus === "loading") loadingCount += 1;
          progressSum += progressByYear.get(year) || 0;
        }
      }

      const progress = Math.round((progressSum / dataYears.length) * 100);
      const isLoaded = loadedCount === dataYears.length;
      const isFailed = !isLoaded && failedCount > 0 && loadedCount + failedCount === dataYears.length;
      const isLoading = !isLoaded && !isFailed && (loadingCount > 0 || progress > 0);
      const status = isLoaded ? "loaded" : isFailed ? "failed" : isLoading ? "loading" : "pending";

      el.classList.toggle("is-loading", isLoading);
      el.classList.toggle("is-loaded", isLoaded);
      el.classList.toggle("is-failed", isFailed);
      el.style.setProperty("--preload-progress", `${isLoaded ? 100 : progress}%`);
      segment.preloadStatus = status;
      segment.preloadProgress = progress;
    }

    // A run finishing under an open card would otherwise leave it reading
    // "not cached yet" over a mark that has just filled in. It is redrawn where
    // the pointer left it, not where the card happens to be: the card is centred
    // on the pointer, so feeding its own box back in would walk it left by half
    // its width every time a tile arrived.
    if (this.hoveredSegment && !this.timelineMarkTooltip.hidden) {
      this.showMarkTooltip(this.hoveredSegment);
    }
  }
}

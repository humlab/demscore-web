import { BaseController } from "./core/BaseController.js";
import { BackendClient } from "./core/BackendClient.js";
import { MetadataController } from "./controllers/MetadataController.js";
import { LayerPreloadController } from "./controllers/LayerPreloadController.js";
import { MapController } from "./controllers/MapController.js";

export class DemscoreApp extends BaseController {
  constructor() {
    super();

    this.backendClient = new BackendClient();

    this.meta = null;
    this.state = null;
    this.metadataController = null;
    this.mapController = null;
    this.layerPreloadController = null;

    this.yearSlider = null;
    this.yearDisplay = null;
    this.yearDisplayHero = null;
    this.timelineSelectedMarker = null;
    this.timelineScale = null;
    this.timelinePreloadTrack = null;
    this.timelineWrap = null;
    this.yearPlayBtn = null;
    this.speedDownBtn = null;
    this.speedUpBtn = null;
    this.speedDisplay = null;

    this.markerDragPointerId = null;
    this.applyYear = null;
    this.restartPreload = null;
    this.preloadSegments = [];
    this.preloadSnapshot = null;
    this.redrawTimelineScale = null;

    this.AUTO_PLAY_MIN_SPEED = 1;
    this.AUTO_PLAY_MAX_SPEED = 8;
    this.PRELOAD_SEGMENT_MIN_PX = 14;
    this.PRELOAD_SEGMENT_MAX_PX = 18;
    this.PRELOAD_SEGMENT_GAP_PX = 2;
    this.TIMELINE_DENSE_TICK_SPAN = 24;
  }

  async start() {
    await this.backendClient.hydrateRuntime();

    const [meta, legendMeta, polarityMeta] = await Promise.all([
      this.backendClient.fetchJson("/api/config/variables", "Could not load variables config"),
      this.backendClient.fetchJson("/api/config/legend-semantics", "Could not load legend semantics config"),
      this.backendClient.fetchJson("/api/config/variable-polarity", "Could not load variable polarity config"),
    ]);

    if (!meta || typeof meta !== "object" || !meta.datasets || !meta.defaults) {
      throw new Error("web-backend variables payload is missing required datasets/defaults sections");
    }

    this.meta = meta;
    this.state = {
      dataset: meta.defaults.dataset,
      variable: meta.defaults.variable,
      mainVariable: null,
      year: meta.defaults.year,
      isAutoPlaying: false,
      autoPlaySpeed: 4,
      autoPlayTimer: null,
    };

    this.cacheTimelineElements();

    this.metadataController = new MetadataController({
      meta,
      polarityMeta,
      state: this.state,
      backendClient: this.backendClient,
    });
    await this.metadataController.initialize();

    this.mapController = new MapController({
      state: this.state,
      meta,
      legendMeta,
      mapServerBase: this.backendClient.mapServerBase,
      metadataController: this.metadataController,
    });
    this.mapController.initialize();

    this.layerPreloadController = new LayerPreloadController({
      state: this.state,
      metadataController: this.metadataController,
      mapController: this.mapController,
      onUpdate: (snapshot) => this.renderPreloadState(snapshot),
    });
    await this.layerPreloadController.initialize();

    this.bindDomainEvents();
    this.bindTimelineEvents();

    this.refreshTimelineForActiveVariable();

    this.speedDisplay.textContent = `${this.state.autoPlaySpeed}x`;
    this.updatePlayButton();
    this.mapController.refresh();
    this.layerPreloadController.start();
  }

  cacheTimelineElements() {
    this.yearSlider = this.getEl("yearSlider");
    this.yearDisplay = this.getEl("yearDisplay");
    this.yearDisplayHero = this.getEl("yearDisplayHero");
    this.timelineSelectedMarker = this.getEl("timelineSelectedMarker");
    this.timelineScale = this.getEl("timelineScale");
    this.timelinePreloadTrack = this.getEl("timelinePreloadTrack");
    this.timelineWrap = this.getEl("timelineWrap");
    this.yearPlayBtn = this.getEl("yearPlayBtn");
    this.speedDownBtn = this.getEl("speedDownBtn");
    this.speedUpBtn = this.getEl("speedUpBtn");
    this.speedDisplay = this.getEl("speedDisplay");
  }

  bindDomainEvents() {
    this.metadataController.bindEvents({
      onBeforeDatasetChange: () => {
        this.stopAutoPlay();
      },
      onDatasetChange: async () => {
        this.refreshTimelineForActiveVariable();
        this.mapController.refresh();
        this.layerPreloadController.start();
      },
      onVariableChange: () => {
        this.refreshTimelineForActiveVariable();
        this.mapController.refresh();
        this.layerPreloadController.start();
      },
    });

    this.applyYear = this.debounce(() => this.mapController.refresh(), 400);
    this.restartPreload = this.debounce(() => this.layerPreloadController.start(), 300);
    this.mapController.getMap().on("moveend zoomend", () => this.restartPreload());
    this.redrawTimelineScale = this.debounce(() => {
      const coverage = this.getActiveTimelineCoverage();
      this.renderTimelineScale(coverage.yearMin, coverage.yearMax, coverage.availableYears, coverage.countryCountsByYear);
    }, 150);
    window.addEventListener("resize", () => {
      this.updateTimelineMarker();
      this.redrawTimelineScale();
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

    this.timelineSelectedMarker.addEventListener("pointerdown", (event) => this.startMarkerDrag(event));
    this.timelineSelectedMarker.addEventListener("pointermove", (event) => this.moveMarkerDrag(event));
    this.timelineSelectedMarker.addEventListener("pointerup", (event) => this.endMarkerDrag(event));
    this.timelineSelectedMarker.addEventListener("pointercancel", (event) => this.endMarkerDrag(event));

    this.speedDownBtn.addEventListener("click", () => {
      this.setAutoPlaySpeed(this.state.autoPlaySpeed - 1);
    });

    this.speedUpBtn.addEventListener("click", () => {
      this.setAutoPlaySpeed(this.state.autoPlaySpeed + 1);
    });
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
    this.renderTimelineScale(yearMin, yearMax, availableYears, coverage.countryCountsByYear);
    this.refreshYearDisplay();

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
    this.refreshYearDisplay();

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
    this.speedDisplay.textContent = `${this.state.autoPlaySpeed}x`;
    if (this.state.isAutoPlaying) {
      this.scheduleAutoPlayTick();
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
    const label = this.state.isAutoPlaying ? "Pause" : "Animate";

    this.yearPlayBtn.innerHTML = `<i data-lucide="${iconName}" aria-hidden="true"></i><span>${label}</span>`;
    if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.lucide.createIcons();
    }

    this.yearPlayBtn.setAttribute("aria-label", this.state.isAutoPlaying ? "Pause timeline" : "Play timeline");
  }

  stopAutoPlay() {
    this.state.isAutoPlaying = false;
    this.clearAutoPlayTimer();
    this.updatePlayButton();
    L.DomUtil.removeClass(this.mapController.getContainer(), "autoplay-active");
    this.mapController.stopPendingLayerSwap();
  }

  scheduleAutoPlayTick() {
    this.clearAutoPlayTimer();
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
      this.refreshYearDisplay();
      this.mapController.refreshLegend();
      this.mapController.advanceAutoPlayLayer(() => {
        if (this.state.isAutoPlaying) {
          this.scheduleAutoPlayTick();
        }
      });
    }, this.getAutoPlayStepMs());
  }

  startAutoPlay() {
    const coverage = this.getActiveTimelineCoverage();
    if (this.findNextAvailableYear(this.state.year, coverage.availableYears) === null) {
      this.scrubToYear(coverage.availableYears[0] ?? coverage.yearMin, false);
    }

    this.state.isAutoPlaying = true;
    this.updatePlayButton();
    L.DomUtil.addClass(this.mapController.getContainer(), "autoplay-active");
    this.scheduleAutoPlayTick();
  }

  refreshYearDisplay() {
    const yearText = String(this.state.year);
    this.yearDisplay.textContent = yearText;
    this.yearDisplayHero.textContent = yearText;
    this.updateTimelineMarker();
    this.highlightTimelineTick(this.state.year);
  }

  updateTimelineMarker() {
    const yearMin = Number.parseInt(this.yearSlider.min, 10);
    const yearMax = Number.parseInt(this.yearSlider.max, 10);
    const span = yearMax - yearMin;
    const pct = span > 0 ? ((this.state.year - yearMin) / span) * 100 : 50;
    const clampedPct = Math.max(0, Math.min(100, pct));
    const wrapWidth = this.timelineWrap.clientWidth;
    const labelWidth = this.yearDisplayHero.offsetWidth;
    let labelOffset = 0;

    if (wrapWidth > 0 && labelWidth > 0) {
      const selectedLeft = (clampedPct / 100) * wrapWidth;
      const minLeft = labelWidth / 2;
      const maxLeft = Math.max(minLeft, wrapWidth - labelWidth / 2);
      labelOffset = Math.min(maxLeft, Math.max(minLeft, selectedLeft)) - selectedLeft;
    }

    this.timelineWrap.style.setProperty("--selected-pct", `${clampedPct}%`);
    this.timelineWrap.style.setProperty("--selected-label-offset", `${labelOffset}px`);
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
    const ticks = [];
    for (let y = start; y <= yearMax; y += minorStep) {
      if (y > yearMin && y < yearMax) {
        ticks.push({ year: y, major: y % majorStep === 0, edge: null });
      }
    }

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
    const fittingSegments = trackWidth > 0
      ? Math.floor((yearCount * pxPerYear) / this.PRELOAD_SEGMENT_MIN_PX)
      : yearCount;
    const segmentCount = Math.max(1, Math.min(yearCount, fittingSegments));
    const spacing = trackWidth > 0 ? (yearCount / segmentCount) * pxPerYear : 0;
    const boxWidth = spacing > 0
      ? Math.min(this.PRELOAD_SEGMENT_MAX_PX, spacing - this.PRELOAD_SEGMENT_GAP_PX)
      : this.PRELOAD_SEGMENT_MAX_PX;

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
      segments.push({ years, centerYear, dataYears: years.filter((year) => availableYearSet.has(year)) });
    }

    return {
      segments,
      boxWidth,
      // Too few years to tile the track: the boxes become beads and need a
      // baseline behind them, or the timeline stops reading as one axis.
      sparse: spacing <= 0 || boxWidth + this.PRELOAD_SEGMENT_GAP_PX < spacing - 0.5,
    };
  }

  describePreloadSegment(segment, status, progress) {
    const { years, dataYears, countryCount } = segment;
    const range = years[0] === years[years.length - 1] ? `${years[0]}` : `${years[0]}\u2013${years[years.length - 1]}`;

    if (dataYears.length === 0) return `${range}: no data`;

    const countries = Number.isFinite(countryCount)
      ? ` (${dataYears.length > 1 ? "up to " : ""}${countryCount} countries)`
      : "";
    if (status === "loaded") return `${range}: cached${countries}`;
    if (status === "failed") return `${range}: cache failed`;
    if (status === "loading") return `${range}: caching ${progress}%`;
    return `${range}: waiting${countries}`;
  }

  renderTimelineScale(yearMin, yearMax, availableYears = [], countryCountsByYear = {}) {
    this.timelineScale.innerHTML = "";
    this.timelinePreloadTrack.innerHTML = "";
    this.preloadSegments = [];
    const ticks = this.buildTimelineTickYears(yearMin, yearMax);
    const span = yearMax - yearMin;
    const availableYearSet = new Set(availableYears);
    // A single-year coverage has no span to spread over, so everything centres.
    const yearPct = (year) => (span > 0 ? ((year - yearMin) / span) * 100 : 50);

    const { segments, boxWidth, sparse } = this.buildPreloadSegments(yearMin, yearMax, availableYearSet);
    this.timelinePreloadTrack.classList.toggle("is-sparse", sparse);
    this.timelinePreloadTrack.style.setProperty("--preload-box-width", `${boxWidth}px`);

    for (const segment of segments) {
      const counts = segment.dataYears
        .map((year) => Number(countryCountsByYear[String(year)] ?? countryCountsByYear[year]))
        .filter((count) => Number.isFinite(count));
      segment.countryCount = counts.length > 0 ? Math.max(...counts) : null;
      segment.el = document.createElement("span");
      segment.el.className = `timeline-preload-segment${segment.dataYears.length > 0 ? "" : " is-unavailable"}`;
      segment.el.style.left = `${yearPct(segment.centerYear)}%`;
      segment.el.style.setProperty("--preload-progress", "0%");
      segment.el.title = this.describePreloadSegment(segment, "pending", 0);
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

    this.highlightTimelineTick(this.state.year);

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
      el.title = this.describePreloadSegment(segment, status, progress);
    }
  }
}

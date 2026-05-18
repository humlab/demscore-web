import { BaseController } from "./core/BaseController.js";
import { BackendClient } from "./core/BackendClient.js";
import { MetadataController } from "./controllers/MetadataController.js";
import { MapController } from "./controllers/MapController.js";

export class DemscoreApp extends BaseController {
  constructor() {
    super();

    this.backendClient = new BackendClient();

    this.meta = null;
    this.state = null;
    this.metadataController = null;
    this.mapController = null;

    this.yearSlider = null;
    this.yearDisplay = null;
    this.yearDisplayHero = null;
    this.timelineSelectedMarker = null;
    this.timelineScale = null;
    this.timelineWrap = null;
    this.yearPlayBtn = null;
    this.speedDownBtn = null;
    this.speedUpBtn = null;
    this.speedDisplay = null;

    this.markerDragPointerId = null;
    this.applyYear = null;

    this.AUTO_PLAY_MIN_SPEED = 1;
    this.AUTO_PLAY_MAX_SPEED = 4;
  }

  async start() {
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
      autoPlaySpeed: 1,
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

    this.bindDomainEvents();
    this.bindTimelineEvents();

    const initialDataset = this.metadataController.getDatasetConfig();
    this.setTimelineBounds(initialDataset.yearMin, initialDataset.yearMax);

    this.speedDisplay.textContent = `${this.state.autoPlaySpeed}x`;
    this.updatePlayButton();
    this.mapController.refresh();
  }

  cacheTimelineElements() {
    this.yearSlider = this.getEl("yearSlider");
    this.yearDisplay = this.getEl("yearDisplay");
    this.yearDisplayHero = this.getEl("yearDisplayHero");
    this.timelineSelectedMarker = this.getEl("timelineSelectedMarker");
    this.timelineScale = this.getEl("timelineScale");
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
        const ds = this.metadataController.getDatasetConfig();
        this.setTimelineBounds(ds.yearMin, ds.yearMax);
        this.mapController.refresh();
      },
      onVariableChange: () => {
        this.mapController.refresh();
      },
    });

    this.applyYear = this.debounce(() => this.mapController.refresh(), 400);
  }

  bindTimelineEvents() {
    this.yearSlider.addEventListener("input", () => {
      const parsed = Number.parseInt(this.yearSlider.value, 10);
      this.scrubToYear(parsed, false);
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

  setTimelineBounds(yearMin, yearMax) {
    this.yearSlider.min = String(yearMin);
    this.yearSlider.max = String(yearMax);

    if (this.state.year < yearMin || this.state.year > yearMax) {
      this.state.year = Math.min(Math.max(this.state.year, yearMin), yearMax);
    }

    this.yearSlider.value = String(this.state.year);
    this.renderTimelineScale(yearMin, yearMax);
    this.refreshYearDisplay();

    if (this.state.isAutoPlaying && this.state.year >= yearMax) {
      this.stopAutoPlay();
    }
  }

  setYear(nextYear, immediate = false) {
    const ds = this.metadataController.getDatasetConfig();
    const clamped = Math.min(Math.max(nextYear, ds.yearMin), ds.yearMax);
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

      const ds = this.metadataController.getDatasetConfig();
      if (this.state.year >= ds.yearMax) {
        this.stopAutoPlay();
        return;
      }

      this.state.year += 1;
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
    const ds = this.metadataController.getDatasetConfig();
    if (this.state.year >= ds.yearMax) {
      this.scrubToYear(ds.yearMin, false);
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
    const pct = span > 0 ? ((this.state.year - yearMin) / span) * 100 : 0;
    this.timelineWrap.style.setProperty("--selected-pct", `${Math.max(0, Math.min(100, pct))}%`);
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
    if (yearMin >= yearMax) return [];

    const span = yearMax - yearMin;
    let minorStep;
    let majorStep;
    if (span <= 20) {
      minorStep = 2;
      majorStep = 10;
    } else if (span <= 60) {
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
        ticks.push({ year: y, major: y % majorStep === 0 });
      }
    }

    return ticks;
  }

  renderTimelineScale(yearMin, yearMax) {
    this.timelineScale.innerHTML = "";
    const ticks = this.buildTimelineTickYears(yearMin, yearMax);
    const span = yearMax - yearMin;

    for (const { year, major } of ticks) {
      const tick = document.createElement("div");
      tick.className = `timeline-tick${major ? " is-major" : ""}`;
      tick.dataset.year = String(year);

      const pct = span > 0 ? ((year - yearMin) / span) * 100 : 0;
      tick.style.left = `${pct}%`;

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
  }
}

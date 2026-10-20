// The page keeps no tile cache of its own. The service worker's cache is the one
// that serves tiles, and its name is bumped by hand in sw.js and stamped with the
// map build id at build time, neither of which reaches this bundle -- a copy of
// the name here once stayed at v8 for twelve bumps, so the marks counted a cache
// nothing was served from. Hence caches.match(), which looks in every cache the
// origin has, and sw.js's activate leaves only the current one standing.
//
// The cache this page used to fill under that stale name. Deleted on start so
// its entries do not pass for hits before the next service worker update would
// have removed them.
const LEGACY_PAGE_CACHE_NAME = "demscore-wms-tile-cache-v8";
const MAX_CONCURRENT_YEARS = 3;
const MAX_CONCURRENT_REQUESTS = 4;
// How many targets keep their marks. The tiles themselves are kept by the
// browser cache and outlive the page; this only spares a revisited target the
// sweep from empty back to full while the run re-reads them. A zoom from the
// world view to MAX_ZOOM crosses 8 to 11 tile-grid stops (see
// TILE_GRID_ZOOM_STEP), and a target is also a dataset, a variable and a
// projection, so the number is set above a full zoom sweep rather than at it --
// an entry is two small Maps of years and costs nothing to keep.
const MAX_REMEMBERED_TARGETS = 16;

function isServiceWorkerSafeOrigin() {
  return (
    window.location.protocol === "https:" ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
  );
}

function buildYearQueue(availableYears, selectedYear) {
  const futureYears = availableYears.filter((year) => year >= selectedYear);
  const pastYears = availableYears.filter((year) => year < selectedYear).reverse();
  return [...futureYears, ...pastYears];
}

function buildContinuousYears(yearMin, yearMax) {
  const years = [];
  for (let year = yearMin; year <= yearMax; year += 1) {
    years.push(year);
  }
  return years;
}

export class LayerPreloadController {
  constructor({ state, metadataController, mapController, cacheEnabled, onUpdate, waitForNetworkTurn }) {
    this.state = state;
    this.metadataController = metadataController;
    this.mapController = mapController;
    this.cacheEnabled = cacheEnabled === true;
    this.onUpdate = onUpdate;
    // Asked before every request that has to go to MapServer, so the read-ahead
    // can be told to stand aside for the year the map is drawing. It resolves to
    // the way to hand the turn back, or to nothing when there was no queue to
    // join. Left out, the read-ahead never stands aside.
    this.waitForNetworkTurn =
      typeof waitForNetworkTurn === "function" ? waitForNetworkTurn : () => Promise.resolve(null);

    this.abortController = null;
    this.runId = 0;
    this.statusByYear = new Map();
    this.progressByYear = new Map();
    // What the last run was preloading. A run that asks for the same thing again
    // — the common case behind a window resize or a pan, which restart the run
    // only because the visible tile range moved — resumes the statuses it already
    // established instead of declaring every year uncached again.
    this.targetSignature = null;
    // The marks of targets seen earlier, keyed by the same signature, oldest
    // first. Zooming away and back asks for tiles the cache still holds, so the
    // marks are still true and are put back as they were rather than counted out
    // again from nothing. What is put back is still checked by the run that
    // follows, which is what catches a tile the cache has since evicted.
    this.marksByTarget = new Map();
  }

  async initialize() {
    if (!this.cacheEnabled) {
      await this.disableBrowserCache();
      return;
    }

    if ("serviceWorker" in navigator && isServiceWorkerSafeOrigin()) {
      try {
        await navigator.serviceWorker.register("./sw.js", { scope: "./" });
      } catch (error) {
        console.warn("Could not register WMS cache service worker", error);
      }
    }

    if ("caches" in window) {
      try {
        await caches.delete(LEGACY_PAGE_CACHE_NAME);
      } catch (error) {
        console.warn("Could not delete the old page-side WMS tile cache", error);
      }
    }
  }

  // Whether a tile this page fetches ends up somewhere it can be looked up again.
  // Only the service worker stores tiles, so a page it does not control -- the
  // first visit, before activate claims it, or a browser that refused the
  // registration -- has no tile cache, and the marks must not pretend otherwise.
  // Asked each time rather than once, because the first visit gains its
  // controller partway through.
  hasTileCache() {
    return "caches" in window && Boolean(navigator.serviceWorker?.controller);
  }

  async disableBrowserCache() {
    if ("serviceWorker" in navigator) {
      try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(
          registrations
            .filter((registration) => {
              const scriptUrl =
                registration.active?.scriptURL ||
                registration.waiting?.scriptURL ||
                registration.installing?.scriptURL ||
                "";
              return scriptUrl && new URL(scriptUrl).pathname.endsWith("/sw.js");
            })
            .map((registration) => registration.unregister()),
        );
      } catch (error) {
        console.warn("Could not unregister WMS cache service worker", error);
      }
    }

    if ("caches" in window) {
      try {
        const cacheNames = await caches.keys();
        await Promise.all(
          cacheNames
            .filter((name) => name.startsWith("demscore-wms-tile-cache-"))
            .map((name) => caches.delete(name)),
        );
      } catch (error) {
        console.warn("Could not clear WMS tile cache", error);
      }
    }
  }

  start() {
    this.cancel();
    if (!this.cacheEnabled) {
      this.statusByYear = new Map();
      this.progressByYear = new Map();
      this.emitUpdate();
      return;
    }

    const dataset = this.state.dataset;
    const variable = this.state.variable;
    const ds = this.metadataController.getDatasetConfig(dataset);
    if (!ds) return;

    const coverage = this.metadataController.getActiveVariableCoverage();
    const yearMin = Number(coverage?.yearMin ?? ds.yearMin);
    const yearMax = Number(coverage?.yearMax ?? ds.yearMax);
    if (!Number.isFinite(yearMin) || !Number.isFinite(yearMax) || yearMin > yearMax) return;

    const availableYears = Array.isArray(coverage?.availableYears) && coverage.availableYears.length > 0
      ? coverage.availableYears
      : buildContinuousYears(yearMin, yearMax);
    const selectedYear = Math.min(Math.max(Number(this.state.year) || yearMin, yearMin), yearMax);
    const years = buildYearQueue(availableYears, selectedYear);
    const polarity = this.metadataController.getActivePolarity();
    const hexSize = this.mapController.hexSizeFromZoom();
    const areaOutlines = this.mapController.getAreaOutlinesEnabled();
    // The projection is in the signature because it is in every tile URL: a
    // switch means a different SRS and a different BBOX, so none of the marks
    // from before it describe a tile that is still being asked for.
    const projection = this.mapController.getProjectionKey();
    // The tile-grid stop is in the signature for the same reason: every tile URL
    // names its own zoom and its own BBOX, so a zoom that lands on a different
    // stop leaves no tile from before it cached. Resuming there would show marks
    // for tiles nobody will ask for again, and they would be rewritten one year
    // at a time as the run caught up with them. The hex size alone does not
    // catch it -- one mesh size spans several stops. Zooming within a stop does
    // not change the tiles, so it still resumes, as a pan does.
    const tileZoom = this.mapController.getVisibleTileZoom();
    // A palette is part of every non-default tile URL.
    const palette = this.mapController.getPaletteKey();

    const signature = `${dataset}|${variable}|${polarity}|${palette}|${hexSize}|${areaOutlines}|${projection}|${tileZoom}|${yearMin}-${yearMax}|${years.length}`;

    this.rememberMarks();
    this.targetSignature = signature;
    // Without a tile cache nothing survives a restart, so there is nothing to
    // put back: every tile is fetched again and every year genuinely starts over.
    const remembered = this.hasTileCache() ? this.marksByTarget.get(signature) : null;

    this.abortController = new AbortController();
    const runId = ++this.runId;
    // Years that dropped out of coverage drop out of the marks with it.
    this.statusByYear = new Map(
      years.map((year) => [year, remembered?.statusByYear.get(year) || "pending"]),
    );
    this.progressByYear = new Map(
      years.map((year) => [year, remembered?.progressByYear.get(year) || 0]),
    );
    this.emitUpdate();

    void this.preloadYears(
      {
        dataset,
        variable,
        polarity,
        hexSize,
        years,
      },
      this.abortController.signal,
      runId,
    );
  }

  // Puts what the run has established so far away under the target it was for,
  // as the newest entry, and drops the oldest once there are too many.
  rememberMarks() {
    if (!this.hasTileCache() || !this.targetSignature || this.statusByYear.size === 0) return;

    this.marksByTarget.delete(this.targetSignature);
    this.marksByTarget.set(this.targetSignature, {
      statusByYear: new Map(this.statusByYear),
      progressByYear: new Map(this.progressByYear),
    });

    while (this.marksByTarget.size > MAX_REMEMBERED_TARGETS) {
      this.marksByTarget.delete(this.marksByTarget.keys().next().value);
    }
  }

  cancel() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  emitUpdate() {
    if (typeof this.onUpdate !== "function") return;

    this.onUpdate({
      statusByYear: new Map(this.statusByYear),
      progressByYear: new Map(this.progressByYear),
    });
  }

  async preloadYears(target, signal, runId) {
    let cursor = 0;
    const workerCount = Math.min(MAX_CONCURRENT_YEARS, target.years.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < target.years.length) {
        const year = target.years[cursor];
        cursor += 1;
        await this.preloadYear(target, year, signal, runId);
      }
    });

    await Promise.all(workers);
  }

  async preloadYear(target, year, signal, runId) {
    if (signal.aborted || runId !== this.runId) return;

    const urls = this.mapController.getVisibleWmsTileUrls({
      dataset: target.dataset,
      variable: target.variable,
      polarity: target.polarity,
      year: String(year),
      hex_size: String(target.hexSize),
    });

    // A year already cached stays marked cached while its tiles are re-checked;
    // only a tile the cache does not hold puts it back into loading (see
    // preloadTileUrls), because only then is it genuinely not preloaded.
    if (this.statusByYear.get(year) !== "loaded") {
      this.statusByYear.set(year, "loading");
      this.progressByYear.set(year, 0);
      this.emitUpdate();
    }

    try {
      await this.preloadTileUrls(urls, year, signal, runId);
      if (signal.aborted || runId !== this.runId) return;
      this.statusByYear.set(year, "loaded");
      this.progressByYear.set(year, 1);
    } catch (error) {
      if (signal.aborted || runId !== this.runId) return;
      console.warn(`Could not preload WMS tiles for ${target.dataset}.${target.variable} ${year}`, error);
      this.statusByYear.set(year, "failed");
    }

    this.emitUpdate();
  }

  async preloadTileUrls(urls, year, signal, runId) {
    if (urls.length === 0) {
      this.progressByYear.set(year, 1);
      return;
    }

    let completed = 0;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(MAX_CONCURRENT_REQUESTS, urls.length) }, async () => {
      while (cursor < urls.length) {
        const url = urls[cursor];
        cursor += 1;
        const wasCached = await this.preloadTileUrl(url, signal);

        completed += 1;
        if (runId !== this.runId || signal.aborted) return;
        // A miss means the year no longer covers what is on screen — the
        // viewport grew, or the cache lost the tile — so the mark drops back to
        // how much of it is actually there. A hit leaves a cached year alone.
        if (!wasCached && this.statusByYear.get(year) === "loaded") {
          this.statusByYear.set(year, "loading");
        }
        if (this.statusByYear.get(year) === "loaded") continue;
        this.progressByYear.set(year, completed / urls.length);
        this.emitUpdate();
      }
    });

    await Promise.all(workers);
  }

  // Resolves to whether the tile was already in the cache.
  async preloadTileUrl(url, signal) {
    if (this.hasTileCache()) {
      const cached = await caches.match(url, { ignoreVary: true });
      if (cached) return true;
    }

    // A miss is a MapServer render, and MapServer is also what the map itself is
    // waiting on whenever a year is on its way to the screen. Reading a cached
    // year ahead costs the map nothing and is never held up; fetching one waits
    // its turn. During autoplay that is what keeps the timeline moving at the
    // speed tiles arrive instead of behind a queue of years nobody is looking at
    // yet.
    const releaseTurn = await this.waitForNetworkTurn();

    try {
      // The service worker answers this and stores the tile itself, and only
      // when it is an image: MapServer reports a failed GetMap as a 200 with an
      // XML body, which a page-side put once stored and then counted as cached.
      const response = await fetch(url, {
        cache: "force-cache",
        signal,
      });

      if (!response.ok) {
        throw new Error(`WMS preload failed: ${response.status}`);
      }

      return false;
    } finally {
      // Including the throwing paths: a turn that is never handed back is one
      // the rest of the read-ahead waits on forever.
      if (typeof releaseTurn === "function") releaseTurn();
    }
  }
}

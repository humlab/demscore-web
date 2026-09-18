// Must match WMS_TILE_CACHE in sw.js, which is what evicts the older versions.
const PRELOAD_CACHE_NAME = "demscore-wms-tile-cache-v6";
const MAX_CONCURRENT_YEARS = 3;
const MAX_CONCURRENT_REQUESTS = 4;

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

    this.cache = null;
    this.abortController = null;
    this.runId = 0;
    this.statusByYear = new Map();
    this.progressByYear = new Map();
    // What the last run was preloading. A run that asks for the same thing again
    // — the common case behind a window resize or a pan, which restart the run
    // only because the visible tile range moved — resumes the statuses it already
    // established instead of declaring every year uncached again.
    this.targetSignature = null;
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
        this.cache = await caches.open(PRELOAD_CACHE_NAME);
      } catch (error) {
        console.warn("Could not open WMS tile cache", error);
      }
    }
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

    // Without a tile cache nothing survives a restart, so there is nothing to
    // resume: every tile is fetched again and every year genuinely starts over.
    const signature = `${dataset}|${variable}|${polarity}|${hexSize}|${areaOutlines}|${projection}|${yearMin}-${yearMax}|${years.length}`;
    const resume = Boolean(this.cache) && signature === this.targetSignature;
    this.targetSignature = signature;

    this.abortController = new AbortController();
    const runId = ++this.runId;
    // Years that dropped out of coverage drop out of the marks with it.
    this.statusByYear = new Map(
      years.map((year) => [year, (resume && this.statusByYear.get(year)) || "pending"]),
    );
    this.progressByYear = new Map(
      years.map((year) => [year, (resume && this.progressByYear.get(year)) || 0]),
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
    if (this.cache) {
      const cached = await this.cache.match(url, { ignoreVary: true });
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
      const response = await fetch(url, {
        cache: "force-cache",
        signal,
      });

      if (!response.ok) {
        throw new Error(`WMS preload failed: ${response.status}`);
      }

      if (this.cache) {
        await this.cache.put(url, response.clone());
      }

      return false;
    } finally {
      // Including the throwing paths: a turn that is never handed back is one
      // the rest of the read-ahead waits on forever.
      if (typeof releaseTurn === "function") releaseTurn();
    }
  }
}

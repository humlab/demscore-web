import { BaseController } from "../core/BaseController.js";
import { formatLegendValue } from "./MapController.js";
import { boundaryLabelFor } from "../core/attribution.js";
import { downloadCountryRowsCsv } from "../core/csv.js";

// The other way of showing the same thing.
//
// The map answers "where" and hides "how much by": a hexagon two shades darker
// than its neighbour is a difference of *some* size, and the only way to read it
// off the picture is to hover the legend and work backwards from a class span.
// This view answers the other question -- the numbers themselves, in an order the
// reader chooses -- from the same `demscore.country_scores()` call the hexagons
// are painted from, so the two can never disagree about what the year holds.
//
// It replaces the map rather than sitting beside it. Both want the whole pane,
// and a half-height map at a world view is not a map.
//
// ---- what makes it worth building rather than reusing the dialog ----
//
// `MapDataController`'s dialog already shows these rows, and it stays: it is the
// map's non-visual equivalent, opened over the map and closed again, and it does
// not move. This view is the other thing -- it is *on* while the year moves, so
// a ranking sorted by value reorders under the reader as the animation plays,
// which is a reading of the data neither the map nor a modal can give.

// One row per country, and the country table is 177 rows. The ceiling is here so
// that a countries table an order of magnitude larger cannot lock the browser up
// inside an animation loop, not because anything reaches it.
const MAX_ROWS = 2000;

// How many variable-years of rows to keep. A year is ~177 small objects, so this
// is about 35 000 of them at the ceiling -- cheap against what it buys, which is
// an animation that replays over ground it has already covered without touching
// the network. `/api/map-data` also carries `Cache-Control: max-age=3600`, so
// even a miss here is usually served by the browser rather than by the database.
const ROW_CACHE_LIMIT = 200;

// How many years the read-ahead fetches at once. The map's own read-ahead stands
// aside for the frame on its way to the screen (see
// DemscoreApp.takePreloadNetworkTurn); this one has no such contest to lose --
// these are small JSON reads against a different route from the tiles -- but
// three keeps it from monopolising the connection pool on HTTP/1.1.
const MAX_CONCURRENT_PREFETCH = 3;

// The movement budget. A row glides to its new place in this long, unless the
// animation is running faster than that, in which case the frame interval caps
// it: a row still travelling when the next year lands never arrives, and a table
// where nothing ever settles is harder to read than one that does not move.
const FLIP_MS = 380;
const FLIP_MIN_MS = 110;
const FLIP_FRAME_SHARE = 0.82;

const COLLATOR = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

// The upper end of the WMS year clamp, which the resolution policy also uses to
// close a period that has not ended. A row carrying it is current, not a claim
// about the twenty-second century.
const OPEN_ENDED_YEAR = 2100;

// The columns, as a described list rather than as markup, so the header, the
// body, the sort and the CSV are all built from one statement of what a column
// is. `rank` is the row's position in the current sort and is therefore the one
// column that cannot be sorted on -- see renderHead.
// `width` is what the <colgroup> is built from, and it is here rather than in
// the stylesheet so that one statement of a column carries everything about it.
// Country has none: under `table-layout: fixed` the column without a width takes
// whatever the others leave, which is what lets the longest names have the room.
// The rest are set wide enough for their worst case — "244" in the rank, a
// four-decimal value, a boundary label with a year span — because a fixed column
// clips rather than grows.
const COLUMNS = [
  { key: "rank", label: "#", numeric: true, sortable: false, srLabel: "Position in this sort", width: "3.5rem" },
  { key: "country", label: "Country", numeric: false, rowHeader: true, clips: true },
  { key: "iso3", label: "ISO3", numeric: false, width: "4.5rem" },
  { key: "value", label: "Value", numeric: true, width: "6rem" },
  {
    key: "classIndex",
    label: "Class",
    numeric: true,
    width: "5.5rem",
    // Said once, here, rather than in a summary line that redraws every frame.
    note: "Class 1 is the lowest seventh of the values, class 7 the highest.",
  },
  { key: "boundary", label: "Boundary", numeric: false, width: "15rem", clips: true },
];

export class TableViewController extends BaseController {
  constructor({ state, meta, attributionMeta, metadataController, mapController, onPrefetchUpdate }) {
    super();
    this.state = state;
    this.meta = meta;
    this.attributionMeta = attributionMeta || null;
    this.metadataController = metadataController;
    this.mapController = mapController;
    // The read-ahead marks on the timeline are fed from here while this view is
    // the one on screen, for the same reason they are fed from the tile
    // preloader while the map is: a mark that describes tiles nobody is
    // fetching is a mark that lies.
    this.onPrefetchUpdate = typeof onPrefetchUpdate === "function" ? onPrefetchUpdate : () => {};

    this.pane = this.getEl("tableView");
    this.summaryEl = this.getEl("tableViewSummary");
    this.selectionEl = this.getEl("tableViewSelection");
    this.coverageEl = this.getEl("tableViewCoverage");
    this.captionEl = this.getEl("tableViewCaption");
    this.headEl = this.getEl("tableViewHead");
    this.colsEl = this.getEl("tableViewCols");
    this.bodyEl = this.getEl("tableViewBody");
    this.scrollEl = this.getEl("tableViewScroll");
    this.noteEl = this.getEl("tableViewNote");
    this.downloadBtn = this.getEl("tableViewDownloadBtn");
    this.statusEl = this.getEl("tableViewStatus");

    this.active = false;
    this.sort = { column: "value", direction: "desc" };
    // Keyed `dataset|variable|year`, the same key the class breaks are cached
    // under, so the two caches can be reasoned about together.
    this.rowCache = new Map();
    this.rowRequests = new Map();
    // The `<tr>` that belongs to each row key, kept across years so a country
    // can be *moved* rather than redrawn -- which is the whole of the animation.
    this.rowEls = new Map();
    this.renderedKey = null;
    this.renderedOrder = [];
    this.renderedSort = null;
    this.rows = [];
    // What `advanceAutoPlayFrame` waits on: the render for the year the timeline
    // has just moved to.
    this.pendingRender = Promise.resolve();
    this.renderTicket = 0;

    this.prefetchRunId = 0;
    this.prefetchAbort = null;
    this.prefetchStatus = new Map();

    this.reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)") || null;
  }

  initialize() {
    this.headEl.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-column]");
      if (!button) return;
      this.applySort(button.dataset.column);
    });
    this.downloadBtn.addEventListener("click", () => this.downloadCsv());
    this.renderColumnWidths();
    this.renderHead();
  }

  // ---- being the view on screen ------------------------------------------

  isActive() {
    return this.active;
  }

  activate() {
    if (this.active) return;
    this.active = true;
    this.pane.hidden = false;
    // A view that was left and come back to should not replay the last
    // animation it was in the middle of.
    this.renderedKey = null;
    this.refresh();
    this.startPrefetch();
  }

  deactivate() {
    if (!this.active) return;
    this.active = false;
    this.pane.hidden = true;
    this.cancelPrefetch();
  }

  // ---- the current selection ---------------------------------------------

  currentKey() {
    return `${this.state.dataset}|${this.state.variable}|${this.state.year}`;
  }

  describeSelection() {
    const { dataset, variable, year } = this.state;
    return {
      dataset,
      variable,
      year,
      variableTitle: this.metadataController.getVariableTitle(dataset, variable),
      datasetTitle: this.metadataController.getDatasetTitle(this.meta.datasets?.[dataset], dataset),
    };
  }

  // Each summary line is written through here, and only here. Setting the text
  // and the `title` together is the whole reason: the line is clipped, so the
  // full sentence has to be somewhere, and a caller that set one without the
  // other would leave a truncated line with nothing behind it.
  setSummaryLine(el, text) {
    if (el.textContent === text) return;
    el.textContent = text;
    el.title = text;
  }

  // ---- refresh ------------------------------------------------------------

  // Hangs off the same `onStateChange` everything else that reads the map does:
  // `MapController.refreshLegend()` is the single place a change of dataset,
  // variable, year or polarity passes through, including an autoplay frame.
  refresh() {
    if (!this.active) return this.pendingRender;

    const key = this.currentKey();
    const { variableTitle, variable, datasetTitle, year } = this.describeSelection();
    // The class explanation lives in the caption rather than in the visible
    // summary: it is the same sentence at every year, and a line that redraws
    // eight times a second is the wrong place for something that never changes.
    // The caption is what a screen reader hears before the rows; the Class
    // header carries the same sentence as a `title` for everyone else.
    this.captionEl.textContent =
      `${variableTitle}, ${datasetTitle}, ${year}. ` +
      "Class 1 is the lowest seventh of the values, class 7 the highest.";
    this.setSummaryLine(this.selectionEl, `${variableTitle} (${variable}) — ${datasetTitle}, ${year}`);

    const cached = this.rowCache.get(key);
    if (cached) {
      // Synchronous where the rows are already in hand, which is what lets a
      // replayed stretch of the animation run at the speed the timer sets
      // rather than at the speed of a round trip.
      this.applyRows(key, cached);
      this.pendingRender = Promise.resolve();
      return this.pendingRender;
    }

    this.setSummaryLine(this.coverageEl, "Loading…");
    const ticket = (this.renderTicket += 1);
    this.pendingRender = this.ensureRows(key).then((payload) => {
      // A year that has been superseded must not paint over the one that
      // replaced it.
      if (ticket !== this.renderTicket) return;
      if (!payload) {
        this.setSummaryLine(this.coverageEl, "The table could not be loaded.");
        return;
      }
      this.applyRows(key, payload);
    });
    return this.pendingRender;
  }

  // What the autoplay tick waits on before scheduling the next year. The map's
  // equivalent waits for tiles to be drawn; here the frame is done when the rows
  // for it are on screen. `DemscoreApp` keeps a ceiling above this either way,
  // so a request that never answers cannot stop the timeline.
  advanceAutoPlayFrame(onReady) {
    const settle = this.pendingRender || Promise.resolve();
    settle.then(onReady, onReady);
  }

  applyRows(key, payload) {
    const without = payload.countriesTotal - payload.countriesWithData;
    // Counts first, prose after: the line is clipped from the right, so the
    // numbers — the part that changes with the year and the part anyone is
    // reading this line for — are the last thing an ellipsis would reach.
    this.setSummaryLine(
      this.coverageEl,
      `${payload.countriesWithData} of ${payload.countriesTotal} countries have a value` +
        `${without > 0 ? ` · ${without} with none this year` : ""}`,
    );

    this.rows = payload.rows;
    this.downloadBtn.disabled = payload.rows.length === 0;
    this.renderRows(key);
    this.renderNote();
  }

  // ---- fetching -----------------------------------------------------------

  ensureRows(key) {
    const cached = this.rowCache.get(key);
    if (cached) return Promise.resolve(cached);
    const inFlight = this.rowRequests.get(key);
    if (inFlight) return inFlight;

    const request = this.fetchRows(key)
      .then((payload) => {
        if (payload) this.rememberRows(key, payload);
        return payload;
      })
      .finally(() => this.rowRequests.delete(key));

    this.rowRequests.set(key, request);
    return request;
  }

  async fetchRows(key, signal = undefined) {
    const [dataset, variable, year] = key.split("|");
    const query = new URLSearchParams({ dataset, variable, year });
    try {
      const response = await fetch(`/api/map-data?${query}`, { signal });
      if (!response.ok) throw new Error(`Could not load table data: ${response.status}`);
      const payload = await response.json();
      return {
        classCount: Number.isFinite(payload?.classCount) ? payload.classCount : 7,
        countriesTotal: Number.isFinite(payload?.countriesTotal) ? payload.countriesTotal : 0,
        countriesWithData: Number.isFinite(payload?.countriesWithData) ? payload.countriesWithData : 0,
        rows: (Array.isArray(payload?.rows) ? payload.rows.slice(0, MAX_ROWS) : []).map((row) => ({
          ...row,
          // Resolved once here rather than per cell: the label is a lookup into
          // the attribution register and the table is redrawn every frame.
          boundary: this.describeBoundary(row),
          // What a `<tr>` is kept under between years. The country name is not
          // enough on its own: V-Dem codes a pre-partition Vietnam and a
          // northern one over the same nine years, and the historical registry
          // can carry several periods of one entity, so two rows may share a
          // name and must not share an element.
          rowKey: `${row.country}\u0000${row.validFromYear ?? ""}`,
        })),
      };
    } catch (error) {
      if (error?.name === "AbortError") return null;
      console.error(error);
      return null;
    }
  }

  rememberRows(key, payload) {
    this.rowCache.set(key, payload);
    // Map iterates in insertion order, so the oldest entry is the first one out.
    while (this.rowCache.size > ROW_CACHE_LIMIT) {
      this.rowCache.delete(this.rowCache.keys().next().value);
    }
  }

  // ---- the read-ahead -----------------------------------------------------

  // The years around the one on screen, fetched ahead so the animation does not
  // stop at each of them. It is the table's counterpart to the tile preloader,
  // and it reports in the same shape, so the marks on the timeline go on meaning
  // "this year is ready" in either view.
  startPrefetch() {
    this.cancelPrefetch();
    if (!this.active) return;

    const coverage = this.metadataController.getActiveVariableCoverage();
    const years = Array.isArray(coverage?.availableYears) ? coverage.availableYears : [];
    if (years.length === 0) {
      this.prefetchStatus = new Map();
      this.emitPrefetchUpdate();
      return;
    }

    const selected = Number(this.state.year);
    const ahead = years.filter((year) => year >= selected);
    const behind = years.filter((year) => year < selected).reverse();
    const queue = [...ahead, ...behind];

    const dataset = this.state.dataset;
    const variable = this.state.variable;
    this.prefetchStatus = new Map(
      queue.map((year) => [
        year,
        this.rowCache.has(`${dataset}|${variable}|${year}`) ? "loaded" : "pending",
      ]),
    );
    this.emitPrefetchUpdate();

    this.prefetchAbort = new AbortController();
    const runId = (this.prefetchRunId += 1);
    void this.runPrefetch({ dataset, variable, queue }, this.prefetchAbort.signal, runId);
  }

  cancelPrefetch() {
    if (this.prefetchAbort) {
      this.prefetchAbort.abort();
      this.prefetchAbort = null;
    }
    this.prefetchRunId += 1;
  }

  async runPrefetch(target, signal, runId) {
    let cursor = 0;
    const workerCount = Math.min(MAX_CONCURRENT_PREFETCH, target.queue.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < target.queue.length) {
        const year = target.queue[cursor];
        cursor += 1;
        if (signal.aborted || runId !== this.prefetchRunId) return;

        const key = `${target.dataset}|${target.variable}|${year}`;
        if (this.rowCache.has(key)) {
          this.markPrefetch(year, "loaded", runId);
          continue;
        }

        this.markPrefetch(year, "loading", runId);
        const payload = await this.fetchRows(key, signal);
        if (signal.aborted || runId !== this.prefetchRunId) return;
        if (payload) this.rememberRows(key, payload);
        this.markPrefetch(year, payload ? "loaded" : "failed", runId);
      }
    });

    await Promise.all(workers);
  }

  markPrefetch(year, status, runId) {
    if (runId !== this.prefetchRunId) return;
    this.prefetchStatus.set(year, status);
    this.emitPrefetchUpdate();
  }

  // The tile preloader's snapshot shape, so `DemscoreApp.renderPreloadState`
  // takes either without knowing which view produced it. A year is either ready
  // or it is not -- there is one request behind it rather than a few dozen tiles
  // -- so the progress figure only ever reads 0 or 1.
  emitPrefetchUpdate() {
    const progressByYear = new Map();
    for (const [year, status] of this.prefetchStatus) {
      progressByYear.set(year, status === "loaded" ? 1 : 0);
    }
    this.onPrefetchUpdate({
      statusByYear: new Map(this.prefetchStatus),
      progressByYear,
    });
  }

  // ---- sorting ------------------------------------------------------------

  applySort(column) {
    const spec = COLUMNS.find((entry) => entry.key === column);
    if (!spec || spec.sortable === false) return;

    this.sort =
      this.sort.column === column
        ? { column, direction: this.sort.direction === "asc" ? "desc" : "asc" }
        : // A value column opens on the way a ranking is read -- highest first.
          // Everything else opens ascending, which is how a name or a code is
          // read.
          { column, direction: spec.numeric ? "desc" : "asc" };

    this.renderRows(this.renderedKey, { reason: "sort" });
    // The header is rebuilt by renderRows, so the button that was pressed no
    // longer exists; focus goes to its replacement rather than to the top of
    // the pane.
    this.headEl.querySelector(`button[data-column="${column}"]`)?.focus();
    this.announce(
      `Sorted by ${spec.label}, ${this.sort.direction === "asc" ? "ascending" : "descending"}.`,
    );
  }

  sortedRows() {
    const { column, direction } = this.sort;
    const sign = direction === "asc" ? 1 : -1;
    return [...this.rows].sort((a, b) => {
      const left = this.cellValue(a, column);
      const right = this.cellValue(b, column);
      // A country with no value sorts to the end whichever way the column is
      // pointing: "no data" is not a small number, and letting it act like one
      // would put every gap at the top of an ascending value sort -- and, in an
      // animation, would have the gaps swapping places with each other every
      // year while the countries that have values sat still.
      if (left === null && right === null) return COLLATOR.compare(a.country, b.country);
      if (left === null) return 1;
      if (right === null) return -1;
      if (typeof left === "number" && typeof right === "number") {
        return (left - right) * sign || COLLATOR.compare(a.country, b.country);
      }
      return COLLATOR.compare(String(left), String(right)) * sign || COLLATOR.compare(a.country, b.country);
    });
  }

  cellValue(row, column) {
    if (column === "rank") return null;
    const value = row[column];
    return value === undefined || value === null || value === "" ? null : value;
  }

  // ---- rendering ----------------------------------------------------------

  // Written once at startup. Under `table-layout: fixed` these are the only
  // widths the table has: nothing is measured, so no cell's contents can move a
  // column, and a rank crossing from 9 to 10 mid-animation shifts nothing.
  renderColumnWidths() {
    this.colsEl.innerHTML = "";
    for (const column of COLUMNS) {
      const col = document.createElement("col");
      // Stamped like the cells are: a column dropped at a narrow width has to
      // lose its <col> too, or `table-layout: fixed` goes on reserving the
      // width for cells that are no longer drawn and leaves a gap.
      col.dataset.column = column.key;
      if (column.width) col.style.width = column.width;
      this.colsEl.appendChild(col);
    }
  }

  // Rebuilt only when the sort has actually moved. It is six cells, so cost is
  // not the reason: a header redrawn on every frame of an animation takes the
  // focus off the sort button somebody is standing on, once a second.
  renderHead() {
    const signature = `${this.sort.column}|${this.sort.direction}`;
    if (signature === this.renderedSort) return;
    this.renderedSort = signature;

    const headRow = document.createElement("tr");
    for (const column of COLUMNS) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.className = column.numeric ? "is-numeric" : "";
      // The same stamp the body cells carry, so a column that has to go at a
      // narrow width goes from the header and the body in one rule rather than
      // in two that can drift apart.
      cell.dataset.column = column.key;
      // `aria-sort` belongs on the header cell, not on the button inside it,
      // and only the sorted column carries it -- "none" on every other column
      // is noise a reader has to hear five times over.
      if (this.sort.column === column.key) {
        cell.setAttribute("aria-sort", this.sort.direction === "asc" ? "ascending" : "descending");
      }

      if (column.sortable === false) {
        // Not a button, because there is nothing to press: the rank is the
        // position in whatever sort is in force, so "sort by rank" is either a
        // no-op or a contradiction. The header still needs a name, and "#" is
        // not one.
        const label = document.createElement("span");
        label.className = "table-view-head-static";
        label.setAttribute("aria-hidden", "true");
        label.textContent = column.label;
        cell.appendChild(label);
        const spoken = document.createElement("span");
        spoken.className = "visually-hidden";
        spoken.textContent = column.srLabel || column.label;
        cell.appendChild(spoken);
        headRow.appendChild(cell);
        continue;
      }

      const button = document.createElement("button");
      button.type = "button";
      button.dataset.column = column.key;
      button.className = "table-view-sort";
      const sorted = this.sort.column === column.key;
      const nextDirection = sorted && this.sort.direction === "asc" ? "descending" : "ascending";
      button.textContent = column.label;
      // The name says what pressing it will do, because that is what the reader
      // is deciding; `aria-sort` above says what it is doing now.
      button.setAttribute("aria-label", `${column.label}, sort ${nextDirection}`);
      // The explanation a column needs, on the column rather than in the
      // summary. `title` is a mouse affordance only, which is why the same
      // sentence is in the table's caption.
      if (column.note) button.title = column.note;
      if (sorted) button.classList.add(this.sort.direction === "asc" ? "is-asc" : "is-desc");
      cell.appendChild(button);
      headRow.appendChild(cell);
    }

    this.headEl.innerHTML = "";
    this.headEl.appendChild(headRow);
  }

  // Whether the rows may be *moved* into their new order rather than redrawn in
  // it. Only a year stepping within one variable is a movement: the rows are the
  // same countries and the reordering is the news. A new variable or dataset is a
  // different table that happens to share some country names, and sliding those
  // names around would be an animation of nothing.
  shouldAnimate(key, reason) {
    if (this.reducedMotion?.matches) return false;
    if (reason === "sort") return true;
    if (!this.renderedKey || !key) return false;
    const [dataset, variable] = key.split("|");
    const [lastDataset, lastVariable] = this.renderedKey.split("|");
    return dataset === lastDataset && variable === lastVariable;
  }

  // How long a row has to reach its new place. Capped by the frame interval
  // during an animation: a row still travelling when the next year lands never
  // arrives anywhere, and a table in which nothing settles cannot be read.
  flipDuration() {
    if (!this.state.isAutoPlaying) return FLIP_MS;
    const frameMs = 1000 / Math.max(1, Number(this.state.autoPlaySpeed) || 1);
    return Math.max(FLIP_MIN_MS, Math.min(FLIP_MS, Math.round(frameMs * FLIP_FRAME_SHARE)));
  }

  renderRows(key, { reason = "state" } = {}) {
    const order = this.sortedRows();
    const animate = this.shouldAnimate(key, reason);
    const legendColors = this.mapController.legendColorsForPolarity(
      this.metadataController.getActivePolarity(),
    );

    this.renderHead();

    // ---- FLIP, in four passes, each of which is all reads or all writes ----
    //
    // Interleaving a read of a row's position with a write to another row's
    // contents forces the browser to lay the whole table out again between
    // every pair, which at 177 rows and eight years a second is the difference
    // between an animation and a slideshow. So: write the cells, read where
    // every row is, write the new order, read where every row has landed, write
    // one transform each.

    // 1. Write: cell contents, and a `<tr>` for any row that is new.
    const seen = new Set();
    const trs = [];
    order.forEach((row, index) => {
      seen.add(row.rowKey);
      let tr = this.rowEls.get(row.rowKey);
      if (!tr) {
        tr = this.buildRow(row);
        this.rowEls.set(row.rowKey, tr);
        // A row that was not in the last year arrives rather than appearing --
        // a country whose series begins mid-animation, most often. A keyframe
        // rather than a transition, because there is no "before" position to
        // transition from; the class comes off when the keyframe has run, so a
        // later reorder of the same row cannot start it again.
        if (animate) {
          tr.classList.add("is-entering");
          tr.addEventListener("animationend", () => tr.classList.remove("is-entering"), { once: true });
        }
      }
      this.fillRow(tr, row, index + 1, legendColors);
      trs.push(tr);
    });

    for (const [rowKey, tr] of this.rowEls) {
      if (seen.has(rowKey)) continue;
      tr.remove();
      this.rowEls.delete(rowKey);
    }

    const orderKeys = order.map((row) => row.rowKey);
    // `!tr.isConnected` is the insurance rather than the usual case: a row built
    // in the pass above is only skipped here if the key order came out identical
    // to the last one, which cannot happen while a new row is in it. Getting it
    // wrong would leave a country built but never inserted, so it is checked
    // rather than reasoned about.
    const orderChanged =
      orderKeys.length !== this.renderedOrder.length ||
      orderKeys.some((rowKey, index) => rowKey !== this.renderedOrder[index]) ||
      trs.some((tr) => !tr.isConnected);

    if (!orderChanged) {
      this.renderedKey = key;
      return;
    }

    // 2. Read: where every row is now. `offsetTop` rather than a bounding rect
    //    because the table scrolls -- a rect is viewport-relative and would
    //    record the scroll position as part of the row's place.
    //
    //    A row still travelling from the year before is visually somewhere
    //    other than where the layout says it is: `offsetTop` ignores
    //    transforms, so without the second reading a reorder arriving mid-glide
    //    would snap the row to its layout position and then animate from there.
    //    The duration is capped below the frame interval so this is rare, but
    //    rare is not never -- a slow request bunches two frames together.
    const firstTops = animate
      ? trs.map((tr) => {
          if (!tr.isConnected) return null;
          const top = tr.offsetTop;
          if (!tr.classList.contains("is-moving")) return top;
          return top + new DOMMatrixReadOnly(window.getComputedStyle(tr).transform).m42;
        })
      : null;

    // 3. Write: the new order. `appendChild` on an element already in the tree
    //    moves it, so this is a reorder and not a rebuild, which is what lets a
    //    row keep its identity -- and its focus, and its selection -- across it.
    const fragment = document.createDocumentFragment();
    for (const tr of trs) fragment.appendChild(tr);
    this.bodyEl.appendChild(fragment);

    this.renderedKey = key;
    this.renderedOrder = orderKeys;

    if (!animate) return;

    // 4. Read: where every row has landed.
    const duration = this.flipDuration();
    const deltas = trs.map((tr, index) => {
      const from = firstTops[index];
      return from === null ? 0 : from - tr.offsetTop;
    });

    // 5. Write the inversion: each row is transformed visually back to where it
    //    was. `is-moving` carries the transition and is off here, so nothing
    //    animates into the inverted position -- it is simply where the row is.
    const moved = [];
    trs.forEach((tr, index) => {
      tr.classList.remove("is-moving");
      const delta = deltas[index];
      if (delta === 0) {
        tr.style.transform = "";
        return;
      }
      tr.style.setProperty("--flip-ms", `${duration}ms`);
      tr.style.transform = `translateY(${delta}px)`;
      moved.push(tr);
    });

    if (moved.length === 0) return;

    // 6. Flush the style, once for the whole table, so the inverted positions
    //    are what the browser holds as the "before" of the transition about to
    //    start. A requestAnimationFrame cannot stand in for this: rAF callbacks
    //    run *before* the style recalculation, so the invert and the play would
    //    both land in one recalculation and the rows would simply appear in
    //    their new places. This is the one deliberate forced layout in the pass.
    void this.bodyEl.offsetHeight;

    // 7. Play. Adding the transition and removing the transform together is
    //    enough: a transition reads its duration from the after-change style.
    for (const tr of moved) {
      tr.classList.add("is-moving");
      tr.style.transform = "";
    }
  }

  buildRow(row) {
    const tr = document.createElement("tr");
    tr.className = "table-view-row";
    tr.dataset.rowKey = row.rowKey;

    for (const column of COLUMNS) {
      const cell = document.createElement(column.rowHeader ? "th" : "td");
      if (column.rowHeader) cell.scope = "row";
      if (column.numeric) cell.className = "is-numeric";
      cell.dataset.column = column.key;
      if (column.key === "classIndex") {
        // The class swatch is the one place the two views touch: it is painted
        // from the same ramp the legend bar is, through the same
        // polarity-aware reversal, so a reader switching between map and table
        // is looking at one colour scheme rather than two that agree by
        // coincidence.
        const swatch = document.createElement("span");
        swatch.className = "table-view-swatch";
        swatch.setAttribute("aria-hidden", "true");
        cell.appendChild(swatch);
        cell.appendChild(document.createElement("span"));
      }
      tr.appendChild(cell);
    }

    return tr;
  }

  fillRow(tr, row, rank, legendColors) {
    const cells = tr.children;
    COLUMNS.forEach((column, index) => {
      const cell = cells[index];
      if (!cell) return;
      if (column.key === "classIndex") {
        const swatch = cell.firstChild;
        const text = cell.lastChild;
        const classIndex = Number.isInteger(row.classIndex) ? row.classIndex : null;
        const color = classIndex === null ? "" : legendColors[classIndex - 1] || "";
        swatch.style.background = color;
        swatch.classList.toggle("is-empty", classIndex === null);
        const next = classIndex === null ? "—" : String(classIndex);
        if (text.textContent !== next) text.textContent = next;
        return;
      }
      const next = this.cellText(row, column.key, rank);
      if (cell.textContent === next) return;
      cell.textContent = next;
      // The columns are fixed-width and clip, so anything that can be long
      // enough to reach the ellipsis says so in full on hover. Inside the
      // change guard: this runs once per cell that actually changed, not once
      // per cell per frame.
      if (column.clips) cell.title = next;
    });

    tr.classList.toggle("is-no-data", row.value === null);
  }

  cellText(row, column, rank) {
    if (column === "rank") return String(rank);
    if (column === "value") return row.value === null ? "—" : formatLegendValue(row.value);
    return row[column] || "—";
  }

  announce(message) {
    // Never during an animation: a year a second is the reader's own doing and
    // narrating it would drown out everything else on the page. The same rule
    // `MapDataController` follows, for the same reason.
    if (this.state.isAutoPlaying) return;
    this.statusEl.textContent = message;
  }

  // ---- provenance ---------------------------------------------------------

  // What a row's hexagons were cut from, as a reader would say it. A present-day
  // country gets the source alone; a historical coding unit gets the years the
  // outline is claimed for, because that is the part the picture cannot carry.
  describeBoundary(row) {
    const label = boundaryLabelFor(this.attributionMeta, row.geometrySource);
    if (!label) return "";
    if (!row.historical) return label;
    const from = row.validFromYear;
    const to = row.validToYear;
    if (!Number.isFinite(from)) return label;
    // The registry closes an open-ended period at the year clamp rather than
    // leaving it null, so 2100 is a sentinel and not a claim about 2100.
    if (!Number.isFinite(to) || to >= OPEN_ENDED_YEAR) return `${label} (from ${from})`;
    return `${label} (${from}–${to})`;
  }

  renderNote() {
    const counts = new Map();
    for (const row of this.rows) {
      const label = boundaryLabelFor(this.attributionMeta, row.geometrySource);
      if (!label) continue;
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    if (counts.size === 0) {
      this.noteEl.textContent = "";
      this.noteEl.title = "";
      return;
    }

    const listed = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => `${label} (${count})`)
      .join(", ");
    const note = `Boundaries in this view: ${listed}.`;
    this.noteEl.textContent = note;
    // One line, clipped: the list changes with the year, and a note that
    // wrapped would resize the scroller above it once a frame.
    this.noteEl.title = note;
  }

  // ---- download -----------------------------------------------------------

  // The same rows in the order they are being shown in, as a file. The file
  // itself is spelled in `core/csv.js`, shared with the data-table dialog, so
  // the two downloads cannot drift into two shapes.
  downloadCsv() {
    downloadCountryRowsCsv(this.sortedRows(), this.describeSelection());
  }
}

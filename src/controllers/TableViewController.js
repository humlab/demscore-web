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

// How many rows past each edge of the scroller still get a glide. A row that
// starts and ends outside the window is one nobody can watch move, and moving
// it costs the same as moving one they can: a transform, a transition, a
// stacking context and a repaint. At 245 rows and ~15 of them on screen this is
// the difference between animating 27 rows and animating all of them.
//
// The buffer is there so a row gliding in from just past the edge is already in
// motion when it arrives, rather than appearing at the boundary.
const FLIP_BAND_BUFFER_ROWS = 6;

// The marks a reader can put on rows, in the order they are handed out. Six,
// because following more than a handful of rows through a reordering is beyond
// what eyes do anyway, and because past that the colours stop being tellable
// apart -- they are deliberately muted, which is what makes several of them
// bearable on screen at once but also what limits how many can be distinct.
//
// Only the *names* are here; the colours themselves are in `styles.css` against
// `[data-follow-ink]`, which is where every other colour in this app is
// written. The name is what a reader hears, so the two have to be kept in step
// by hand -- there is no third place to generate them from.
const FOLLOW_INK_NAMES = ["blue", "red", "green", "amber", "purple", "teal"];

// The `table-view-row-in` keyframe's length in `styles.css`, which the cleanup
// timer has to outlast. Kept as a number here because the class has to come off
// whether or not the keyframe ever finished -- see buildRow.
const ROW_ENTER_MS = 260;

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
  // First, and beside the position it is about. It is not sortable for the same
  // reason `rank` is not: it *is* a reading of the sort, so sorting on it would
  // be a question about its own answer.
  {
    key: "change",
    label: "±",
    numeric: false,
    sortable: false,
    srLabel: "Change in position since the previous year",
    width: "2.6rem",
    note: "Whether the row moved up or down the table since the previous year this variable has data for.",
  },
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
    this.clearFollowBtn = this.getEl("tableViewClearFollowBtn");
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
    // The same order as a lookup, so a row's place last time is a map read
    // rather than an indexOf over 245 keys per row.
    this.renderedIndex = new Map();
    this.renderedSort = null;
    // The rows carrying a transform right now, and when the last batch of them
    // is due to have finished. One timestamp for the batch: they all share a
    // duration, so this answers "is anything still moving" without touching the
    // DOM.
    this.movingRows = new Set();
    this.glideEndsAt = 0;
    // Every row is one line tall, so one number places all of them. Measured
    // lazily and thrown away when the row count or the window changes.
    this.rowPitchValue = 0;
    this.rowPitchRows = 0;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.rows = [];
    // The rows the reader has marked, by `rowKey`, so a mark survives the year
    // stepping -- which is the whole point of it: a highlighted row is how you
    // keep your eye on one country while 177 of them change places. Not cleared
    // when the variable changes: the mark is on the country, not on the series.
    // rowKey -> which of FOLLOW_INK_NAMES it is marked with. A map rather than a
    // set because the mark now has a colour, and the colour is what makes two
    // marked rows tellable apart while they change places.
    this.followed = new Map();
    // Which row is the tab stop inside the body. A table of 177 focusable rows
    // cannot put 177 stops in the tab order, so exactly one carries it and the
    // arrow keys move it -- the roving pattern the variable list already uses.
    this.activeRowKey = null;
    // Where each row stood in the previous year, derived once per render rather
    // than per row and kept until either the year or the sort moves.
    this.previousPositions = { signature: null, year: null, positions: null };
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
    this.clearFollowBtn.addEventListener("click", () => {
      this.clearFollowed();
      // The button is about to be taken off screen, and focus left on a hidden
      // element goes to the document body. It goes back to the rows, which is
      // what the reader was working on.
      this.scrollEl.focus();
    });
    // Delegated, because every `<tr>` is kept and reordered rather than rebuilt
    // -- a listener per row would survive, but 177 of them for one behaviour is
    // 177 things to get wrong when a row is dropped.
    this.bodyEl.addEventListener("click", (event) => {
      const tr = event.target.closest("tr[data-row-key]");
      if (!tr || !this.bodyEl.contains(tr)) return;
      this.setActiveRow(tr.dataset.rowKey);
      this.toggleFollow(tr.dataset.rowKey);
    });
    // On the scroller rather than the body, so Escape clears the marks whether
    // the reader is standing on a row or on the scroll region itself -- the
    // region is a tab stop of its own and a keypress there never reaches the
    // rows below it.
    this.scrollEl.addEventListener("keydown", (event) => this.onRowKeydown(event));
    // The row pitch is the one measurement the animation rests on, and a resize
    // is the only thing besides the row count that can move it.
    window.addEventListener("resize", () => {
      this.rowPitchValue = 0;
    });
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
    // animation it was in the middle of, and the pane it comes back to may be a
    // different size from the one it left.
    this.renderedKey = null;
    this.rowPitchValue = 0;
    this.settleGlides();
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

  // ---- following a row ----------------------------------------------------

  // A mark on a country, kept across years and across sorts. It changes nothing
  // about the data and nothing about the map: it is there so a reader watching
  // an animation can keep hold of one row while the order rearranges under it,
  // which is the one thing this view does that the map cannot.
  toggleFollow(rowKey) {
    if (!rowKey) return;
    const wasFollowed = this.followed.has(rowKey);
    let ink = null;
    if (wasFollowed) {
      this.followed.delete(rowKey);
    } else {
      ink = this.nextFollowInk();
      this.followed.set(rowKey, ink);
    }

    const tr = this.rowEls.get(rowKey);
    if (tr) this.applyFollowState(tr, rowKey);
    this.syncFollowControls();

    const name = this.rows.find((row) => row.rowKey === rowKey)?.country || "Row";
    this.announce(
      wasFollowed ? `${name} no longer followed.` : `${name} followed, ${FOLLOW_INK_NAMES[ink]} mark.`,
    );
  }

  // The lowest colour nobody is using, so unmarking a row gives its colour back
  // rather than leaving a gap and walking the rest along. Past six, two rows
  // share one -- which is honest about what is left to distinguish rather than
  // inventing a seventh colour nobody could tell from the first.
  nextFollowInk() {
    const taken = new Set(this.followed.values());
    for (let index = 0; index < FOLLOW_INK_NAMES.length; index += 1) {
      if (!taken.has(index)) return index;
    }
    return this.followed.size % FOLLOW_INK_NAMES.length;
  }

  clearFollowed() {
    if (this.followed.size === 0) return;
    const count = this.followed.size;
    this.followed.clear();
    for (const [rowKey, tr] of this.rowEls) this.applyFollowState(tr, rowKey);
    this.syncFollowControls();
    this.announce(count === 1 ? "Row no longer followed." : `${count} rows no longer followed.`);
  }

  // The visible mark and the spoken one together, so neither can be set without
  // the other. The highlight is the whole feature for a reader watching the
  // animation; for one who is not watching it, the row has to say so in words.
  applyFollowState(tr, rowKey) {
    const ink = this.followed.get(rowKey);
    const wanted = ink === undefined ? "" : String(ink);
    // Guarded because fillRow calls this for every row of every frame: one
    // comparison, and nothing is written or queried for unless the mark has
    // actually moved. The attribute is both the state and the guard, so the two
    // cannot disagree.
    if ((tr.dataset.followInk ?? "") === wanted) return;

    const marker = tr.querySelector("[data-follow-marker]");
    if (wanted === "") {
      delete tr.dataset.followInk;
      tr.classList.remove("is-followed");
      if (marker) marker.textContent = "";
      return;
    }
    tr.dataset.followInk = wanted;
    tr.classList.add("is-followed");
    // The colour is named as well as shown. It is noise to a reader who cannot
    // see it -- but to one who can see colour and not detail, which is who the
    // mark is most use to, it is the difference between "one of my rows" and
    // "the one I was watching".
    if (marker) marker.textContent = ` (followed, ${FOLLOW_INK_NAMES[ink]})`;
  }

  // On screen only while it has something to undo, and carrying the count --
  // which is the one place the number of marks is written down, and the reason
  // it is a count and not a bare label.
  syncFollowControls() {
    const count = this.followed.size;
    this.clearFollowBtn.hidden = count === 0;
    const label = count === 0 ? "Deselect all" : `Deselect all (${count})`;
    if (this.clearFollowBtn.textContent !== label) this.clearFollowBtn.textContent = label;
  }

  // The roving tab stop. Exactly one row carries `tabindex=0`; everything else
  // is reachable from it with the arrow keys.
  setActiveRow(rowKey) {
    if (!rowKey || rowKey === this.activeRowKey) return;
    const previous = this.activeRowKey ? this.rowEls.get(this.activeRowKey) : null;
    if (previous) previous.tabIndex = -1;
    this.activeRowKey = rowKey;
    const next = this.rowEls.get(rowKey);
    if (next) next.tabIndex = 0;
  }

  syncRowTabStop(orderKeys) {
    // The row that had the stop may have left with the year -- a country whose
    // series ends -- in which case the stop goes to the top of the table rather
    // than nowhere.
    if (!this.activeRowKey || !this.rowEls.has(this.activeRowKey)) {
      this.activeRowKey = orderKeys[0] || null;
    }
    for (const [rowKey, tr] of this.rowEls) {
      const wanted = rowKey === this.activeRowKey ? 0 : -1;
      if (tr.tabIndex !== wanted) tr.tabIndex = wanted;
    }
  }

  onRowKeydown(event) {
    if (event.key === "Escape") {
      if (this.followed.size === 0) return;
      event.preventDefault();
      this.clearFollowed();
      return;
    }

    const tr = event.target.closest("tr[data-row-key]");
    if (!tr) return;

    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      this.toggleFollow(tr.dataset.rowKey);
      return;
    }

    const rows = Array.from(this.bodyEl.children);
    const index = rows.indexOf(tr);
    if (index === -1) return;
    let next = index;
    if (event.key === "ArrowDown") next = Math.min(rows.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    else return;

    event.preventDefault();
    const target = rows[next];
    this.setActiveRow(target.dataset.rowKey);
    target.focus();
    // `nearest`, so moving one row down scrolls by one row rather than
    // recentring the whole table under the reader.
    target.scrollIntoView({ block: "nearest" });
  }

  // ---- the year before ----------------------------------------------------

  // The previous year *this variable has data for*, which is not always the year
  // before: QoG runs annually, but plenty of series here are every few years,
  // and comparing 2015 against an empty 2014 would report every country as
  // having no comparison rather than as having risen or fallen since 2012.
  previousYearWithData() {
    const coverage = this.metadataController.getActiveVariableCoverage();
    const years = Array.isArray(coverage?.availableYears) ? coverage.availableYears : [];
    const selected = Number(this.state.year);
    let best = null;
    for (const year of years) {
      if (year < selected && (best === null || year > best)) best = year;
    }
    return best;
  }

  // Where every row *stood* that year, in the order the table is in now. The
  // signature carries the sort as well as the year: a position only means
  // something against the same ordering, so re-sorting the table has to rebuild
  // this. Returns `positions: null` while the year is still being fetched --
  // which is a different thing from there being no year to compare against, and
  // the two read differently in the cell.
  resolvePreviousPositions() {
    const year = this.previousYearWithData();
    if (year === null) return { signature: null, year: null, positions: null };

    const key = `${this.state.dataset}|${this.state.variable}|${year}`;
    const signature = `${key}|${this.sort.column}|${this.sort.direction}`;
    if (this.previousPositions.signature === signature) return this.previousPositions;

    const payload = this.rowCache.get(key);
    if (!payload) {
      this.requestPreviousRows(key, year);
      return { signature, year, positions: null };
    }
    const positions = new Map();
    this.sortedRows(payload.rows).forEach((row, index) => positions.set(row.rowKey, index + 1));
    this.previousPositions = { signature, year, positions };
    return this.previousPositions;
  }

  // Asked for on its own rather than waited for. The read-ahead usually has it
  // already, and when it does not the column fills in a moment later -- a column
  // that is blank for no visible reason is worse than one that arrives late, and
  // blocking the frame on it would make the animation wait for a year nobody is
  // looking at.
  requestPreviousRows(key, year) {
    if (this.rowRequests.has(key)) return;
    void this.ensureRows(key).then((payload) => {
      if (!payload || !this.active) return;
      if (this.renderedKey !== this.currentKey()) return;
      if (this.previousYearWithData() !== year) return;
      this.renderRows(this.renderedKey, { reason: "change" });
    });
  }

  // How far up or down the table a row has moved. A *smaller* rank is higher up,
  // so the places gained is `before - now`. `null` where there is nothing to say
  // -- no earlier year in the series, or a country that was not in the table
  // that year -- and `undefined` where the answer is not known yet.
  changeFor(rowKey, rank, previous) {
    if (previous.year === null) return null;
    if (previous.positions === null) return undefined;
    const before = previous.positions.get(rowKey);
    if (before === undefined) return null;
    return { places: before - rank, from: previous.year };
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
      "Class 1 is the lowest seventh of the values, class 7 the highest. " +
      // The rows are the only interactive thing here and a highlight is not a
      // fact a reader can be shown, so the caption is where the interaction is
      // stated. Enter on a row marks it; the mark stays on that country as the
      // year moves, which is what the arrow keys and Escape are for.
      "Arrow keys move between rows; Enter follows a row so it stays marked as " +
      "the year changes, and Escape clears every mark.";
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

  // Takes the rows rather than reading `this.rows`, because the change column
  // needs the *previous* year put in this same order to know whether a row has
  // moved up or down the table.
  sortedRows(rows = this.rows) {
    const { column, direction } = this.sort;
    const sign = direction === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
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
    // Neither is a field on the row, and neither is sortable: both are readings
    // of the sort itself.
    if (column === "rank" || column === "change") return null;
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
      // A custom property, not `width`. An inline `width` beats every rule in
      // the stylesheet, so the phone breakpoint's `width: 0` on the columns it
      // drops was silently doing nothing and their widths went on being
      // reserved -- which at seven columns left Country with none of the row
      // at all. Set as a variable, the declared width is what the stylesheet
      // starts from and a media query can still take it away.
      if (column.width) col.style.setProperty("--col-width", column.width);
      this.colsEl.appendChild(col);
    }
  }

  // Rebuilt only when the sort has actually moved. It is seven cells, so cost is
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
        // A column that is not a button still gets its explanation, and "±" is
        // a header that needs one. The spoken name below carries it for anyone
        // a `title` never reaches.
        if (column.note) cell.title = column.note;
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
    // Read first, before a single write: where the reader is looking decides
    // which rows are worth animating, and asking for it now costs nothing
    // because nothing has dirtied the layout yet. Asking after the cell writes
    // would force the very layout this pass exists to avoid.
    this.scrollTop = this.scrollEl.scrollTop;
    this.scrollHeight = this.scrollEl.clientHeight;

    const previous = this.resolvePreviousPositions();
    const order = this.sortedRows();
    const animate = this.shouldAnimate(key, reason);
    const legendColors = this.mapController.legendColorsForPolarity(
      this.metadataController.getActivePolarity(),
    );

    this.renderHead();

    // ---- FLIP, and the whole of it is arithmetic ----
    //
    // It used to read `offsetTop` off every row twice -- once before the
    // reorder and once after -- and each of those reads forces the browser to
    // lay out the whole table synchronously. Three forced layouts of a 245-row
    // table per frame (those two and the flush below) is what held the
    // animation at 18fps: at 8x the profile put a quarter of all time in the
    // second of them alone.
    //
    // None of it was necessary. Every row in this table is one line tall --
    // every cell clips rather than wraps -- so a row's position *is* its index
    // times the row pitch, and the index before and the index after are both
    // already in hand: `renderedOrder` from the last render and `orderKeys`
    // from this one. The pitch is measured once and cached.
    //
    // A stale pitch is a cosmetic risk and not a correctness one: the transform
    // is transient and every glide ends at zero, so where a row *finishes* is
    // the DOM order and nothing else. The worst a wrong pitch can do is make
    // one frame's glide start from the wrong place.

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
        // Not during autoplay. A reorder takes every row out of the document
        // for the length of one statement, which *cancels* a running CSS
        // animation -- so at four years a second the 260ms fade restarted
        // before it ever finished, `animationend` never fired, the class never
        // came off, and the row sat at opacity 0 for the whole animation. The
        // pre-unification German and Italian states, which join the table when
        // the year crosses back past 1871, were invisible the entire time.
        //
        // A row arriving in a year that is on screen for 125ms has no entrance
        // to make anyway. Where there is time for one, a timer takes the class
        // off rather than an event that a reorder can swallow.
        if (animate && !this.state.isAutoPlaying) {
          tr.classList.add("is-entering");
          window.setTimeout(() => tr.classList.remove("is-entering"), ROW_ENTER_MS + 60);
        }
      }
      this.fillRow(tr, row, index + 1, legendColors, previous);
      trs.push(tr);
    });

    for (const [rowKey, tr] of this.rowEls) {
      if (seen.has(rowKey)) continue;
      tr.remove();
      this.rowEls.delete(rowKey);
      this.movingRows.delete(tr);
    }

    const orderKeys = order.map((row) => row.rowKey);
    this.syncRowTabStop(orderKeys);

    const previousIndex = this.renderedIndex;
    // `!tr.isConnected` is the insurance rather than the usual case: a row built
    // in the pass above is only skipped here if the key order came out identical
    // to the last one, which cannot happen while a new row is in it. Getting it
    // wrong would leave a country built but never inserted, so it is checked
    // rather than reasoned about -- and it is a property read, so it costs no
    // layout.
    const orderChanged =
      orderKeys.length !== this.renderedOrder.length ||
      orderKeys.some((rowKey, index) => rowKey !== this.renderedOrder[index]) ||
      trs.some((tr) => !tr.isConnected);

    // 2. Read, and only where a row may still be somewhere other than where the
    //    layout says it is. `glideEndsAt` is one timestamp for the whole last
    //    batch -- every row in a batch shares a duration -- so the common case
    //    is a comparison and no DOM access at all. A reorder landing mid-glide
    //    happens when frames bunch up behind a slow request, not in the ordinary
    //    run of the animation: `flipDuration` keeps the glide inside the frame.
    const midGlide =
      animate && orderChanged && this.movingRows.size > 0 && performance.now() < this.glideEndsAt;
    const carried = midGlide ? this.readCarriedOffsets() : null;

    // 3. Write: the new order. `appendChild` on an element already in the tree
    //    moves it, so this is a reorder and not a rebuild, which is what lets a
    //    row keep its identity -- and its follow mark -- across it.
    //
    //    Focus is the exception, and it became one when the rows were made
    //    focusable: collecting them into a fragment takes every row out of the
    //    document for the length of this statement, and an element that leaves
    //    the document is blurred. So the row somebody is standing on is noted
    //    first and given its focus back straight after -- `preventScroll`,
    //    because refocusing must not scroll the table out from under a reader
    //    who was only watching the year change.
    if (orderChanged) {
      const focusedRow =
        document.activeElement instanceof Element && this.bodyEl.contains(document.activeElement)
          ? document.activeElement.closest("tr[data-row-key]")?.dataset.rowKey || null
          : null;

      const fragment = document.createDocumentFragment();
      for (const tr of trs) fragment.appendChild(tr);
      this.bodyEl.appendChild(fragment);

      if (focusedRow) this.rowEls.get(focusedRow)?.focus({ preventScroll: true });
    }

    this.renderedKey = key;
    this.renderedOrder = orderKeys;
    this.renderedIndex = new Map(orderKeys.map((rowKey, index) => [rowKey, index]));

    if (!orderChanged || !animate) {
      this.settleGlides();
      return;
    }

    // 4. The glide, for the rows somebody can see it on. Everything below is a
    //    write; nothing above this line has to be read back.
    const pitch = this.rowPitch();
    const band = pitch > 0 ? this.visibleRowBand(pitch, orderKeys.length) : null;
    if (!band) {
      this.settleGlides();
      return;
    }

    const duration = this.flipDuration();
    const moved = [];
    const keep = new Set();

    orderKeys.forEach((rowKey, index) => {
      const before = previousIndex.get(rowKey);
      if (before === undefined) return;
      const carriedOffset = carried?.get(rowKey) || 0;
      // A row is worth animating if either end of its journey is on screen.
      if (index < band.first && before < band.first) return;
      if (index > band.last && before > band.last) return;
      const delta = (before - index) * pitch + carriedOffset;
      if (Math.abs(delta) < 0.5) return;

      const tr = trs[index];
      tr.classList.remove("is-moving");
      tr.style.setProperty("--flip-ms", `${duration}ms`);
      tr.style.transform = `translateY(${delta}px)`;
      moved.push(tr);
      keep.add(tr);
    });

    // Anything that was gliding and is not gliding now gives its transform back,
    // or a row that scrolled out of the band mid-flight would keep it for good.
    for (const tr of this.movingRows) {
      if (keep.has(tr)) continue;
      tr.classList.remove("is-moving");
      tr.style.transform = "";
    }
    this.movingRows = keep;

    if (moved.length === 0) {
      this.glideEndsAt = 0;
      return;
    }

    // 5. Flush the style, once for the whole table, so the inverted positions
    //    are what the browser holds as the "before" of the transition about to
    //    start. A requestAnimationFrame cannot stand in for this: rAF callbacks
    //    run *before* the style recalculation, so the invert and the play would
    //    both land in one recalculation and the rows would simply appear in
    //    their new places. This is now the only forced layout in the pass.
    void this.bodyEl.offsetHeight;

    // 6. Play. Adding the transition and removing the transform together is
    //    enough: a transition reads its duration from the after-change style.
    for (const tr of moved) {
      tr.classList.add("is-moving");
      tr.style.transform = "";
    }
    this.glideEndsAt = performance.now() + duration;
  }

  // Where each still-moving row visually is, as an offset from where the layout
  // puts it. Only reached when a reorder lands inside a glide, and only for the
  // rows that were gliding -- a few dozen at worst rather than every row.
  readCarriedOffsets() {
    const carried = new Map();
    for (const tr of this.movingRows) {
      if (!tr.isConnected) continue;
      const matrix = new DOMMatrixReadOnly(window.getComputedStyle(tr).transform);
      if (matrix.m42) carried.set(tr.dataset.rowKey, matrix.m42);
    }
    return carried;
  }

  // Every row is one line tall, so one number describes the whole table. Read
  // from the two ends rather than from one row's height: `offsetHeight` misses
  // the border spacing between rows, and it is the pitch that a position is a
  // multiple of.
  //
  // Cached, and thrown away when the number of rows changes or the window
  // resizes -- the two things that can move it. Nothing reads it on a steady
  // frame, which is the point.
  rowPitch() {
    const rows = this.bodyEl.children;
    if (rows.length < 2) return 0;
    if (this.rowPitchValue > 0 && this.rowPitchRows === rows.length) return this.rowPitchValue;
    const pitch = (rows[rows.length - 1].offsetTop - rows[0].offsetTop) / (rows.length - 1);
    if (!(pitch > 0)) return 0;
    this.rowPitchValue = pitch;
    this.rowPitchRows = rows.length;
    return pitch;
  }

  // The rows near enough to the window to be worth moving. `scrollTop` is read
  // before any of this render's writes, so it costs nothing: nothing has
  // dirtied the layout yet.
  visibleRowBand(pitch, rowCount) {
    const height = this.scrollHeight;
    if (!(height > 0)) return null;
    const first = Math.floor(this.scrollTop / pitch) - FLIP_BAND_BUFFER_ROWS;
    const last = Math.ceil((this.scrollTop + height) / pitch) + FLIP_BAND_BUFFER_ROWS;
    return { first: Math.max(0, first), last: Math.min(rowCount - 1, last) };
  }

  // Every row back to rest. Used where a render is not going to animate at all,
  // so a glide interrupted by a sort or a change of variable does not leave a
  // row parked off its own line.
  settleGlides() {
    for (const tr of this.movingRows) {
      tr.classList.remove("is-moving");
      tr.style.transform = "";
    }
    this.movingRows.clear();
    this.glideEndsAt = 0;
  }

  buildRow(row) {
    const tr = document.createElement("tr");
    tr.className = "table-view-row";
    tr.dataset.rowKey = row.rowKey;
    // Focusable, but only one row at a time is in the tab order -- see
    // syncRowTabStop. Without this the follow mark would be a mouse-only
    // feature, and it is the one interaction this view has.
    tr.tabIndex = -1;

    for (const column of COLUMNS) {
      const cell = document.createElement(column.rowHeader ? "th" : "td");
      if (column.rowHeader) cell.scope = "row";
      if (column.numeric) cell.className = "is-numeric";
      cell.dataset.column = column.key;
      if (column.rowHeader) {
        // Two children rather than a text node: the follow mark has to be in
        // the row's *name* for a reader who cannot see the highlight, and
        // fillRow writes the country name by replacing text -- which would
        // take the mark with it if the two shared a node.
        cell.appendChild(document.createElement("span"));
        const marker = document.createElement("span");
        marker.className = "visually-hidden";
        marker.dataset.followMarker = "";
        cell.appendChild(marker);
        tr.appendChild(cell);
        continue;
      }
      if (column.key === "change") {
        // The glyph is `aria-hidden` and the sentence beside it is what is
        // read. An arrow is a picture of a fact, and "black up-pointing
        // triangle" is not that fact -- nor is it the number of places, which
        // is only in the words and the tooltip now.
        const arrow = document.createElement("span");
        arrow.className = "table-view-change-arrow";
        arrow.setAttribute("aria-hidden", "true");
        cell.appendChild(arrow);
        const spoken = document.createElement("span");
        spoken.className = "visually-hidden";
        cell.appendChild(spoken);
        tr.appendChild(cell);
        continue;
      }
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

  fillRow(tr, row, rank, legendColors, previous) {
    const cells = tr.children;
    COLUMNS.forEach((column, index) => {
      const cell = cells[index];
      if (!cell) return;
      if (column.rowHeader) {
        const text = cell.firstChild;
        const next = this.cellText(row, column.key, rank);
        if (text.textContent !== next) {
          text.textContent = next;
          cell.title = next;
        }
        return;
      }
      if (column.key === "change") {
        this.fillChangeCell(cell, row, rank, previous);
        return;
      }
      if (column.key === "classIndex") {
        const swatch = cell.firstChild;
        const text = cell.lastChild;
        const classIndex = Number.isInteger(row.classIndex) ? row.classIndex : null;
        const color = classIndex === null ? "" : legendColors[classIndex - 1] || "";
        // Guarded like the text beside it. A class rarely moves from one year to
        // the next, so almost every one of these 245 writes a frame was setting
        // a colour to the colour it already had -- and a style write dirties the
        // node whether or not the value changed.
        if (swatch.style.background !== color) swatch.style.background = color;
        const empty = classIndex === null;
        if (swatch.classList.contains("is-empty") !== empty) {
          swatch.classList.toggle("is-empty", empty);
        }
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

    const noData = row.value === null;
    if (tr.classList.contains("is-no-data") !== noData) tr.classList.toggle("is-no-data", noData);
    this.applyFollowState(tr, row.rowKey);
  }

  // Did this row move up or down the table since the previous year the series
  // has? Only that -- the number of places is in the words and the tooltip, not
  // on the row. A column of arrows *and* figures reads as a stock ticker, and
  // the question a reader is asking while the animation plays is the simpler
  // one: is my country climbing or falling?
  //
  // Colour carries it as well as the glyph, never instead of it: green and
  // terracotta are the hard pair for the commonest colour blindness, so the
  // direction has to survive them being the same colour, and a triangle does.
  fillChangeCell(cell, row, rank, previous) {
    const [arrow, spoken] = cell.children;
    const change = this.changeFor(row.rowKey, rank, previous);

    if (change === undefined) {
      // The year is on its way; the cell fills in when it lands rather than
      // claiming there is nothing to compare against.
      this.setChangeCell(cell, arrow, spoken, "", "", "", null);
      return;
    }
    if (change === null) {
      const why = previous.year === null
        ? "No earlier year in this series"
        : `Not in the ${previous.year} table`;
      this.setChangeCell(cell, arrow, spoken, "", why, why, null);
      return;
    }
    if (change.places === 0) {
      const said = `Same position as ${change.from}`;
      // A dot rather than an "=": most rows do not move in most years, and a
      // column of equals signs is noise standing where the news should be.
      this.setChangeCell(cell, arrow, spoken, "·", said, said, null);
      return;
    }
    const up = change.places > 0;
    const places = Math.abs(change.places);
    const said = `${up ? "Up" : "Down"} ${places} ${places === 1 ? "place" : "places"} from ${change.from}`;
    this.setChangeCell(cell, arrow, spoken, up ? "\u25B2" : "\u25BC", said, said, up ? "is-up" : "is-down");
  }

  // One write per changed node. This runs 177 times a frame, and a cell whose
  // text has not moved must not be touched: assigning the same string still
  // dirties the node and costs the layout.
  setChangeCell(cell, arrow, spoken, arrowText, spokenText, title, direction) {
    if (arrow.textContent !== arrowText) arrow.textContent = arrowText;
    if (spoken.textContent !== spokenText) spoken.textContent = spokenText;
    if (cell.title !== title) cell.title = title;
    const up = direction === "is-up";
    const down = direction === "is-down";
    if (cell.classList.contains("is-up") !== up) cell.classList.toggle("is-up", up);
    if (cell.classList.contains("is-down") !== down) cell.classList.toggle("is-down", down);
  }

  cellText(row, column, rank) {
    if (column === "rank") return String(rank);
    // Memoised on the row the first time it is drawn, not computed when the
    // payload arrives. `formatLegendValue` goes through `toLocaleString`, and
    // formatting it per row per frame was 245 locale lookups a frame for an
    // answer that cannot change -- but formatting it on arrival was worse
    // again, because the read-ahead fetches dozens of years and most of them
    // are never drawn. Measured both ways: this is the one that is free.
    if (column === "value") {
      if (row.valueText === undefined) {
        row.valueText = row.value === null ? "\u2014" : formatLegendValue(row.value);
      }
      return row.valueText;
    }
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

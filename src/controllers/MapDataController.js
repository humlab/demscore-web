import { BaseController } from "../core/BaseController.js";
import { formatLegendValue, speakCountryCount, speakLegendRange } from "./MapController.js";
import { boundaryLabelFor } from "../core/attribution.js";
import { downloadCountryRowsCsv } from "../core/csv.js";

// A polite live region that fires on every keystroke is worse than no live
// region: the reader hears the first word of each announcement and none of the
// rest. Changing variable takes a click, but arrowing through the variable list
// changes it per key, and scrubbing the timeline changes it per pixel, so the
// announcement waits for the selection to stop moving.
const ANNOUNCE_SETTLE_MS = 700;
// How many rows the table draws. The country table is 177 rows, so this is a
// ceiling that nothing reaches -- it is here so that a future countries table an
// order of magnitude larger cannot lock the browser up inside a dialog.
const MAX_TABLE_ROWS = 2000;

const COLUMNS = [
  { key: "country", label: "Country", numeric: false },
  { key: "iso3", label: "ISO3", numeric: false },
  { key: "value", label: "Value", numeric: true },
  { key: "classIndex", label: "Class", numeric: true },
  { key: "status", label: "Status", numeric: false },
  // Which outline the row's hexagons were cut from, and for a historical coding
  // unit the years that outline is claimed for. /api/map-data has carried this
  // since the historical registry landed and nothing displayed it, which left a
  // hexagon resting on an 1815 world snapshot indistinguishable from one resting
  // on a present-day border. They are not the same claim.
  { key: "boundary", label: "Boundary", numeric: false },
];

const COLLATOR = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

// The upper end of the WMS year clamp, which the resolution policy also uses to
// close a period that has not ended. A row carrying it is current, not a claim
// about the twenty-second century.
const OPEN_ENDED_YEAR = 2100;

// The map is a WMS image. There is no feature under the pointer to interrogate,
// no DOM inside the tiles, and nothing an assistive technology can be handed
// except the `alt` of a picture -- so the only honest way to make the map
// readable without sight is to serve the same numbers as text beside it.
//
// This controller owns all three of the ways that happens:
//
//   - `#mapSummary`, the standing reading of the current map state. Not live:
//     it is several sentences plus seven class spans, and it is rewritten on
//     every frame of an animation.
//   - `#mapAnnouncer`, the live one. One sentence, and only once the selection
//     has stopped moving.
//   - `#mapDataDialog`, the map's contents as a sortable table, with the same
//     rows offered as a CSV.
//
// It hangs off `MapController.onStateChange`, which fires from `refreshLegend()`
// -- the single place every change of dataset, variable, year or polarity
// passes through.
export class MapDataController extends BaseController {
  constructor({ state, meta, attributionMeta, metadataController, mapController, onOpenAttribution }) {
    super();
    this.state = state;
    this.meta = meta;
    this.attributionMeta = attributionMeta || null;
    this.metadataController = metadataController;
    this.mapController = mapController;
    this.onOpenAttribution = typeof onOpenAttribution === "function" ? onOpenAttribution : () => {};

    this.summaryTextEl = this.getEl("mapSummaryText");
    this.summaryClassesEl = this.getEl("mapSummaryClasses");
    this.announcerEl = this.getEl("mapAnnouncer");

    this.dialog = this.getEl("mapDataDialog");
    this.dialogSummaryEl = this.getEl("mapDataSummary");
    this.tableCaptionEl = this.getEl("mapDataTableCaption");
    this.tableHeadEl = this.getEl("mapDataTableHead");
    this.tableBodyEl = this.getEl("mapDataTableBody");
    this.closeBtn = this.getEl("mapDataCloseBtn");
    this.boundaryNoteEl = this.getEl("mapDataBoundaryNote");
    this.downloadBtn = this.getEl("mapDataDownloadBtn");
    // Built by MapController.initializeLegend(), so this runs after it.
    this.openBtn = this.getEl("mapDataTableBtn");

    this.announceTimer = null;
    this.lastAnnouncedKey = null;
    // The table shown in the dialog, and the key it belongs to. The dialog is
    // opened rarely and the rows are per year, so nothing is cached between
    // openings: a stale table is worse than a second request.
    this.tableRows = [];
    this.tableKey = null;
    this.sort = { column: "country", direction: "asc" };
    this.tableRequest = 0;
  }

  initialize() {
    this.openBtn?.addEventListener("click", () => void this.openTable());
    this.closeBtn.addEventListener("click", () => this.dialog.close());
    this.downloadBtn.addEventListener("click", () => this.downloadCsv());
    // Native `close` covers the close button, Escape and a form submission
    // alike, so the opener's state is restored from one place whatever shut it.
    this.dialog.addEventListener("close", () => {
      this.openBtn?.setAttribute("aria-expanded", "false");
      this.openBtn?.focus();
    });
    this.tableHeadEl.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-column]");
      if (!button) return;
      this.applySort(button.dataset.column);
    });

    this.refresh();
  }

  // ---- the standing summary ----------------------------------------------

  refresh() {
    this.renderSummary();
    this.scheduleAnnouncement();

    // The spans arrive separately, and during an animation they do not arrive
    // at all (see MapController.refreshLegend). Whatever is cached goes in now;
    // if a request is outstanding the summary is redrawn when it lands, and
    // only if the map is still on the same variable-year.
    const key = this.mapController.classBreaksKey();
    if (this.mapController.getCachedClassBreaks(key) !== undefined) return;
    if (this.state.isAutoPlaying) return;
    void this.mapController.ensureClassBreaks(key).then(() => {
      if (this.mapController.classBreaksKey() === key) this.renderSummary();
    });
  }

  describeSelection() {
    const { dataset, variable, year } = this.state;
    const datasetMeta = this.meta.datasets?.[dataset];
    return {
      dataset,
      variable,
      year,
      variableTitle: this.metadataController.getVariableTitle(dataset, variable),
      datasetTitle: this.metadataController.getDatasetTitle(datasetMeta, dataset),
    };
  }

  // What the summary says about coverage, which is a reading of the data rather
  // than a gap in it: a country with no value for this year is not drawn, and
  // the bare land it leaves is a fact about the variable.
  describeCoverage(breaks) {
    const withData = breaks?.countriesWithData;
    const total = breaks?.countriesTotal;
    if (!Number.isFinite(withData) || !Number.isFinite(total) || total === 0) return "";
    const without = total - withData;
    if (without <= 0) return `All ${total} countries on the map have a value.`;
    return (
      `${withData} of ${total} countries have a value; ` +
      `${without} ${without === 1 ? "is" : "are"} drawn as plain land with no value for this year.`
    );
  }

  renderSummary() {
    const { variableTitle, variable, datasetTitle, year } = this.describeSelection();
    const legend = this.mapController.describeLegend();
    const breaks = this.mapController.getCachedClassBreaks();

    this.summaryTextEl.textContent = [
      `${variableTitle} (${variable}), ${datasetTitle}, ${year}.`,
      `Drawn in ${legend.projectionTitle}.`,
      `Countries are shaded in ${legend.classCount} quantile classes from ${legend.low.toLowerCase()} ` +
        `to ${legend.high.toLowerCase()}.`,
      // Which scheme is in use belongs here because it is a choice the reader
      // may have made, and a summary that described colours they are not
      // looking at would be worse than one that described none.
      `Colour scheme: ${legend.paletteLabel}.`,
      legend.directionHint,
      legend.noDataNote,
      this.describeCoverage(breaks),
    ]
      .filter(Boolean)
      .join(" ");

    this.summaryClassesEl.innerHTML = "";
    const classes = Array.isArray(breaks?.classes) ? breaks.classes : [];
    if (classes.length === 0) {
      // Either the spans have not been asked for yet (during an animation they
      // never are) or the year holds no values at all. Saying nothing is
      // better than an empty list that reads as seven empty classes.
      return;
    }
    for (const entry of classes) {
      const item = document.createElement("li");
      const countries = speakCountryCount(entry.countryCount);
      item.textContent =
        `Class ${entry.classIndex} of ${legend.classCount}: ${speakLegendRange(entry)}` +
        `${countries ? `, ${countries}` : ""}.`;
      this.summaryClassesEl.appendChild(item);
    }
  }

  // ---- the live announcement ---------------------------------------------

  // One sentence, once the selection has stopped moving, and never during an
  // animation -- a year a second is the reader's own doing and narrating it
  // would drown out everything else on the page.
  scheduleAnnouncement() {
    window.clearTimeout(this.announceTimer);
    if (this.state.isAutoPlaying) {
      // The animation's own start and stop are announced by the play button's
      // label; the years in between are not news.
      this.lastAnnouncedKey = null;
      return;
    }

    this.announceTimer = window.setTimeout(() => {
      this.announceTimer = null;
      const key = this.mapController.classBreaksKey();
      if (key === this.lastAnnouncedKey) return;
      this.lastAnnouncedKey = key;

      const { variableTitle, datasetTitle, year } = this.describeSelection();
      const coverage = this.describeCoverage(this.mapController.getCachedClassBreaks(key));
      this.announcerEl.textContent = `Map now showing ${variableTitle}, ${datasetTitle}, ${year}. ${coverage}`.trim();
    }, ANNOUNCE_SETTLE_MS);
  }

  // ---- the data table -----------------------------------------------------

  async openTable() {
    const key = this.mapController.classBreaksKey();
    const { variableTitle, variable, datasetTitle, year } = this.describeSelection();

    this.openBtn?.setAttribute("aria-expanded", "true");
    this.dialogSummaryEl.textContent = `${variableTitle} (${variable}) — ${datasetTitle}, ${year}. Loading…`;
    this.tableCaptionEl.textContent = `${variableTitle}, ${datasetTitle}, ${year}`;
    this.tableHeadEl.innerHTML = "";
    this.tableBodyEl.innerHTML = "";
    this.boundaryNoteEl.textContent = "";
    this.tableRows = [];
    this.tableKey = key;
    this.downloadBtn.disabled = true;

    if (typeof this.dialog.showModal === "function") {
      if (!this.dialog.open) this.dialog.showModal();
    } else {
      this.dialog.setAttribute("open", "");
    }

    // A second opening while the first is still in flight retires the first.
    const ticket = (this.tableRequest += 1);
    const payload = await this.fetchTable(key);
    if (ticket !== this.tableRequest) return;

    if (!payload) {
      this.dialogSummaryEl.textContent =
        `${variableTitle} (${variable}) — ${datasetTitle}, ${year}. The table could not be loaded.`;
      return;
    }

    this.tableRows = payload.rows;
    const without = payload.countriesTotal - payload.countriesWithData;
    this.dialogSummaryEl.textContent =
      `${variableTitle} (${variable}) — ${datasetTitle}, ${year}. ` +
      `${payload.countriesWithData} of ${payload.countriesTotal} countries have a value` +
      `${without > 0 ? `; ${without} have none for this year` : ""}. ` +
      `Class 1 is the lowest seventh of the values, class ${payload.classCount} the highest.`;
    this.downloadBtn.disabled = false;
    this.renderTable();
    this.renderBoundaryNote();
  }

  async fetchTable(key) {
    const [dataset, variable, year] = key.split("|");
    const query = new URLSearchParams({ dataset, variable, year });
    try {
      const response = await fetch(`/api/map-data?${query}`);
      if (!response.ok) throw new Error(`Could not load map data: ${response.status}`);
      const payload = await response.json();
      return {
        classCount: Number.isFinite(payload?.classCount) ? payload.classCount : 7,
        countriesTotal: Number.isFinite(payload?.countriesTotal) ? payload.countriesTotal : 0,
        countriesWithData: Number.isFinite(payload?.countriesWithData) ? payload.countriesWithData : 0,
        rows: (Array.isArray(payload?.rows) ? payload.rows.slice(0, MAX_TABLE_ROWS) : []).map((row) => ({
          ...row,
          // Resolved once, here, rather than per cell: the label is a lookup
          // into the attribution register and the table redraws on every sort.
          boundary: this.describeBoundary(row),
        })),
      };
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  applySort(column) {
    if (!COLUMNS.some((entry) => entry.key === column)) return;
    this.sort =
      this.sort.column === column
        ? { column, direction: this.sort.direction === "asc" ? "desc" : "asc" }
        : { column, direction: "asc" };
    this.renderTable();
    // The header is rebuilt by renderTable, so the button that was pressed no
    // longer exists; focus goes back to its replacement rather than to the top
    // of the dialog.
    this.tableHeadEl.querySelector(`button[data-column="${column}"]`)?.focus();
  }

  sortedRows() {
    const { column, direction } = this.sort;
    const sign = direction === "asc" ? 1 : -1;
    return [...this.tableRows].sort((a, b) => {
      const left = this.cellValue(a, column);
      const right = this.cellValue(b, column);
      // A country with no value sorts to the end whichever way the column is
      // pointing: "no data" is not a small number, and letting it act like one
      // would put every gap at the top of an ascending value sort.
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
    if (column === "status") return row.value === null ? "No data" : "Has value";
    const value = row[column];
    return value === undefined || value === null || value === "" ? null : value;
  }

  renderTable() {
    const headRow = document.createElement("tr");
    for (const column of COLUMNS) {
      const cell = document.createElement("th");
      cell.scope = "col";
      if (column.numeric) cell.className = "is-numeric";
      // `aria-sort` belongs on the header cell, not on the button inside it,
      // and only the sorted column carries it -- "none" on every other column
      // is noise a reader has to hear six times over.
      if (this.sort.column === column.key) {
        cell.setAttribute("aria-sort", this.sort.direction === "asc" ? "ascending" : "descending");
      }

      const button = document.createElement("button");
      button.type = "button";
      button.dataset.column = column.key;
      button.className = "map-data-sort";
      const sorted = this.sort.column === column.key;
      const nextDirection = sorted && this.sort.direction === "asc" ? "descending" : "ascending";
      button.textContent = column.label;
      // The name says what pressing it will do, because that is what the
      // reader is deciding; `aria-sort` above says what it is doing now.
      button.setAttribute("aria-label", `${column.label}, sort ${nextDirection}`);
      if (sorted) button.classList.add(this.sort.direction === "asc" ? "is-asc" : "is-desc");
      cell.appendChild(button);
      headRow.appendChild(cell);
    }
    this.tableHeadEl.innerHTML = "";
    this.tableHeadEl.appendChild(headRow);

    const body = document.createDocumentFragment();
    for (const row of this.sortedRows()) {
      const tr = document.createElement("tr");

      // The country name is the row's own heading, so a reader moving down the
      // Value column is told which country each number belongs to.
      const name = document.createElement("th");
      name.scope = "row";
      name.textContent = row.country;
      tr.appendChild(name);

      for (const column of COLUMNS.slice(1)) {
        const cell = document.createElement("td");
        if (column.numeric) cell.className = "is-numeric";
        cell.textContent = this.cellText(row, column.key);
        tr.appendChild(cell);
      }
      body.appendChild(tr);
    }
    this.tableBodyEl.innerHTML = "";
    this.tableBodyEl.appendChild(body);
  }

  cellText(row, column) {
    if (column === "status") return row.value === null ? "No data" : "";
    if (column === "value") return row.value === null ? "—" : formatLegendValue(row.value);
    if (column === "classIndex") return row.classIndex === null ? "—" : String(row.classIndex);
    return row[column] || "—";
  }

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
    // leaving it null, so 2100 is a sentinel and not a claim about 2100. Both
    // Palestine units and Zanzibar carry it -- they are on the map today, which
    // is the whole reason the credit line cannot be conditional on the year.
    if (!Number.isFinite(to) || to >= OPEN_ENDED_YEAR) return `${label} (from ${from})`;
    return `${label} (${from}\u2013${to})`;
  }

  // The sources under the rows above, and the way from here into the licences
  // that cover them. It counts what is in *this* view rather than listing every
  // source the deployment holds: at 2020 that is Natural Earth plus the three
  // CShapes entities whose policy rows run to 2100, and at 1830 it is a quite
  // different list. The dialog behind the button is the full register.
  renderBoundaryNote() {
    this.boundaryNoteEl.textContent = "";
    const counts = new Map();
    for (const row of this.tableRows) {
      const label = boundaryLabelFor(this.attributionMeta, row.geometrySource);
      if (!label) continue;
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    if (counts.size === 0) return;

    const listed = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => `${label} (${count})`)
      .join(", ");
    this.boundaryNoteEl.appendChild(
      document.createTextNode(`Boundaries in this view: ${listed}. `),
    );

    const button = document.createElement("button");
    button.type = "button";
    button.className = "attribution-open";
    button.setAttribute("aria-haspopup", "dialog");
    button.textContent = "Sources & licences";
    // The data dialog is modal, so opening a second modal over it would stack
    // two focus traps. Closing this one first also means Escape from the credits
    // returns the reader to the map rather than to a table they have finished
    // with; `onOpenAttribution` is given the button that opened it, but that
    // button is inside a dialog that is now closed, so focus falls back to the
    // dialog's own opener -- the legend's Data table button.
    button.addEventListener("click", () => {
      const opener = this.openBtn;
      this.dialog.close();
      this.onOpenAttribution(opener);
    });
    this.boundaryNoteEl.appendChild(button);
  }

  // The same rows the table shows, in the order it is showing them, as a file.
  // Spelled in `core/csv.js`, shared with the table view's own download, so a
  // file that came out of this application has one shape whichever button
  // produced it -- and so the year these numbers are for is in the rows and not
  // only in the filename, which is a place a file loses.
  downloadCsv() {
    downloadCountryRowsCsv(this.sortedRows(), this.describeSelection());
  }
}

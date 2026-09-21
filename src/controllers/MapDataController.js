import { BaseController } from "../core/BaseController.js";
import { formatLegendValue, speakCountryCount, speakLegendRange } from "./MapController.js";

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
];

const COLLATOR = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

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
  constructor({ state, meta, metadataController, mapController }) {
    super();
    this.state = state;
    this.meta = meta;
    this.metadataController = metadataController;
    this.mapController = mapController;

    this.summaryTextEl = this.getEl("mapSummaryText");
    this.summaryClassesEl = this.getEl("mapSummaryClasses");
    this.announcerEl = this.getEl("mapAnnouncer");

    this.dialog = this.getEl("mapDataDialog");
    this.dialogSummaryEl = this.getEl("mapDataSummary");
    this.tableCaptionEl = this.getEl("mapDataTableCaption");
    this.tableHeadEl = this.getEl("mapDataTableHead");
    this.tableBodyEl = this.getEl("mapDataTableBody");
    this.closeBtn = this.getEl("mapDataCloseBtn");
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
        rows: Array.isArray(payload?.rows) ? payload.rows.slice(0, MAX_TABLE_ROWS) : [],
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

  // The same rows the table shows, in the order it is showing them, as a file.
  // Built here rather than served: the backend already sent the numbers, and a
  // second round trip to get them punctuated differently would be a second
  // chance for the two to disagree.
  downloadCsv() {
    if (this.tableRows.length === 0) return;
    const { variable, dataset, year } = this.describeSelection();
    const escape = (value) => {
      const text = value === null || value === undefined ? "" : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const lines = [["country", "iso3", "value", "class", "status"].join(",")];
    for (const row of this.sortedRows()) {
      lines.push(
        [row.country, row.iso3, row.value, row.classIndex, row.value === null ? "no data" : "has value"]
          .map(escape)
          .join(","),
      );
    }

    const blob = new Blob([`${lines.join("\n")}\n`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `demscore-${dataset}-${variable}-${year}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }
}

import { BaseController } from "../core/BaseController.js";
import { speakCountryCount, speakLegendRange } from "./MapController.js";

// A polite live region that fires on every keystroke is worse than no live
// region: the reader hears the first word of each announcement and none of the
// rest. Changing variable takes a click, but arrowing through the variable list
// changes it per key, and scrubbing the timeline changes it per pixel, so the
// announcement waits for the selection to stop moving.
const ANNOUNCE_SETTLE_MS = 700;
// The map is a WMS image. There is no feature under the pointer to interrogate,
// no DOM inside the tiles, and nothing an assistive technology can be handed
// except the `alt` of a picture -- so the only honest way to make the map
// readable without sight is to serve the same numbers as text beside it.
//
// This controller owns two of the ways that happens:
//
//   - `#mapSummary`, the standing reading of the current map state. Not live:
//     it is several sentences plus seven class spans, and it is rewritten on
//     every frame of an animation.
//   - `#mapAnnouncer`, the live one. One sentence, and only once the selection
//     has stopped moving.
//
// The third used to be `#mapDataDialog`, the same rows in a modal opened from a
// button on the legend. The table *view* is that, without the modal and without
// the year standing still -- so the dialog and its opener are gone and
// TableViewController is where those rows are read now.
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

    this.announceTimer = null;
    this.lastAnnouncedKey = null;
  }

  initialize() {
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

}

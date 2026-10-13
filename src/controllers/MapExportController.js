import { BaseController } from "../core/BaseController.js";
import {
  DEFAULT_EXPORT_SIZE,
  EXPORT_SIZES,
  buildExportCredits,
  drawExportFrame,
  layoutExportFrame,
  loadExportAssets,
} from "../core/exportFrame.js";
import { NO_DATA_COLOR } from "../core/palettes.js";
import { withPngText } from "../core/pngText.js";
import {
  VIDEO_FORMATS,
  canEncodeVideoAtAll,
  createVideoWriter,
  describeCodec,
  detectVideoSupport,
} from "../core/videoExport.js";

// How many tile requests a download keeps in flight. The browser allows six per
// host over HTTP/1.1, and the read-ahead and the live map share them, so asking
// for more would only queue in the browser instead of here.
const TILE_CONCURRENCY = 6;
// A tile that fails is asked for again before the download gives up: one
// MapServer worker timing out under the read-ahead is not a reason to throw
// away a two-minute video. A frame with a tile missing is never written --
// a hole in the map would read as a country with no data.
const TILE_ATTEMPTS = 3;
const TILE_RETRY_MS = 600;
// Years whose tiles are fetched while the current one is drawn and encoded.
// Tiles are kept as the compressed PNGs MapServer sent, so this costs a few
// hundred kilobytes a year, not the 40 MB a decoded HD frame's tiles would.
const LOOKAHEAD_YEARS = 3;
// A video is written at a constant rate near this, holding each year for a
// whole number of frames: 4 years a second is 6 frames a year at 24 fps, 7 a
// second is 4 frames at 28. See videoExport.js for why not one long frame.
const TARGET_FRAME_RATE = 24;
// The first year is held a little, so a video does not start mid-movement, and
// the last for longer, so it does not end before the last year can be read.
const HOLD_FIRST_SECONDS = 0.5;
const HOLD_LAST_SECONDS = 2;
const SPEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const PREVIEW_DEBOUNCE_MS = 150;

class DownloadCancelled extends Error {
  constructor() {
    super("Download cancelled");
    this.name = "DownloadCancelled";
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DownloadCancelled();
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new DownloadCancelled());
      },
      { once: true },
    );
  });
}

// `cache: "force-cache"`, as the read-ahead asks: a tile URL names one year of
// one variable in one colour scheme and never changes meaning, so anything the
// browser or the service worker already holds is the right answer.
async function fetchTileBlob(url, signal) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { cache: "force-cache", signal });
      if (!response.ok) throw new Error(`MapServer answered ${response.status}`);
      return await response.blob();
    } catch (error) {
      if (signal?.aborted) throw new DownloadCancelled();
      if (attempt >= TILE_ATTEMPTS) throw new Error(`A map tile could not be loaded (${error.message}).`);
      await wait(TILE_RETRY_MS * attempt, signal);
    }
  }
}

// First come, first served, TILE_CONCURRENCY at a time. A video asks for its
// years in order, so the year about to be drawn is never behind the ones after
// it.
class TileQueue {
  constructor(signal) {
    this.signal = signal;
    this.active = 0;
    this.jobs = [];
  }

  fetch(url) {
    return new Promise((resolve, reject) => {
      this.jobs.push({ url, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.active < TILE_CONCURRENCY && this.jobs.length > 0) {
      const job = this.jobs.shift();
      this.active += 1;
      fetchTileBlob(job.url, this.signal)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }
}

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} kB`;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Long enough for the browser to have started the save; revoking at once
  // cancels it in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// The Download dialog: an image of the year on screen, or a video of a span of
// years, both drawn from the selection as it stood when the dialog opened. The
// frame is composed in core/exportFrame.js, the tiles are spelled by
// MapController.getExportTileRequests(), and the video is written by
// core/videoExport.js; this controller fetches, sequences and saves.
export class MapExportController extends BaseController {
  constructor({ state, meta, mapController, metadataController, attributionMeta, getCoverage, onBeforeOpen }) {
    super();
    this.state = state;
    this.meta = meta;
    this.mapController = mapController;
    this.metadataController = metadataController;
    this.attributionMeta = attributionMeta;
    this.getCoverage = getCoverage;
    this.onBeforeOpen = typeof onBeforeOpen === "function" ? onBeforeOpen : () => {};

    this.subject = null;
    this.assetsPromise = null;
    this.support = null;
    this.supportKey = null;
    this.busy = false;
    this.runAbort = null;
    this.previewAbort = null;
    this.previewTimer = null;
    this.previewToken = 0;
    this.opener = null;
  }

  initialize() {
    this.openBtn = this.getEl("mapExportBtn");
    this.dialog = this.getEl("mapExportDialog");
    this.form = this.getEl("mapExportForm");
    this.canvas = this.getEl("mapExportCanvas");
    this.imageYearEl = this.getEl("mapExportImageYear");
    this.videoNoteEl = this.getEl("mapExportVideoNote");
    this.sizesEl = this.getEl("mapExportSizes");
    this.videoOptionsEl = this.getEl("mapExportVideoOptions");
    this.fromSelect = this.getEl("mapExportFrom");
    this.toSelect = this.getEl("mapExportTo");
    this.speedSelect = this.getEl("mapExportSpeed");
    this.formatSelect = this.getEl("mapExportFormat");
    this.estimateEl = this.getEl("mapExportEstimate");
    this.progressEl = this.getEl("mapExportProgress");
    this.statusEl = this.getEl("mapExportStatus");
    this.closeBtn = this.getEl("mapExportCloseBtn");
    this.cancelBtn = this.getEl("mapExportCancelBtn");
    this.startBtn = this.getEl("mapExportStartBtn");

    this.sizesEl.innerHTML = Object.entries(EXPORT_SIZES)
      .map(
        ([key, size]) => `<label class="export-choice">
          <input type="radio" name="exportSize" value="${key}"${key === DEFAULT_EXPORT_SIZE ? " checked" : ""} />
          <span>${size.label}<span class="export-choice-note" data-size-note="${key}"></span></span>
        </label>`,
      )
      .join("");
    this.speedSelect.innerHTML = SPEEDS.map(
      (speed) => `<option value="${speed}">${speed} ${speed === 1 ? "year" : "years"} per second</option>`,
    ).join("");

    this.openBtn.addEventListener("click", () => this.open(this.openBtn));
    this.closeBtn.addEventListener("click", () => this.requestClose());
    this.cancelBtn.addEventListener("click", () => this.requestClose());
    this.startBtn.addEventListener("click", () => void this.start());
    // Escape. While a download runs it cancels the download rather than
    // closing over it, so the reader sees that it stopped.
    this.dialog.addEventListener("cancel", (event) => {
      if (!this.busy) return;
      event.preventDefault();
      this.runAbort?.abort();
    });
    this.dialog.addEventListener("close", () => {
      this.previewAbort?.abort();
      window.clearTimeout(this.previewTimer);
      if (this.opener?.isConnected) this.opener.focus();
    });
    this.form.addEventListener("change", (event) => this.onOptionsChange(event));
    this.form.addEventListener("submit", (event) => event.preventDefault());
  }

  open(opener) {
    this.onBeforeOpen();
    this.opener = opener || null;
    this.subject = this.captureSubject();
    this.assetsPromise ||= loadExportAssets();
    this.assetsPromise.catch(() => {
      this.assetsPromise = null;
    });

    this.imageYearEl.textContent = String(this.subject.year);
    const [mapWidth, mapHeight] = this.subject.screenSize;
    const screenNote = this.sizesEl.querySelector('[data-size-note="screen"]');
    if (screenNote) screenNote.textContent = `${Math.round(mapWidth)} × ${Math.round(mapHeight)} map`;
    this.fillYearSelects();
    this.speedSelect.value = String(this.state.autoPlaySpeed || 4);
    this.setStatus("");
    this.progressEl.hidden = true;
    this.syncControls();

    this.dialog.showModal();
    void this.refreshVideoSupport();
    this.schedulePreview(0);
  }

  requestClose() {
    if (this.busy) {
      this.runAbort?.abort();
      return;
    }
    this.dialog.close();
  }

  // Everything a frame says, read once. The dialog is modal, so nothing can
  // change under it -- but autoplay was running a moment ago, and a video takes
  // long enough that reading the state per frame would be asking for trouble.
  captureSubject() {
    const { dataset, variable, year } = this.state;
    const datasetConfig = this.meta.datasets[dataset];
    const datasetTitle = this.metadataController.getDatasetTitle(datasetConfig, dataset);
    const title = this.metadataController.getVariableTitle(dataset, variable);
    const legend = this.mapController.describeLegend();
    const coverage = this.getCoverage();
    const years = Array.isArray(coverage?.availableYears) && coverage.availableYears.length > 0
      ? coverage.availableYears
      : [year];

    return {
      dataset,
      variable,
      year,
      years,
      datasetTitle,
      screenSize: this.mapController.getMap().getSize() || [1280, 720],
      content: {
        title,
        // The key under the name: a variable's title is the codebook's, and
        // two datasets can use the same one.
        subtitle: title === variable ? datasetTitle : `${datasetTitle} · ${variable}`,
        legend: {
          caption: legend.title,
          low: legend.low,
          high: legend.high,
          colors: this.mapController.legendColorsForPolarity(legend.polarity),
          noDataColor: NO_DATA_COLOR,
        },
        credits: buildExportCredits({ attributionMeta: this.attributionMeta, dataset, datasetTitle }),
      },
    };
  }

  fillYearSelects() {
    const options = this.subject.years.map((year) => `<option value="${year}">${year}</option>`).join("");
    this.fromSelect.innerHTML = options;
    this.toSelect.innerHTML = options;
    // The whole series by default: that is what the play button plays.
    this.fromSelect.value = String(this.subject.years[0]);
    this.toSelect.value = String(this.subject.years[this.subject.years.length - 1]);
  }

  readOptions() {
    const elements = this.form.elements;
    return {
      kind: elements.namedItem("exportKind").value,
      size: elements.namedItem("exportSize").value || DEFAULT_EXPORT_SIZE,
      from: Number(this.fromSelect.value),
      to: Number(this.toSelect.value),
      speed: Number(this.speedSelect.value) || 4,
      format: this.formatSelect.value,
    };
  }

  videoYears(options = this.readOptions()) {
    return this.subject.years.filter((year) => year >= options.from && year <= options.to);
  }

  onOptionsChange(event) {
    // A range picked backwards is put the right way round rather than refused.
    if (event?.target === this.fromSelect && Number(this.fromSelect.value) > Number(this.toSelect.value)) {
      this.toSelect.value = this.fromSelect.value;
    }
    if (event?.target === this.toSelect && Number(this.toSelect.value) < Number(this.fromSelect.value)) {
      this.fromSelect.value = this.toSelect.value;
    }
    this.syncControls();
    if (event?.target?.name === "exportSize") void this.refreshVideoSupport();
    if (event?.target !== this.speedSelect && event?.target !== this.formatSelect) this.schedulePreview();
  }

  syncControls() {
    const options = this.readOptions();
    const video = options.kind === "video";
    this.videoOptionsEl.disabled = !video || this.busy;
    this.form.querySelectorAll("fieldset").forEach((fieldset) => {
      if (fieldset !== this.videoOptionsEl) fieldset.disabled = this.busy;
    });
    this.startBtn.disabled = this.busy || (video && !this.formatSelect.value);
    this.startBtn.textContent = video ? `Download ${VIDEO_FORMATS[options.format]?.label || "video"}` : "Download PNG";
    this.cancelBtn.textContent = this.busy ? "Cancel" : "Close";

    const years = this.videoYears(options);
    const span = years.length > 0 ? years[years.length - 1] - years[0] + 1 : 0;
    const seconds = span / options.speed + HOLD_FIRST_SECONDS + HOLD_LAST_SECONDS;
    const counted = span === years.length
      ? `${years.length} ${years.length === 1 ? "year" : "years"}`
      : `${years.length} years with data across ${span}`;
    this.estimateEl.textContent = `${counted}, about ${Math.round(seconds)} seconds of video.`;
  }

  // Which formats this browser can encode at the chosen size. Asked again when
  // the size changes, because an encoder that takes HD can refuse a 4K screen.
  async refreshVideoSupport() {
    const { size } = this.readOptions();
    const layoutSize = this.frameSizeEstimate(size);
    const key = layoutSize.join("x");
    if (this.supportKey === key && this.support) return;
    this.supportKey = key;

    let support = null;
    if (canEncodeVideoAtAll()) {
      try {
        support = await detectVideoSupport(...layoutSize);
      } catch (error) {
        console.error(error);
      }
    }
    if (this.supportKey !== key) return;
    this.support = support || {};

    const previous = this.formatSelect.value;
    this.formatSelect.innerHTML = Object.entries(VIDEO_FORMATS)
      .map(([formatKey, format]) => {
        const codec = this.support[formatKey];
        const label = codec ? `${format.label} (${describeCodec(codec)})` : `${format.label} (not available in this browser)`;
        return `<option value="${formatKey}"${codec ? "" : " disabled"}>${label}</option>`;
      })
      .join("");
    const available = Object.keys(VIDEO_FORMATS).filter((formatKey) => this.support[formatKey]);
    this.formatSelect.value = available.includes(previous) ? previous : available[0] || "";

    const videoRadio = this.form.querySelector('input[name="exportKind"][value="video"]');
    videoRadio.disabled = available.length === 0;
    this.videoNoteEl.textContent = available.length === 0 ? "not supported in this browser" : "video";
    if (videoRadio.disabled && videoRadio.checked) {
      this.form.querySelector('input[name="exportKind"][value="image"]').checked = true;
    }
    this.syncControls();
  }

  // The frame's size before the fonts and logos are in, close enough to ask an
  // encoder about. The real layout is the same width and within a few pixels
  // of the same height.
  frameSizeEstimate(size) {
    const preset = EXPORT_SIZES[size];
    if (Number.isFinite(preset?.width)) return [preset.width, preset.height];
    const [width, height] = this.subject.screenSize;
    return [Math.round(width / 2) * 2, Math.round((height * 1.3) / 2) * 2];
  }

  schedulePreview(delay = PREVIEW_DEBOUNCE_MS) {
    window.clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => void this.renderPreview(), delay);
  }

  // The first frame of whatever the options describe, drawn by the same code
  // the download uses -- so what is previewed is what is saved.
  async renderPreview() {
    if (this.busy || !this.dialog.open) return;
    this.previewAbort?.abort();
    const abort = new AbortController();
    this.previewAbort = abort;
    const token = (this.previewToken += 1);
    const options = this.readOptions();
    const years = options.kind === "video" ? this.videoYears(options) : [this.subject.year];

    try {
      const { layout, view } = await this.prepareFrame(options.size, years);
      const tiles = await this.loadYearTiles(new TileQueue(abort.signal), view, years[0]);
      if (token !== this.previewToken) return;
      await this.drawFrame(layout, years[0], tiles);
    } catch (error) {
      if (error instanceof DownloadCancelled || token !== this.previewToken) return;
      console.error(error);
      this.setStatus(`The preview could not be drawn: ${error.message}`);
    }
  }

  async prepareFrame(size, years) {
    if (!this.assetsPromise) this.assetsPromise = loadExportAssets();
    const assets = await this.assetsPromise;
    const layout = layoutExportFrame({
      size,
      screenSize: this.subject.screenSize,
      content: this.subject.content,
      years,
      assets,
    });
    const view = this.mapController.getExportView(layout.map.width, layout.map.height, {
      matchScreen: !Number.isFinite(EXPORT_SIZES[size]?.width),
    });
    return { layout, view };
  }

  loadYearTiles(queue, view, year) {
    const requests = this.mapController.getExportTileRequests(view, year);
    return Promise.all(requests.map((request) => queue.fetch(request.url).then((blob) => ({ ...request, blob }))));
  }

  // The map for one year onto a canvas of its own, then the whole frame onto
  // the dialog's canvas. The map canvas is kept between frames: a video draws
  // the same size every time.
  async drawFrame(layout, year, tiles) {
    if (!this.mapCanvas) this.mapCanvas = document.createElement("canvas");
    const mapCanvas = this.mapCanvas;
    mapCanvas.width = layout.map.width;
    mapCanvas.height = layout.map.height;
    const mapContext = mapCanvas.getContext("2d");
    mapContext.fillStyle = layout.tokens["--map-ocean"];
    mapContext.fillRect(0, 0, mapCanvas.width, mapCanvas.height);
    mapContext.imageSmoothingQuality = "high";

    // Decoded in parallel, drawn in order, and let go as soon as they are
    // drawn: a decoded tile is a megabyte.
    const bitmaps = await Promise.all(tiles.map((tile) => createImageBitmap(tile.blob)));
    tiles.forEach((tile, index) => {
      mapContext.drawImage(bitmaps[index], tile.left, tile.top, tile.width, tile.height);
      bitmaps[index].close();
    });

    if (this.canvas.width !== layout.width) this.canvas.width = layout.width;
    if (this.canvas.height !== layout.height) this.canvas.height = layout.height;
    drawExportFrame(this.canvas.getContext("2d"), layout, this.subject.content, year, mapCanvas);
  }

  async start() {
    if (this.busy) return;
    const options = this.readOptions();
    this.previewAbort?.abort();
    window.clearTimeout(this.previewTimer);
    this.previewToken += 1;

    const abort = new AbortController();
    this.runAbort = abort;
    this.busy = true;
    this.syncControls();
    this.progressEl.hidden = false;
    this.progressEl.removeAttribute("value");

    try {
      const result = options.kind === "video"
        ? await this.exportVideo(options, abort.signal)
        : await this.exportImage(options, abort.signal);
      saveBlob(result.blob, result.filename);
      this.progressEl.value = 1;
      this.setStatus(`Saved ${result.filename} (${formatBytes(result.blob.size)}).`);
    } catch (error) {
      this.progressEl.hidden = true;
      if (error instanceof DownloadCancelled || abort.signal.aborted) {
        this.setStatus("Download cancelled.");
      } else {
        console.error(error);
        this.setStatus(`The download could not be finished: ${error.message}`);
      }
    } finally {
      this.busy = false;
      this.runAbort = null;
      this.syncControls();
    }
  }

  baseFilename() {
    return `demscore-${slug(this.subject.dataset)}-${slug(this.subject.variable)}`;
  }

  async exportImage(options, signal) {
    const year = this.subject.year;
    this.setStatus(`Drawing ${year}…`);
    const { layout, view } = await this.prepareFrame(options.size, [year]);
    const tiles = await this.loadYearTiles(new TileQueue(signal), view, year);
    throwIfAborted(signal);
    await this.drawFrame(layout, year, tiles);

    const png = await new Promise((resolve, reject) => {
      this.canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The image could not be encoded."))), "image/png");
    });
    const { content } = this.subject;
    const blob = await withPngText(png, {
      Title: `${content.title}, ${year}`,
      Author: "Demscore Hex Map",
      Description: `${content.subtitle}. ${content.legend.caption}.`,
      Copyright: `${content.credits.licenseLabel} (${content.credits.licenseUrl})`,
      Source: window.location.href,
      Comment: content.credits.lines.join("\n"),
      Software: "Demscore Hex Map",
      "Creation Time": new Date().toISOString(),
    });
    return { blob, filename: `${this.baseFilename()}-${year}.png` };
  }

  async exportVideo(options, signal) {
    const years = this.videoYears(options);
    if (years.length === 0) throw new Error("There are no years with data in that range.");
    const codec = this.support?.[options.format];
    if (!codec) throw new Error("This browser cannot encode that video format.");

    this.setStatus("Preparing…");
    const { layout, view } = await this.prepareFrame(options.size, years);
    const framesPerYear = Math.ceil(TARGET_FRAME_RATE / options.speed);
    const frameRate = options.speed * framesPerYear;
    // Sized before the writer sees it: the encoder takes its dimensions from
    // the canvas, and every frame after has to match.
    this.canvas.width = layout.width;
    this.canvas.height = layout.height;

    const { content } = this.subject;
    const writer = await createVideoWriter({
      canvas: this.canvas,
      format: options.format,
      codec,
      frameRate,
      metadata: {
        title: `${content.title}, ${years[0]}–${years[years.length - 1]}`,
        description: `${content.subtitle}. ${content.legend.caption}.`,
        artist: "Demscore Hex Map",
        comment: content.credits.lines.join("\n"),
        date: new Date(),
      },
    });

    const queue = new TileQueue(signal);
    const pending = new Map();
    const want = (index) => {
      if (index >= years.length || pending.has(index)) return;
      const request = this.loadYearTiles(queue, view, years[index]);
      // Fetched ahead and awaited later; a failure must not surface as an
      // unhandled rejection in between.
      request.catch(() => {});
      pending.set(index, request);
    };

    try {
      for (let index = 0; index < years.length; index += 1) {
        for (let ahead = index; ahead <= index + LOOKAHEAD_YEARS; ahead += 1) want(ahead);
        this.setStatus(`Drawing ${years[index]} (${index + 1} of ${years.length})…`);
        const tiles = await pending.get(index);
        pending.delete(index);
        throwIfAborted(signal);

        await this.drawFrame(layout, years[index], tiles);
        // Held until the next year with data, so the speed is calendar years
        // per second, as it is in the app's own autoplay: a variable coded
        // every other year holds each frame for two years' worth.
        const yearsHeld = index < years.length - 1 ? years[index + 1] - years[index] : 1;
        let repeat = framesPerYear * yearsHeld;
        if (index === 0) repeat += Math.round(HOLD_FIRST_SECONDS * frameRate);
        if (index === years.length - 1) repeat += Math.round(HOLD_LAST_SECONDS * frameRate);
        await writer.addFrame(repeat);
        throwIfAborted(signal);
        this.progressEl.value = (index + 1) / (years.length + 1);
      }

      this.setStatus("Finishing the video…");
      const blob = await writer.finish();
      const extension = VIDEO_FORMATS[options.format].extension;
      return { blob, filename: `${this.baseFilename()}-${years[0]}-${years[years.length - 1]}.${extension}` };
    } catch (error) {
      await writer.cancel().catch(() => {});
      throw error;
    }
  }

  setStatus(text) {
    this.statusEl.textContent = text;
  }
}

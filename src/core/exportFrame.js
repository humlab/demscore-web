// One frame of a downloaded image or video: the map with a band above it that
// says what is on it and when, and a band below it with the key to the colours,
// the two logos and the credits the map's licences require.
//
// The bands are drawn here, on the canvas, because a downloaded file is the one
// place the page around the map does not travel with it. The legend, the year
// and the variable's name are HTML on screen; the attribution line is an
// OpenLayers control. None of that is in the tiles, and a map that leaves the
// site without its credit line is a CC BY-NC-SA 4.0 breach -- see
// docs/license_attribution_plan.md in the deployment repo.

import { FALLBACK_SHORT_LINE } from "./attribution.js";
import { NO_DATA_COLOR } from "./palettes.js";

// The frame sizes on offer. `screen` is the map pane as it is, with the bands
// added above and below it; the other two are fixed frames the bands are cut
// out of, for slides and for social media.
export const EXPORT_SIZES = {
  screen: { label: "As on screen" },
  hd: { label: "HD 1920 × 1080", width: 1920, height: 1080 },
  square: { label: "Square 1080 × 1080", width: 1080, height: 1080 },
};
export const DEFAULT_EXPORT_SIZE = "hd";

// The logos, as the About dialog shows them. Both are dark marks for a light
// ground, which is why they sit on the white band and not on the map.
const LOGOS = {
  demscore: "assets/images/demscore-logo.svg",
  infravis: "assets/images/infravis-logo.png",
};

// The handbook tokens from the top of styles.css, read from the page so a
// palette change there reaches the downloads too. The fallbacks are the values
// those tokens hold today.
const TOKEN_FALLBACKS = {
  "--navy": "#1d3c4f",
  "--charcoal": "#3b3838",
  "--muted": "#6b6664",
  "--rule": "#dde4e6",
  "--map-ocean": "#dde4e6",
  "--paper": "#ffffff",
};

const SANS = '"Lato", "Segoe UI", Arial, sans-serif';
const NUMERIC = '"Open Sans", "Lato", "Segoe UI", Arial, sans-serif';

// Every length below is in units of `u`, which is 1 at 1920 x 1080 and scales
// with the square root of the frame's area, so a square frame and a wide one
// set their type at the same apparent size. Floored so a phone-sized "as on
// screen" frame still has legible credits.
const BASE_AREA = 1920 * 1080;
const MIN_UNIT = 0.6;
const MAX_UNIT = 2;

function readTokens() {
  const style = getComputedStyle(document.documentElement);
  const tokens = {};
  for (const [name, fallback] of Object.entries(TOKEN_FALLBACKS)) {
    tokens[name] = style.getPropertyValue(name).trim() || fallback;
  }
  return tokens;
}

function loadImage(path) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${path}`));
    image.src = new URL(path, document.baseURI).href;
  });
}

// The logos and the faces the bands are set in. A canvas does not wait for a
// web font the way a page does: text drawn before the face has loaded is drawn
// in the fallback and stays that way, so the faces are asked for by name first.
export async function loadExportAssets() {
  const [demscore, infravis] = await Promise.all([loadImage(LOGOS.demscore), loadImage(LOGOS.infravis)]);
  if (document.fonts?.load) {
    await Promise.all([
      document.fonts.load(`700 32px ${SANS}`),
      document.fonts.load(`400 16px ${SANS}`),
      document.fonts.load(`700 60px ${NUMERIC}`),
    ]).catch(() => {});
  }
  return { logos: { demscore, infravis }, tokens: readTokens() };
}

function siteAddress() {
  return `${window.location.host}${window.location.pathname.replace(/\/$/, "")}`;
}

function bareUrl(url) {
  return String(url || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
}

// What a downloaded frame has to say about where it came from, as plain
// sentences. Three things, each because something requires it:
// - the indicator data, which every module asks to be credited as a condition
//   of use;
// - the boundary sources, which is the same generated line the map's own
//   credit line carries -- two of them are CC BY-NC-SA 4.0 and one GPL-3.0, and
//   the tiles are adaptations of them ("Modified.");
// - the licence the map itself is offered under, with the address of its deed,
//   because an image cannot carry a link. The site's own address goes with it,
//   which is where the full citations and licence texts are.
export function buildExportCredits({ attributionMeta, dataset, datasetTitle }) {
  const indicator = attributionMeta?.indicatorDatasets?.[dataset];
  const dataName = indicator?.title || datasetTitle || dataset;
  const boundaries =
    typeof attributionMeta?.shortLine === "string" && attributionMeta.shortLine
      ? attributionMeta.shortLine
      : FALLBACK_SHORT_LINE;
  const license = attributionMeta?.mapOutput?.license;
  const licenseLabel = license?.label || "CC BY-NC-SA 4.0";
  const licenseUrl = bareUrl(license?.url || "https://creativecommons.org/licenses/by-nc-sa/4.0/");

  return {
    lines: [
      `Data: ${dataName}, distributed by Demscore (demscore.se).`,
      boundaries,
      `Map: Demscore Hex Map, ${licenseLabel} (${licenseUrl}). Sources and licences: ${siteAddress()}`,
    ],
    licenseLabel,
    licenseUrl,
    dataName,
  };
}

function ellipsize(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

function wrapText(ctx, text, maxWidth, maxLines = Infinity) {
  const lines = [];
  let line = "";
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (!line || ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = ellipsize(ctx, lines.slice(maxLines - 1).join(" "), maxWidth);
    return kept;
  }
  // A single word longer than the measure has nowhere to break.
  return lines.map((entry) => ellipsize(ctx, entry, maxWidth));
}

function unitFor(width, height) {
  return Math.min(MAX_UNIT, Math.max(MIN_UNIT, Math.sqrt((width * height) / BASE_AREA)));
}

// H.264 refuses odd dimensions, and every frame of one video has to be the
// same size, so both are settled here once.
function even(value) {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

// Where everything goes, measured once per download. `content` is what the
// frame says (title, dataset, legend, credits); `years` is every year the
// download will draw, so the header leaves room for the widest of them and
// nothing moves from one frame to the next.
//
// `size` is a key of EXPORT_SIZES; `screenSize` is the map pane's [width,
// height], used when the frame is the screen.
export function layoutExportFrame({ size, screenSize, content, years, assets }) {
  const preset = EXPORT_SIZES[size] || EXPORT_SIZES[DEFAULT_EXPORT_SIZE];
  const fixed = Number.isFinite(preset.width);
  const width = even(fixed ? preset.width : screenSize[0]);
  // Under "as on screen" the map keeps the pane's own size and the bands are
  // added to it, so the unit is judged on the map alone.
  const unitHeight = fixed ? preset.height : screenSize[1];
  const u = unitFor(width, unitHeight);
  const ctx = document.createElement("canvas").getContext("2d");

  const padX = 40 * u;
  const innerWidth = width - 2 * padX;

  // ---- header: the variable's name and its dataset on the left, the year on
  // the right, as big as anything on the frame.
  const yearFont = `700 ${60 * u}px ${NUMERIC}`;
  ctx.font = yearFont;
  const yearWidth = Math.max(...years.map((year) => ctx.measureText(String(year)).width), 0);
  const titleFont = `700 ${32 * u}px ${SANS}`;
  const titleLineHeight = 40 * u;
  ctx.font = titleFont;
  const titleWidth = innerWidth - yearWidth - 32 * u;
  const titleLines = wrapText(ctx, content.title, titleWidth, 2);
  const subtitleFont = `400 ${19 * u}px ${SANS}`;
  const subtitleLineHeight = 26 * u;
  ctx.font = subtitleFont;
  const subtitle = ellipsize(ctx, content.subtitle, titleWidth);
  const headerPadTop = 26 * u;
  const headerHeight = Math.round(
    Math.max(
      headerPadTop + titleLines.length * titleLineHeight + 4 * u + subtitleLineHeight + 22 * u,
      headerPadTop + 72 * u + 22 * u,
    ),
  );

  // ---- footer, first row: the legend on the left, the logos on the right.
  const swatchHeight = 18 * u;
  const legendCaptionFont = `700 ${13 * u}px ${SANS}`;
  const legendLabelFont = `400 ${15 * u}px ${SANS}`;
  ctx.font = legendLabelFont;
  const noDataLabelWidth = ctx.measureText("No data").width;
  const noDataWidth = 26 * u + swatchHeight + 8 * u + noDataLabelWidth;
  // The ramp is as wide as its two end labels need, between a floor that keeps
  // seven swatches readable and a ceiling that keeps it a key rather than a
  // band across the frame. Past the ceiling the labels are clipped, as they
  // are on screen.
  const labelsWidth =
    ctx.measureText(content.legend.low).width + ctx.measureText(content.legend.high).width + 32 * u;
  const rampWidth = Math.min(
    Math.max(46 * u * content.legend.colors.length, labelsWidth),
    560 * u,
    innerWidth - noDataWidth,
  );
  const swatchWidth = rampWidth / content.legend.colors.length;
  const legendWidth = rampWidth + noDataWidth;
  const legendHeight = 13 * u + 10 * u + swatchHeight + 8 * u + 18 * u;

  const demscoreHeight = 34 * u;
  const infravisHeight = 60 * u;
  const demscoreWidth = demscoreHeight * (assets.logos.demscore.naturalWidth / assets.logos.demscore.naturalHeight);
  const infravisWidth = infravisHeight * (assets.logos.infravis.naturalWidth / assets.logos.infravis.naturalHeight);
  const logoGap = 28 * u;
  const logosWidth = demscoreWidth + logoGap + infravisWidth;
  const logosHeight = Math.max(demscoreHeight, infravisHeight);
  // A frame too narrow for both on one row -- a phone's "as on screen" --
  // puts the logos on a row of their own under the legend.
  const logosBesideLegend = legendWidth + 40 * u + logosWidth <= innerWidth;

  // ---- footer, second row: the credits, wrapped to the frame.
  const creditFont = `400 ${13.5 * u}px ${SANS}`;
  const creditLineHeight = 19 * u;
  ctx.font = creditFont;
  const creditLines = content.credits.lines.flatMap((line) => wrapText(ctx, line, innerWidth));

  const footerPadTop = 20 * u;
  const rowOneHeight = logosBesideLegend ? Math.max(legendHeight, logosHeight) : legendHeight + 16 * u + logosHeight;
  const footerHeight = Math.round(
    footerPadTop + rowOneHeight + 16 * u + creditLines.length * creditLineHeight + 18 * u,
  );

  let height;
  let mapHeight;
  if (fixed) {
    height = even(preset.height);
    mapHeight = height - headerHeight - footerHeight;
  } else {
    mapHeight = Math.round(screenSize[1]);
    height = even(headerHeight + mapHeight + footerHeight);
    mapHeight = height - headerHeight - footerHeight;
  }
  if (mapHeight < 80) {
    throw new Error("This frame is too small to hold the map and its credits.");
  }

  return {
    width,
    height,
    u,
    padX,
    tokens: assets.tokens,
    logos: assets.logos,
    map: { left: 0, top: headerHeight, width, height: mapHeight },
    header: {
      height: headerHeight,
      padTop: headerPadTop,
      yearFont,
      titleFont,
      titleLineHeight,
      titleLines,
      subtitleFont,
      subtitleLineHeight,
      subtitle,
    },
    footer: {
      top: headerHeight + mapHeight,
      padTop: footerPadTop,
      rowOneHeight,
      swatchWidth,
      swatchHeight,
      rampWidth,
      legendCaptionFont,
      legendLabelFont,
      legendHeight,
      logosBesideLegend,
      demscoreWidth,
      demscoreHeight,
      infravisWidth,
      infravisHeight,
      logoGap,
      logosWidth,
      logosHeight,
      creditFont,
      creditLineHeight,
      creditLines,
    },
  };
}

// Paints one whole frame: the bands, and `mapCanvas` (already drawn at
// `layout.map`'s size) between them. Only the year differs from one frame of a
// video to the next.
export function drawExportFrame(ctx, layout, content, year, mapCanvas) {
  const { width, height, u, padX, tokens, header, footer } = layout;

  ctx.save();
  ctx.fillStyle = tokens["--paper"];
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = "alphabetic";

  // ---- header
  ctx.fillStyle = tokens["--navy"];
  ctx.font = header.yearFont;
  ctx.textAlign = "right";
  ctx.fillText(String(year), width - padX, header.padTop + 60 * u);

  ctx.textAlign = "left";
  ctx.fillStyle = tokens["--charcoal"];
  ctx.font = header.titleFont;
  let baseline = header.padTop + 31 * u;
  header.titleLines.forEach((line, index) => {
    if (index > 0) baseline += header.titleLineHeight;
    ctx.fillText(line, padX, baseline);
  });
  ctx.fillStyle = tokens["--muted"];
  ctx.font = header.subtitleFont;
  ctx.fillText(header.subtitle, padX, baseline + 8 * u + header.subtitleLineHeight);

  // ---- map
  ctx.drawImage(mapCanvas, layout.map.left, layout.map.top);
  // A hairline either side of the map, so a frame on a white page still has an
  // edge where the ocean meets the band.
  ctx.fillStyle = tokens["--rule"];
  ctx.fillRect(0, layout.map.top, width, Math.max(1, Math.round(u)));
  ctx.fillRect(0, footer.top - Math.max(1, Math.round(u)), width, Math.max(1, Math.round(u)));

  // ---- footer, first row: legend
  const rowTop = footer.top + footer.padTop;
  const legendTop = footer.logosBesideLegend ? rowTop + (footer.rowOneHeight - footer.legendHeight) / 2 : rowTop;
  ctx.fillStyle = tokens["--muted"];
  ctx.font = footer.legendCaptionFont;
  ctx.fillText(content.legend.caption.toUpperCase(), padX, legendTop + 13 * u);

  const rampTop = legendTop + 13 * u + 10 * u;
  content.legend.colors.forEach((color, index) => {
    ctx.fillStyle = color;
    // Rounded outward to whole pixels so neighbouring swatches touch.
    const left = Math.round(padX + index * footer.swatchWidth);
    const right = Math.round(padX + (index + 1) * footer.swatchWidth);
    ctx.fillRect(left, rampTop, right - left, footer.swatchHeight);
  });

  ctx.fillStyle = tokens["--charcoal"];
  ctx.font = footer.legendLabelFont;
  const labelBaseline = rampTop + footer.swatchHeight + 8 * u + 14 * u;
  const halfRamp = footer.rampWidth / 2 - 6 * u;
  ctx.textAlign = "left";
  ctx.fillText(ellipsize(ctx, content.legend.low, halfRamp), padX, labelBaseline);
  ctx.textAlign = "right";
  ctx.fillText(ellipsize(ctx, content.legend.high, halfRamp), padX + footer.rampWidth, labelBaseline);

  const noDataLeft = padX + footer.rampWidth + 26 * u;
  ctx.fillStyle = content.legend.noDataColor || NO_DATA_COLOR;
  ctx.fillRect(noDataLeft, rampTop, footer.swatchHeight, footer.swatchHeight);
  ctx.fillStyle = tokens["--charcoal"];
  ctx.textAlign = "left";
  ctx.fillText("No data", noDataLeft + footer.swatchHeight + 8 * u, rampTop + footer.swatchHeight - 3 * u);

  // ---- footer, first row: logos, right-aligned and centred on the row, or on
  // a row of their own when the legend leaves them no room.
  const logosTop = footer.logosBesideLegend
    ? rowTop + (footer.rowOneHeight - footer.logosHeight) / 2
    : rowTop + footer.legendHeight + 16 * u;
  const logosLeft = footer.logosBesideLegend ? width - padX - footer.logosWidth : padX;
  ctx.drawImage(
    layout.logos.demscore,
    logosLeft,
    logosTop + (footer.logosHeight - footer.demscoreHeight) / 2,
    footer.demscoreWidth,
    footer.demscoreHeight,
  );
  ctx.drawImage(
    layout.logos.infravis,
    logosLeft + footer.demscoreWidth + footer.logoGap,
    logosTop + (footer.logosHeight - footer.infravisHeight) / 2,
    footer.infravisWidth,
    footer.infravisHeight,
  );

  // ---- footer, second row: credits
  ctx.fillStyle = tokens["--muted"];
  ctx.font = footer.creditFont;
  ctx.textAlign = "left";
  let creditBaseline = rowTop + footer.rowOneHeight + 16 * u + 13 * u;
  for (const line of footer.creditLines) {
    ctx.fillText(line, padX, creditBaseline);
    creditBaseline += footer.creditLineHeight;
  }

  ctx.restore();
}

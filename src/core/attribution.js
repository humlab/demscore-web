// The credits, on both of the surfaces that carry them: the one line always
// visible under the map, and the dialog it opens.
//
// Both are built from `/api/config/attribution`, which scripts/build_attribution.sh
// generates from `demscore.countries` -- what geometry is actually drawn -- joined
// to the hand-maintained register in webapp/config/attribution_sources.json. That
// is the whole point of the indirection: a boundary source cannot reach the tiles
// without reaching this file, because the build fails first.

// What the line says when the config never arrived. An attribution that depends
// on a fetch succeeding is not an attribution, so the obligations are named here
// as a constant too. It is deliberately the wording the generator currently
// produces; if the two drift, the generated one is the truth and this is the
// floor.
export const FALLBACK_SHORT_LINE =
  "Boundaries: Natural Earth · CShapes 2.0 & CShapes-Europe (CC BY-NC-SA 4.0) · " +
  "historical-basemaps (GPL-3.0). Modified.";

export const ATTRIBUTION_BUTTON_LABEL = "Sources & licences";
// The data attribute the map delegates its click on; see MapController.
export const ATTRIBUTION_OPEN_ATTR = "data-open-attribution";

export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isUsableAttribution(meta) {
  return Boolean(meta && typeof meta === "object" && typeof meta.shortLine === "string" && meta.shortLine);
}

// Every licence named in the payload, deed URL included, keyed by the label the
// generator writes into `shortLine`.
function licenseLinks(meta) {
  const links = new Map();
  for (const block of Array.isArray(meta?.boundary) ? meta.boundary : []) {
    const license = block?.license;
    if (license?.label && license.url) links.set(license.label, license.url);
  }
  const output = meta?.mapOutput?.license;
  if (output?.label && output.url) links.set(output.label, output.url);
  return links;
}

// The generated sentence with its licence names turned into links to their deeds.
// Working from the generated wording rather than rebuilding it here is what keeps
// the visible line and the dialog from ever naming different sources: there is one
// sentence, and this only decorates it.
//
// Longest label first, so `CC BY-NC-SA 4.0` is matched before a hypothetical
// `CC BY` would eat its opening.
function linkifyLicenses(line, links) {
  const labels = [...links.keys()].sort((a, b) => b.length - a.length);
  let html = escapeHtml(line);
  for (const label of labels) {
    const escaped = escapeHtml(label);
    html = html.replaceAll(
      escaped,
      `<a href="${escapeHtml(links.get(label))}" target="_blank" rel="noopener noreferrer license">${escaped}</a>`,
    );
  }
  return html;
}

// The one string handed to every OpenLayers source. It is built once and reused,
// because `createWmsLayer()` runs on every projection, palette, year and layer
// change, and because OpenLayers shows one entry per *distinct* attribution
// string -- giving the land layer and the hex layer the same string is what makes
// the credit survive either of them being switched off without printing twice.
//
// It must not vary with the year. Three CC BY-NC-SA polygons (both Palestine
// units and Zanzibar) are on the map in 2020 as much as in 1920, so a line that
// appeared only on historical years would be wrong on the years most people look
// at -- see docs/license_attribution_plan.md §1.1.
export function buildAttributionHtml(meta) {
  const line = isUsableAttribution(meta) ? meta.shortLine : FALLBACK_SHORT_LINE;
  const body = isUsableAttribution(meta) ? linkifyLicenses(line, licenseLinks(meta)) : escapeHtml(line);
  // A real button, not a link with a click handler: it opens a dialog on this
  // page, and it has to be reachable from the keyboard inside a control that is
  // otherwise plain text.
  return (
    `${body} ` +
    `<button type="button" class="attribution-open" ${ATTRIBUTION_OPEN_ATTR} ` +
    `aria-haspopup="dialog">${escapeHtml(ATTRIBUTION_BUTTON_LABEL)}</button>`
  );
}

// What a `/api/map-data` row's `geometrySource` is called in front of a reader.
// The payload's keys are table names (`cshapes_europe_extended`); this is the
// register's own label for each. Anything unknown falls through to the raw key
// rather than to nothing -- an unfamiliar name is a smaller lie than a blank.
export function boundaryLabelFor(meta, geometrySource) {
  if (!geometrySource) return "";
  return meta?.sourceLabels?.[geometrySource] || geometrySource;
}

// Which credited work a row's geometry belongs to, so the data table's footnote
// can name the four CShapes tables as the two works they actually are.
export function boundaryCreditFor(meta, geometrySource) {
  for (const block of Array.isArray(meta?.boundary) ? meta.boundary : []) {
    if (block.variants?.some((variant) => variant.sourceDataset === geometrySource)) return block;
  }
  return null;
}

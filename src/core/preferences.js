// Per-visitor UI choices that outlive the page, kept in a cookie so the browser
// carries them between visits without a backend round trip.
const VARIABLE_COOKIE = "demscore_variable_by_dataset";
const MAP_SELECTION_COOKIE = "demscore_map_selection";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function readCookie(name) {
  const prefix = `${name}=`;
  const entry = document.cookie.split("; ").find((part) => part.startsWith(prefix));
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : null;
}

function writeCookie(name, value) {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}

// The variable each dataset was last left on, as `{ [datasetKey]: variable }`.
// A missing, malformed or storage-less cookie just means no memory yet, so
// every failure here reads as an empty map rather than an error.
export function readVariableChoices() {
  try {
    const parsed = JSON.parse(readCookie(VARIABLE_COOKIE) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const choices = {};
    for (const [datasetKey, variable] of Object.entries(parsed)) {
      if (typeof variable === "string" && variable.length > 0) choices[datasetKey] = variable;
    }
    return choices;
  } catch (_) {
    return {};
  }
}

export function writeVariableChoices(choices) {
  try {
    writeCookie(VARIABLE_COOKIE, JSON.stringify(choices));
  } catch (_) {
    // A browser that refuses cookies still works; it just forgets between visits.
  }
}

// The last dataset/variable/year tuple that was actually on the map. It is
// separate from the per-dataset variable memory above: that one makes returning
// to a dataset pleasant, this one restores the page after a refresh.
export function readMapSelection() {
  try {
    const parsed = JSON.parse(readCookie(MAP_SELECTION_COOKIE) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

    const selection = {};
    if (typeof parsed.dataset === "string" && parsed.dataset.length > 0) selection.dataset = parsed.dataset;
    if (typeof parsed.variable === "string" && parsed.variable.length > 0) selection.variable = parsed.variable;
    if (Number.isInteger(parsed.year)) selection.year = parsed.year;

    return selection.dataset || selection.variable || Number.isInteger(selection.year) ? selection : null;
  } catch (_) {
    return null;
  }
}

export function writeMapSelection(selection) {
  try {
    const dataset = typeof selection?.dataset === "string" ? selection.dataset : "";
    const variable = typeof selection?.variable === "string" ? selection.variable : "";
    const year = Number(selection?.year);
    if (!dataset || !variable || !Number.isInteger(year)) return;
    writeCookie(MAP_SELECTION_COOKIE, JSON.stringify({ dataset, variable, year }));
  } catch (_) {
    // A browser that refuses cookies still works; it just forgets between visits.
  }
}

// Whether the map draws a black perimeter around each run of same-coloured
// hexagons. Off is a deliberate choice as much as on, so an unreadable cookie
// falls back to the argument rather than to a hardcoded default.
const AREA_OUTLINES_COOKIE = "demscore_area_outlines";

export function readAreaOutlinesEnabled(fallback) {
  const stored = readCookie(AREA_OUTLINES_COOKIE);
  if (stored === "1") return true;
  if (stored === "0") return false;
  return fallback;
}

export function writeAreaOutlinesEnabled(enabled) {
  try {
    writeCookie(AREA_OUTLINES_COOKIE, enabled ? "1" : "0");
  } catch (_) {
    // A browser that refuses cookies still works; it just forgets between visits.
  }
}

// Which projection the map is drawn in. Equal Earth is the default and the
// reason the mesh exists; Mercator is a deliberate departure from it, so an
// unreadable cookie falls back to the argument rather than to a hardcoded
// choice, the same way the outline toggle does.
const MAP_PROJECTION_COOKIE = "demscore_map_projection";

export function readMapProjection(allowedKeys, fallback) {
  const stored = readCookie(MAP_PROJECTION_COOKIE);
  return allowedKeys.includes(stored) ? stored : fallback;
}

export function writeMapProjection(key) {
  try {
    writeCookie(MAP_PROJECTION_COOKIE, key);
  } catch (_) {
    // A browser that refuses cookies still works; it just forgets between visits.
  }
}

// Which colour scheme the hexagons are painted in. This is the one preference
// here that may be a necessity rather than a taste -- about one man in twelve
// cannot use the red-green channel the default ramp leans on -- so it is worth
// more than the others that it survives a visit. Same shape as the projection:
// an unreadable or unknown cookie falls back to the argument rather than to a
// hardcoded choice, so the caller's default is the only default.
//
// Renamed (`_v2`) when the reader's default moved from Blue-Red to Indigo-amber.
// A stored "default" could not be told apart from a reader who had only ever
// clicked back to where they started, and the point of the change -- nobody
// lands on the red end unless they ask for it -- needed everyone reset once.
const MAP_PALETTE_COOKIE = "demscore_map_palette_v2";

export function readMapPalette(allowedKeys, fallback) {
  const stored = readCookie(MAP_PALETTE_COOKIE);
  return allowedKeys.includes(stored) ? stored : fallback;
}

export function writeMapPalette(key) {
  try {
    writeCookie(MAP_PALETTE_COOKIE, key);
  } catch (_) {
    // A browser that refuses cookies still works; it just forgets between visits.
  }
}

// Which of the two readings of the year is on screen: the map, or the table.
// Kept here with the projection and the palette because it is the same kind of
// choice — one a reader makes for themselves and should not have to make again
// on every visit. Map is the default, and an unreadable or unknown cookie falls
// back to the argument rather than to a hardcoded choice, so the caller's
// default is the only default.
const MAP_VIEW_COOKIE = "demscore_view";

export function readMapView(allowedKeys, fallback) {
  const stored = readCookie(MAP_VIEW_COOKIE);
  return allowedKeys.includes(stored) ? stored : fallback;
}

export function writeMapView(key) {
  try {
    writeCookie(MAP_VIEW_COOKIE, key);
  } catch (_) {
    // A browser that refuses cookies still works; it just forgets between visits.
  }
}

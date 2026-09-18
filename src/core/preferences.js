// Per-visitor UI choices that outlive the page, kept in a cookie so the browser
// carries them between visits without a backend round trip.
const VARIABLE_COOKIE = "demscore_variable_by_dataset";
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

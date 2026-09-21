// The colour schemes the map can be drawn in, and the only place their colours
// are written.
//
// Colour is the map's whole encoding, and which colours work is not the same
// question for every pair of eyes: about one man in twelve cannot use the
// red-green channel, the diverging ramp's classes 2 and 7 print as the same
// grey, and a projector flattens saturation. So the scheme is a choice the
// reader makes, kept in a cookie like the projection and the outlines.
//
// ---- how a scheme reaches the hexagons ----
//
// The hexagons are rendered by MapServer, not by the browser, so a scheme
// cannot be a stylesheet: it has to travel with the tile request. It does that
// through `class_idx`, which MapServer classes on and the DATA query offsets
// per scheme and polarity -- see the CASE in mapserver/mapserver.map and the
// `base` of each band below. A band occupies `base + 1` through `base + 7`.
//
// `scripts/build_hex_classes.mjs` generates mapserver/hex_classes.inc from this
// file, and `scripts/check_palette_contrast.mjs` reads both and fails if they
// have drifted. Edit here, run the generator, never edit the .inc by hand.
//
// ---- bases are permanent ----
//
// A band's `base` is part of every cached tile: mapcache and the service worker
// both key on the request URL, and the URL carries the scheme. Renumbering a
// band would not change any URL, so both caches would go on serving the old
// colours under the new legend -- the one failure mode that looks like working
// software. Add a band at a fresh base; never reuse one.
//
// ---- honoursPolarity ----
//
// The two diverging schemes encode *valence*: one end is the bad end, and
// `polarity` decides which. That is why `signed` is reversed for positive
// polarity rather than a second band existing for it.
//
// The two sequential schemes cannot encode valence -- one ramp, dark to light,
// with no second end to put anything at -- so they run low-to-high always and
// ignore polarity. That is a real loss and it is the trade the reader is
// making: they get a ramp that survives their eyes, and the "which end is bad"
// cue moves entirely into the legend's own end labels, which are words.

// Low to high, in the order the legend bar reads left to right.
const RD_YL_BU = ["#313695", "#4575b4", "#74add1", "#abd9e9", "#fdae61", "#f46d43", "#d73027"];
// viridis, trimmed to 0.15-0.85 so neither end reaches near-black or the yellow
// that would collide with the cream no-data land.
const VIRIDIS = ["#472d7b", "#3b528b", "#2c728e", "#21918c", "#28ae80", "#5ec962", "#addc30"];
// Indigo to amber. The classic colourblind-safe diverging ramps (RdBu, PuOr,
// BrBG) all centre on a near-white class that sits delta-E 5-12 from the cream
// no-data land -- so "no value" would read as the middle of the scale. This one
// is centred on a mid-tone for that reason, and separates far better than
// RdYlBu under simulated deficiency (worst adjacent pair 18.1 against 12.8).
const INDIGO_AMBER = ["#2b2a70", "#4a54a8", "#8b93cf", "#c4bdb0", "#e0a33c", "#b2700f", "#7a4703"];
// cividis, trimmed at the dark end to clear the greyscale floor. Built so that
// a protan or deutan viewer sees very nearly what everyone else does, rather
// than something merely distinguishable.
const CIVIDIS = ["#002d61", "#22496e", "#4a5a6e", "#70706d", "#97906b", "#c1ac60", "#f2df4a"];

export const CLASS_COUNT = 7;

export const MAP_PALETTES = {
  default: {
    label: "Default",
    // Shown in the picker and in the map's spoken summary.
    description: "Blue to red, with red at the unfavourable end.",
    honoursPolarity: true,
    signed: { base: 0, colors: RD_YL_BU },
    neutral: { base: 10, colors: VIRIDIS },
    directionHint: {
      positive: "Higher values are mapped to blue tones.",
      negative: "Higher values are mapped to red tones.",
      neutral: "Higher values run from deep purple through teal to light green.",
    },
  },
  indigo_amber: {
    label: "Indigo–amber",
    description: "Indigo to amber, with amber at the unfavourable end. Keeps the direction the default carries, and separates further apart for red-green colour blindness.",
    honoursPolarity: true,
    // Shares viridis for unsigned variables: this scheme replaces the diverging
    // ramp, and there is nothing wrong with viridis for a variable that has no
    // favourable end to begin with.
    signed: { base: 20, colors: INDIGO_AMBER },
    neutral: { base: 10, colors: VIRIDIS },
    directionHint: {
      positive: "Higher values are mapped to indigo tones.",
      negative: "Higher values are mapped to amber tones.",
      neutral: "Higher values run from deep purple through teal to light green.",
    },
  },
  viridis: {
    label: "Viridis",
    description: "One ramp for every variable, dark purple to light green, always low to high. Steady in lightness, so it survives greyscale and a projector as well as colour blindness.",
    honoursPolarity: false,
    signed: { base: 10, colors: VIRIDIS },
    neutral: { base: 10, colors: VIRIDIS },
    directionHint: {
      all: "Higher values run from deep purple through teal to light green, whichever end of the scale is the favourable one.",
    },
  },
  cividis: {
    label: "Cividis",
    description: "One ramp for every variable, dark blue to yellow, always low to high. Built so that red-green colour blindness sees very nearly what everyone else does.",
    honoursPolarity: false,
    signed: { base: 30, colors: CIVIDIS },
    neutral: { base: 30, colors: CIVIDIS },
    directionHint: {
      all: "Higher values run from dark blue through grey-olive to yellow, whichever end of the scale is the favourable one.",
    },
  },
};

export const PALETTE_KEYS = Object.keys(MAP_PALETTES);
export const DEFAULT_PALETTE_KEY = "default";

export function getPalette(key) {
  return MAP_PALETTES[key] || MAP_PALETTES[DEFAULT_PALETTE_KEY];
}

// Every distinct band, once, keyed by base. Two schemes share the viridis band,
// so this is what the generator emits rather than one block per scheme.
export function paletteBands() {
  const bands = new Map();
  for (const palette of Object.values(MAP_PALETTES)) {
    for (const band of [palette.signed, palette.neutral]) {
      const existing = bands.get(band.base);
      if (existing && existing.join() !== band.colors.join()) {
        throw new Error(`two different ramps claim class_idx base ${band.base}`);
      }
      bands.set(band.base, band.colors);
    }
  }
  return [...bands.entries()].sort((a, b) => a[0] - b[0]);
}

// The bar, low to high left to right, for one scheme and one polarity.
//
// A scheme that honours polarity has one band for signed variables, and
// positive polarity reverses it -- the mapfile does the same reversal in SQL
// (`base + (8 - class_idx)`), so the bar and the map cannot disagree about
// which end is which.
export function legendColorsFor(paletteKey, polarity) {
  const palette = getPalette(paletteKey);
  if (!palette.honoursPolarity) return palette.signed.colors;
  if (polarity === "neutral") return palette.neutral.colors;
  return polarity === "positive" ? palette.signed.colors.slice().reverse() : palette.signed.colors;
}

export function directionHintFor(paletteKey, polarity) {
  const hints = getPalette(paletteKey).directionHint;
  return hints.all || hints[polarity] || hints.negative;
}

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
// Green, pale to dark: low values pale, high values dark, so darker reads as
// more -- the way most readers take a single-hue ramp. The Red – Blue scheme's
// ramp for neutral variables. It replaced magma (black through purple and
// orange to pale yellow), which ran in lightness but not in any way a reader
// could name: nothing about black-to-yellow says which end is "more". One hue
// from pale to dark does, and green shares no hue with either end of RD_YL_BU
// beside it. Its palest class is kept off the ocean (`--map-ocean`, delta-E 21),
// which check_palette_contrast.mjs does not measure.
const GREEN = ["#d2edc9", "#a5d99d", "#74c476", "#41ab5d", "#238b45", "#0b6b2f", "#00441b"];
// Pale magenta to dark purple, low to high, as GREEN above: the Brown – Blue
// scheme's ramp for neutral variables, which have no better or worse end. It
// replaced an indigo-to-yellow ramp that opened on the very two indigos of
// INDIGO_AMBER, so the low values of a neutral map looked like the favourable
// end of a democracy map; purple and magenta share no hue with either end of
// INDIGO_AMBER. The darkest class is darker than a plain purple-magenta ramp's,
// to clear the greyscale floor between the two darkest classes (6 and 7). Its
// palest class is kept off the ocean (`--map-ocean`, delta-E 19), which
// check_palette_contrast.mjs does not measure.
const PURPLE_MAGENTA = ["#f9cdd2", "#f09cb0", "#db6e98", "#b9478f", "#8e2a86", "#651a6e", "#2e0840"];
// cividis, trimmed at the dark end to clear the greyscale floor. Built so that
// a protan or deutan viewer sees very nearly what everyone else does, rather
// than something merely distinguishable.
const CIVIDIS = ["#002d61", "#22496e", "#4a5a6e", "#70706d", "#97906b", "#c1ac60", "#f2df4a"];

export const CLASS_COUNT = 7;

// What a present-day country with no value for the variable-year is painted in.
// It used to be the land basemap showing through where no hexagon was drawn,
// and that made the hexagons' own ragged coastline visible as a cream fringe
// round every country -- the "odd white space" the client noticed. Painting
// those countries as hexagons too makes the map hexagons edge to edge.
//
// It sits in no band and is the same under every scheme and polarity, so it
// has a class of its own (`class_idx` 99, outside every base + 1..7 -- and,
// like a base, permanent). Mid grey, not light: anything light enough to read
// as "empty" lands within delta-E 16 of Indigo-amber's middle class, which
// would make "no value" read as "middling value". This one clears every
// *offered* class by 23; it does collide with withdrawn Cividis, and
// scripts/check_palette_contrast.mjs will say so if that is ever offered again.
export const NO_DATA_CLASS_IDX = 99;
export const NO_DATA_COLOR = "#808080";

export const MAP_PALETTES = {
  // The names are the ones the client's mockup of the scheme dropdown uses: what
  // the two ends look like, in the order the legend bar shows them for a
  // variable where higher is better.
  default: {
    label: "Red – Blue",
    neutralLabel: "Green",
    // The tooltip on the scheme's option in the Colours dropdown, for the
    // variable on the map: `description` when it has a better and a worse end,
    // `neutralDescription` when it has neither (polarity "neutral", e.g.
    // cabinet composition). Every scheme that honours polarity needs both, or
    // a neutral variable is described with the other's words -- which is how
    // "Cabinet composition" came to be told it had an unfavourable end. They
    // are for readers: what the colours run between, not why the scheme was
    // chosen, and not which end is better -- that is the legend's end labels'
    // job, in the words the codebook uses.
    description: "Red to blue, from one end of the scale to the other.",
    neutralDescription: "Pale green to dark green, from low to high values. Neither end is better or worse.",
    honoursPolarity: true,
    signed: { base: 0, colors: RD_YL_BU },
    neutral: { base: 40, colors: GREEN },
  },
  indigo_amber: {
    label: "Brown – Blue",
    neutralLabel: "Purple – Magenta",
    description: "Brown to blue, from one end of the scale to the other.",
    neutralDescription: "Pale magenta to dark purple, from low to high values. Neither end is better or worse.",
    honoursPolarity: true,
    signed: { base: 20, colors: INDIGO_AMBER },
    neutral: { base: 50, colors: PURPLE_MAGENTA },
  },
  viridis: {
    label: "Viridis",
    description: "One ramp for every variable, dark purple to light green, always low to high. Steady in lightness, so it survives greyscale and a projector as well as colour blindness.",
    // Withdrawn from the picker at the client's request, with cividis. Kept
    // here rather than deleted: its band is still generated into
    // hex_classes.inc and the mapfile still serves it, so offering it again is
    // this one flag -- and its base stays claimed, which it must anyway.
    offered: false,
    honoursPolarity: false,
    signed: { base: 10, colors: VIRIDIS },
    neutral: { base: 10, colors: VIRIDIS },
  },
  cividis: {
    label: "Cividis",
    description: "One ramp for every variable, dark blue to yellow, always low to high. Built so that red-green colour blindness sees very nearly what everyone else does.",
    // Withdrawn from the picker; see viridis above.
    offered: false,
    honoursPolarity: false,
    signed: { base: 30, colors: CIVIDIS },
    neutral: { base: 30, colors: CIVIDIS },
  },
};

// Two different "defaults", and they must not be confused.
//
// SERVER_DEFAULT_PALETTE_KEY is what MapServer paints when a request names no
// `palette` -- the mapfile's `default_palette`, Blue-Red. Every tile cached
// before the scheme picker existed is under a URL with no `palette` in it, so
// this cannot change without repainting those tiles under unchanged URLs (see
// "bases are permanent" above, which is the same trap).
//
// DEFAULT_PALETTE_KEY is what a reader who has never chosen sees. It became
// Indigo-amber at the client's request, over the red end's connotations, and
// since that is not the server's default it is always named in the request.
export const SERVER_DEFAULT_PALETTE_KEY = "default";
export const DEFAULT_PALETTE_KEY = "indigo_amber";

// The schemes the reader may pick, the reader's default first. MAP_PALETTES
// keeps its own order because the generator walks it.
export const PALETTE_KEYS = Object.keys(MAP_PALETTES)
  .filter((key) => MAP_PALETTES[key].offered !== false)
  .sort((a, b) => (b === DEFAULT_PALETTE_KEY) - (a === DEFAULT_PALETTE_KEY));

export function getPalette(key) {
  return MAP_PALETTES[key] || MAP_PALETTES[DEFAULT_PALETTE_KEY];
}

// Every distinct band, once, keyed by base. This is what the generator emits
// rather than one block per scheme.
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

export function paletteLabelFor(paletteKey, polarity) {
  const palette = getPalette(paletteKey);
  return polarity === "neutral" && palette.neutralLabel ? palette.neutralLabel : palette.label;
}

export function paletteDescriptionFor(paletteKey, polarity) {
  const palette = getPalette(paletteKey);
  return polarity === "neutral" && palette.neutralDescription ? palette.neutralDescription : palette.description;
}

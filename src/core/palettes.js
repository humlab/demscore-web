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
// software. Add a band at a fresh base; never reuse one, including the retired
// ones in RETIRED_BASES.
//
// ---- honoursPolarity ----
//
// The two diverging schemes encode *valence*: one end is the bad end, and
// `polarity` decides which. That is why `band` is reversed for positive
// polarity rather than a second band existing for it.
//
// A neutral variable (no better or worse end, e.g. cabinet composition) is
// drawn in the same band, the way round the scheme's name reads: low values at
// the first-named colour, high at the second -- the orientation positive
// polarity gets. Each scheme used to give neutral variables a band of its own
// (Green under Red - Blue, Purple - Magenta under Brown - Blue), which made the
// reader's choice of scheme look different on every REPDEM variable; the client
// asked for one scheme to mean one set of colours. What says "neither end is
// better" now is the legend's end labels and `neutralDescription`, not a hue.
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

// Bases that once held a band and must never hold another: 40 was Red - Blue's
// neutral ramp (magma, then green) and 50 Brown - Blue's (indigo to yellow,
// teal, then purple to magenta). paletteBands() refuses a band on either.
export const RETIRED_BASES = [40, 50];

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
    neutralDescription: "Red to blue, from low to high values. Neither end is better or worse.",
    honoursPolarity: true,
    band: { base: 0, colors: RD_YL_BU },
  },
  indigo_amber: {
    label: "Brown – Blue",
    description: "Brown to blue, from one end of the scale to the other.",
    neutralDescription: "Brown to blue, from low to high values. Neither end is better or worse.",
    honoursPolarity: true,
    band: { base: 20, colors: INDIGO_AMBER },
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
    band: { base: 10, colors: VIRIDIS },
  },
  cividis: {
    label: "Cividis",
    description: "One ramp for every variable, dark blue to yellow, always low to high. Built so that red-green colour blindness sees very nearly what everyone else does.",
    // Withdrawn from the picker; see viridis above.
    offered: false,
    honoursPolarity: false,
    band: { base: 30, colors: CIVIDIS },
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
  for (const { band } of Object.values(MAP_PALETTES)) {
    if (RETIRED_BASES.includes(band.base)) {
      throw new Error(`class_idx base ${band.base} is retired and cannot be reused`);
    }
    const existing = bands.get(band.base);
    if (existing && existing.join() !== band.colors.join()) {
      throw new Error(`two different ramps claim class_idx base ${band.base}`);
    }
    bands.set(band.base, band.colors);
  }
  return [...bands.entries()].sort((a, b) => a[0] - b[0]);
}

// The bar, low to high left to right, for one scheme and one polarity.
//
// A scheme that honours polarity has one band, and positive and neutral
// polarity reverse it -- the mapfile does the same reversal in SQL
// (`base + (8 - class_idx)`), so the bar and the map cannot disagree about
// which end is which.
export function legendColorsFor(paletteKey, polarity) {
  const palette = getPalette(paletteKey);
  const reversed = palette.honoursPolarity && (polarity === "positive" || polarity === "neutral");
  return reversed ? palette.band.colors.slice().reverse() : palette.band.colors;
}

export function paletteLabelFor(paletteKey) {
  return getPalette(paletteKey).label;
}

export function paletteDescriptionFor(paletteKey, polarity) {
  const palette = getPalette(paletteKey);
  return polarity === "neutral" && palette.neutralDescription ? palette.neutralDescription : palette.description;
}

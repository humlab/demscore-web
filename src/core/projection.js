// The map is drawn in Equal Earth (EPSG:8857), the 2018 equal-area
// pseudocylindrical projection, and so is every hexagon MapServer serves.
//
// The choice is not cosmetic. Web Mercator scales area by sec^2(latitude), so
// it was inflating exactly the countries these indicators are most often read
// about, and the hex mesh inherited the distortion wholesale. In Equal Earth
// one hexagon is one real area anywhere on the map, which is the only reading
// that makes a hexagon count mean anything.
//
// Web Mercator is still offered, as a toggle rather than a default, because
// comparing the two is the clearest way to see what the projection does to the
// data -- and because it is the shape of the world most people have in mind.
//
// Each projection has a mesh of its own, cut in its own plane. Reprojecting one
// mesh into the other is not an option: a hexagon is a hexagon only in the plane
// it was cut in, and an Equal Earth cell pushed into Mercator is drawn twice as
// tall as it is wide by 60N and as a sliver by 80N, at which point the map stops
// reading as a hex map. What the toggle compares is what a cell *means* -- a
// fixed amount of ground against a fixed amount of screen -- not how well one
// mesh survives being stretched.

// Web Mercator's own resolution ladder, kept deliberately, and shared by both
// projections. A zoom level therefore denotes the same metres per pixel it
// always did, in either projection, so the hex resolution stops, the zoom
// readout and the +/- step all carry over unchanged and mean the same thing on
// both sides of the toggle. The WMS tile grid is denser than the readout's
// whole levels so fractional zooms do not scale MapServer's raster strokes far
// enough to make outlines visibly change weight.
const ZOOM_ZERO_RESOLUTION = 156543.03392804097;
const TILE_GRID_MAX_ZOOM = 9;
const TILE_GRID_ZOOM_STEP = 0.25;
const TILE_SIZE = 512;

export const EQUAL_EARTH_CODE = "EPSG:8857";
export const WEB_MERCATOR_CODE = "EPSG:3857";

export const EQUAL_EARTH_PROJ4 =
  "+proj=eqearth +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs";

// The Equal Earth world box in projected metres, from PROJ.
//
// These are NOT the transforms of (-180,-90) and (180,90). Equal Earth is at
// its widest on the equator, where x reaches +/-17243959, and narrows to
// +/-10216474 at the poles; a box built from the corners would be 41% too
// narrow and would cut off everything east of about 106E. Every extent in the
// stack -- here, the mapfile, the mapcache preloader -- comes from these two
// numbers for that reason.
export const EQUAL_EARTH_HALF_X = 17243959.06221695;
export const EQUAL_EARTH_HALF_Y = 8392927.598466456;

// Web Mercator's square world, pi * 6378137.
const WEB_MERCATOR_HALF = 20037508.342789244;

// Keep the hex layer generalized at the broadest world views, then step into
// denser meshes as soon as the world is large enough for Denmark-scale
// countries to read. Both ladders match increments precomputed in the database,
// and the Mercator sizes are exactly twice the Equal Earth ones: a Mercator
// cell of a given size covers ground area proportional to cos^2(latitude), so
// its mesh carries a surplus towards the poles and reaching the same cell count
// takes a nominally larger cell. Measured at the sizes this ladder used to
// start from, Mercator 200k gives 5 917 cells against Equal Earth 100k's 5 690.
//
// Those are the middle stop now: the whole ladder is deliberately one doubling
// coarser than that measurement, because a cell small enough to resolve a
// country's interior is smaller than anything the map is actually read at. A
// hexagon is a unit of "this country's score here", not a pixel, and at the
// world view a few thousand of them is noise in the shape of detail.
//
// Three stops, not more. Crossing a threshold changes hex_size, and hex_size is
// a WMS dimension, so every tile on screen is a cache miss the moment it moves:
// a stop is a full mesh reload, and a zoom from the world view to the closest
// view pays for each one it passes. Three keeps that to two reloads, and the
// grain halves at each so the steps land evenly rather than one crossing being
// visibly larger than the rest.
//
// The coarsest stop is also what the mapcache preloader warms and what the
// mapfile falls back to (default_hex_size), so moving it means moving those
// together or the warm cache is warm for a size nothing asks for.
//
// The zoom thresholds are shared, and can be, because both projections use Web
// Mercator's resolution ladder -- a zoom level means the same scale in either,
// so the same threshold picks the same grain. They divide the 0-6 range evenly,
// so no single grain carries a disproportionate stretch of the zoom.
const HEX_ZOOM_THRESHOLDS = [0, 2, 4];

function hexResolutionStops(sizes) {
  return HEX_ZOOM_THRESHOLDS.map((minZoom, index) => ({ minZoom, hexSizeM: sizes[index] }));
}

// The ladder as an array, for the WMS tile grids. The index is only OpenLayers'
// tile-grid z; the app zoom behind an entry is index * TILE_GRID_ZOOM_STEP.
const RESOLUTIONS = Array.from(
  { length: Math.floor(TILE_GRID_MAX_ZOOM / TILE_GRID_ZOOM_STEP) + 1 },
  (_unused, index) => ZOOM_ZERO_RESOLUTION / 2 ** (index * TILE_GRID_ZOOM_STEP),
);

// Zoom and resolution are converted through the ladder rather than through the
// view, deliberately. OpenLayers anchors its own zoom numbering to whatever
// resolution the view was given as its maximum, which moves every time the
// world-fit floor is re-measured and differs between the two projections; the
// app's zoom has to mean one fixed thing -- Web Mercator metres per pixel -- for
// the hex stops and the readout to survive a resize or a projection switch.
export function resolutionForZoom(zoom) {
  return ZOOM_ZERO_RESOLUTION / 2 ** zoom;
}

export function zoomForResolution(resolution) {
  return Math.log2(ZOOM_ZERO_RESOLUTION / resolution);
}

// The coarsest resolution at which the whole world still fits the window. Both
// axes are measured and the larger answer wins, so nothing is ever cropped.
export function worldFitResolution(extent, size) {
  const [width, height] = [extent[2] - extent[0], extent[3] - extent[1]];
  return Math.max(width / size[0], height / size[1]);
}

let projectionsRegistered = false;

function registerProjections() {
  if (projectionsRegistered) return;

  proj4.defs(EQUAL_EARTH_CODE, EQUAL_EARTH_PROJ4);
  // EPSG:3857 and EPSG:4326 are already OpenLayers' own, and register() leaves
  // an existing transform alone, so Web Mercator keeps OpenLayers' version --
  // which matters, because it clamps the poles to a finite y where proj4 hands
  // back an infinity that no canvas can draw.
  ol.proj.proj4.register(proj4);

  const equalEarth = ol.proj.get(EQUAL_EARTH_CODE);
  equalEarth.setExtent([
    -EQUAL_EARTH_HALF_X,
    -EQUAL_EARTH_HALF_Y,
    EQUAL_EARTH_HALF_X,
    EQUAL_EARTH_HALF_Y,
  ]);
  equalEarth.setWorldExtent([-180, -90, 180, 90]);
  // An equal-area projection stretches and squeezes as it goes, so OpenLayers'
  // geodesic estimate of "metres per pixel here" disagrees with the plane's own
  // by up to a third depending on where you stand. The plane's own is what the
  // tile grid, the hex stops and the zoom readout are all counted in.
  equalEarth.setGetPointResolution((resolution) => resolution);

  projectionsRegistered = true;
}

// Both worlds are boxes with the origin at their centre, so a tile grid is just
// the ladder hung off the north-west corner -- the same corner the mapcache
// preloader counts tiles from.
function createTileGrid(extent) {
  return new ol.tilegrid.TileGrid({
    extent,
    origin: [extent[0], extent[3]],
    resolutions: RESOLUTIONS,
    tileSize: TILE_SIZE,
  });
}

const PROJECTION_DEFINITIONS = {
  equalEarth: {
    key: "equalEarth",
    code: EQUAL_EARTH_CODE,
    label: "Equal Earth",
    title: "Equal Earth (EPSG:8857) — every hexagon covers the same real area",
    wmsLayers: { fill: "hex_variable", outline: "hex_outline" },
    hexResolutionStops: hexResolutionStops([200000, 100000, 50000]),
    extent: [
      -EQUAL_EARTH_HALF_X,
      -EQUAL_EARTH_HALF_Y,
      EQUAL_EARTH_HALF_X,
      EQUAL_EARTH_HALF_Y,
    ],
  },
  webMercator: {
    key: "webMercator",
    code: WEB_MERCATOR_CODE,
    label: "Mercator",
    title: "Web Mercator (EPSG:3857) — hexagons swell towards the poles",
    // A second set of layers over a second mesh, not the first mesh reprojected.
    // See the note above hex_variable_mercator in mapserver/mapserver.map.
    wmsLayers: { fill: "hex_variable_mercator", outline: "hex_outline_mercator" },
    hexResolutionStops: hexResolutionStops([400000, 200000, 100000]),
    extent: [
      -WEB_MERCATOR_HALF,
      -WEB_MERCATOR_HALF,
      WEB_MERCATOR_HALF,
      WEB_MERCATOR_HALF,
    ],
  },
};

export const DEFAULT_PROJECTION_KEY = "equalEarth";
export const PROJECTION_KEYS = Object.keys(PROJECTION_DEFINITIONS);

const resolved = new Map();

// Everything the map needs to be drawn in one projection: the OpenLayers
// projection, the world box the view and the tile grid are cut to, and the tile
// grid itself. Built once per projection and reused, so a toggle back and forth
// does not hand the WMS source a new grid each time.
export function getMapProjection(key) {
  registerProjections();

  const definition = PROJECTION_DEFINITIONS[key] || PROJECTION_DEFINITIONS[DEFAULT_PROJECTION_KEY];
  const cached = resolved.get(definition.key);
  if (cached) return cached;

  const entry = {
    ...definition,
    projection: ol.proj.get(definition.code),
    tileGrid: createTileGrid(definition.extent),
  };
  resolved.set(definition.key, entry);
  return entry;
}

// Moves the view's centre from one projection to the other so a toggle keeps
// looking at the same place. The trip goes through lon/lat rather than straight
// between the two planes because the latitude has to be clipped on the way into
// Mercator, where the poles are infinitely far away and Equal Earth's are not.
export function transferCenter(center, fromKey, toKey) {
  const from = getMapProjection(fromKey);
  const to = getMapProjection(toKey);
  if (from.code === to.code) return center;

  const [lng, lat] = ol.proj.transform(center, from.projection, "EPSG:4326");
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return [0, 0];

  const worldExtent = to.projection.getWorldExtent();
  const clampedLat = Math.min(Math.max(lat, worldExtent[1]), worldExtent[3]);
  return ol.proj.transform([lng, clampedLat], "EPSG:4326", to.projection);
}

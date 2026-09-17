// The map is drawn in Equal Earth (EPSG:8857), the 2018 equal-area
// pseudocylindrical projection, and so is every hexagon MapServer serves.
//
// The choice is not cosmetic. Web Mercator scales area by sec^2(latitude), so
// it was inflating exactly the countries these indicators are most often read
// about, and the hex mesh inherited the distortion wholesale. In Equal Earth
// one hexagon is one real area anywhere on the map, which is the only reading
// that makes a hexagon count mean anything.

// Web Mercator's own resolution ladder, kept deliberately. Reusing it means a
// zoom level denotes the same metres per pixel it always did, so the hex
// resolution stops, the zoom readout and the +/- step all carry over unchanged;
// only the shape of the world underneath them changed. Ten levels is three more
// than MAX_ZOOM needs, which leaves room to raise it without touching this.
const ZOOM_ZERO_RESOLUTION = 156543.03392804097;
const ZOOM_LEVEL_COUNT = 10;

export const EQUAL_EARTH_PROJ4 =
  "+proj=eqearth +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs";

// The world box in projected metres, from PROJ.
//
// These are NOT the transforms of (-180,-90) and (180,90). Equal Earth is at
// its widest on the equator, where x reaches +/-17243959, and narrows to
// +/-10216474 at the poles; a box built from the corners would be 41% too
// narrow and would cut off everything east of about 106E. Every extent in the
// stack -- here, the mapfile, the mapcache preloader -- comes from these two
// numbers for that reason.
export const EQUAL_EARTH_HALF_X = 17243959.06221695;
export const EQUAL_EARTH_HALF_Y = 8392927.598466456;

export function equalEarthProjectedBounds() {
  return L.bounds(
    L.point(-EQUAL_EARTH_HALF_X, -EQUAL_EARTH_HALF_Y),
    L.point(EQUAL_EARTH_HALF_X, EQUAL_EARTH_HALF_Y),
  );
}

// Equal Earth fills a lens, not the rectangle that bounds it, and Leaflet does
// not know that. Whenever the world does not exactly fill the window -- which is
// almost always, the world being a fixed 2.055:1 box inside a window of whatever
// shape -- Leaflet unprojects the corners of the letterboxed viewport, and those
// corners are off the globe. proj4 answers with a NaN latitude there, and
// GridLayer._updateLevels turns that into "Invalid LatLng object" and takes the
// whole map down with it on the very first paint.
//
// So the projection is extended to the whole plane. Leaflet's own use of it is a
// round trip -- project(unproject(pixelOrigin)) -- so what it needs from the
// points outside the globe is not that they mean anything but that they survive
// the trip unchanged. Inside the globe this is Equal Earth exactly; outside, it
// continues smoothly on two facts about the projection:
//
//   * x is exactly proportional to longitude at a fixed latitude, so a longitude
//     past +/-180 extends the same straight line rather than wrapping the way
//     proj4 does -- and wrapping is what would break the round trip;
//   * y past the pole cannot follow the real curve, whose slope in latitude
//     falls to zero exactly there. It follows a straight line of the projection's
//     own average slope instead, which is invertible where the true curve is not.
//
// Latitudes beyond +/-90 are therefore fictitious. They never reach the user:
// they exist only between Leaflet's unproject and the project that immediately
// undoes it.
function extendProjectionBeyondTheGlobe(projection) {
  const transform = proj4("EPSG:4326", EQUAL_EARTH_PROJ4);
  const POLE_LAT = 90;
  const MAX_LNG = 180;
  const poleY = transform.forward([0, POLE_LAT])[1];
  // Metres of y per degree of latitude used past the pole. The real slope there
  // is zero, so any constant will do as long as it is not; the projection's own
  // mean is the least arbitrary one available.
  const beyondPoleMetresPerDegree = poleY / POLE_LAT;
  const xPerLng = (lat) => transform.forward([1, lat])[0];

  projection.project = (latlng) => {
    const { lat, lng } = latlng;
    if (Math.abs(lat) <= POLE_LAT && Math.abs(lng) <= MAX_LNG) {
      const [x, y] = transform.forward([lng, lat]);
      return L.point(x, y);
    }

    const overshoot = Math.max(Math.abs(lat) - POLE_LAT, 0);
    const clampedLat = Math.sign(lat) * Math.min(Math.abs(lat), POLE_LAT);
    return L.point(
      lng * xPerLng(clampedLat),
      Math.sign(lat) * (Math.abs(transform.forward([0, clampedLat])[1])
        + overshoot * beyondPoleMetresPerDegree),
    );
  };

  // Deliberately never asks proj4 for the longitude. Its inverse wraps a
  // longitude past +/-180 back into range, and a wrapped longitude is
  // indistinguishable from a real one -- a point just east of the map's right
  // edge comes back as a point on its left, and the round trip returns it half a
  // world away. Latitude is read on the central meridian, where y depends on
  // nothing else and the inverse is well conditioned; longitude then follows
  // from x, which is exactly proportional to it.
  projection.unproject = (point) => {
    // Exactly on the pole line the inverse sits on its own boundary and can come
    // back NaN, so that case falls through to the pole rather than trusting it.
    const beyondPole = Math.max(Math.abs(point.y) - poleY, 0);
    const onMeridian = beyondPole > 0 ? NaN : transform.inverse([0, point.y])[1];
    const latOnGlobe = Number.isFinite(onMeridian)
      ? onMeridian
      : Math.sign(point.y) * POLE_LAT;

    return L.latLng(
      Math.sign(point.y) * (Math.abs(latOnGlobe) + beyondPole / beyondPoleMetresPerDegree),
      point.x / xPerLng(latOnGlobe),
    );
  };

  return projection;
}

// Proj4Leaflet needs the resolution ladder spelled out: unlike Web Mercator it
// cannot derive one, because the world is not a square it can halve.
export function createEqualEarthCrs() {
  proj4.defs("EPSG:8857", EQUAL_EARTH_PROJ4);

  const crs = new L.Proj.CRS("EPSG:8857", EQUAL_EARTH_PROJ4, {
    // Top-left of the world box: tile (0,0) starts at the north-west corner,
    // which is what the mapcache preloader's tile maths assumes as well.
    origin: [-EQUAL_EARTH_HALF_X, EQUAL_EARTH_HALF_Y],
    bounds: equalEarthProjectedBounds(),
    resolutions: Array.from(
      { length: ZOOM_LEVEL_COUNT },
      (_unused, zoom) => ZOOM_ZERO_RESOLUTION / 2 ** zoom,
    ),
  });

  extendProjectionBeyondTheGlobe(crs.projection);
  return crs;
}

// Leaflet limits panning by projecting the two corners of a LatLngBounds, and
// no lat/lon box can describe the Equal Earth world: its widest point is on the
// equator while a box's corners are at the poles, and proj4 wraps longitudes
// past +/-180 rather than letting the box be widened past them. Left alone,
// maxBounds would confine the viewport to x +/-10216474 and put Indonesia,
// Australia and Japan permanently out of reach.
//
// So the limit is taken from the CRS's own projected bounds -- the same
// rectangle MapServer renders -- and Leaflet's own rebound easing is reused so
// maxBoundsViscosity still behaves. The map keeps a maxBounds only because
// Leaflet skips this check entirely when it is absent.
export function limitPanningToProjectedWorld(map) {
  map._getBoundsOffset = (pixelBounds, _maxBounds, zoom) => {
    const world = map.options.crs.getProjectedBounds(
      zoom === undefined ? map.getZoom() : zoom,
    );
    if (!world) return L.point(0, 0);

    return L.point(
      map._rebound(world.min.x - pixelBounds.min.x, -(world.max.x - pixelBounds.max.x)),
      map._rebound(world.min.y - pixelBounds.min.y, -(world.max.y - pixelBounds.max.y)),
    );
  };
}

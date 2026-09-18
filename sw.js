// v6: WMS tile resolutions are quarter-zoom stops now, reducing raster scaling
// so MapServer strokes keep a steadier apparent weight between continuous zooms.
//
// v5: the low-zoom mesh ladder gained an intermediate stop, so old WMS tiles
// should not influence visual checks while the browser settles onto the new
// hex_size requests.
//
// v4: the map is drawn by OpenLayers now, over two meshes rather than one.
//
// Neither the Equal Earth URLs nor the Mercator ones can be served out of an
// older cache. OpenLayers spells a tile's BBOX from the grid origin and the
// resolution directly, where Leaflet arrived at it through a round trip in and
// out of lat/lon -- the numbers agree to about a millionth of a metre and the
// strings do not -- and the projection toggle asks for different layers in a
// different SRS again. Left alone the old entries would sit in returning users'
// browsers forever, matching nothing; the version is part of the name so
// activate can drop them.
//
// The toggle puts two sets of tiles in here rather than one, over two different
// meshes. Nothing below needs to tell them apart: the layer names, the SRS and
// the BBOX all ride along in the URL that is the cache key, so the two caches
// are the same cache and can never collide.
const WMS_TILE_CACHE = "demscore-wms-tile-cache-v6";

// The fills may be asked for alone or together with the outline layer that rides
// along in the same GetMap (see MapController.wmsLayerNames), and the two spell
// different LAYERS values. Matching one exact string meant the default request,
// "hex_variable,hex_outline", was never recognised: the preloader filled the cache
// and nothing was ever served out of it, so every autoplay frame paid for a fresh
// MapServer render. Hence a set, not a string -- but still a closed one, so this
// never becomes a cache for arbitrary layers.
const CACHEABLE_WMS_LAYERS = new Set([
  "hex_variable",
  "hex_outline",
  "hex_variable_mercator",
  "hex_outline_mercator",
]);

function isCacheableWmsTile(request) {
  if (request.method !== "GET") return false;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (!url.pathname.endsWith("/mapserver")) return false;

  const service = url.searchParams.get("SERVICE") || url.searchParams.get("service");
  const requestType = url.searchParams.get("REQUEST") || url.searchParams.get("request");
  const layers = (url.searchParams.get("LAYERS") || url.searchParams.get("layers") || "")
    .split(",")
    .map((layer) => layer.trim())
    .filter(Boolean);

  return (
    service?.toUpperCase() === "WMS" &&
    requestType?.toUpperCase() === "GETMAP" &&
    layers.length > 0 &&
    layers.every((layer) => CACHEABLE_WMS_LAYERS.has(layer))
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const stale = (await caches.keys()).filter(
      (name) => name.startsWith("demscore-wms-tile-cache-") && name !== WMS_TILE_CACHE,
    );
    await Promise.all(stale.map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  if (!isCacheableWmsTile(event.request)) return;

  event.respondWith(
    caches.open(WMS_TILE_CACHE).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreVary: true });
      if (cached) return cached;

      const response = await fetch(event.request);
      if (response.ok) {
        event.waitUntil(cache.put(event.request, response.clone()));
      }
      return response;
    }),
  );
});

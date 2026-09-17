// v2: the tiles are Equal Earth now. Every tile cached by v1 was requested with
// SRS=EPSG:3857 and a Web Mercator BBOX, so none of those URLs can ever be asked
// for again -- left alone they would sit in returning users' browsers forever,
// matching nothing. The version is part of the name so activate can drop them.
const WMS_TILE_CACHE = "demscore-wms-tile-cache-v2";

// The fills may be asked for alone or together with the outline layer that rides
// along in the same GetMap (see MapController.wmsLayerNames), and the two spell
// different LAYERS values. Matching one exact string meant the default request,
// "hex_variable,hex_outline", was never recognised: the preloader filled the cache
// and nothing was ever served out of it, so every autoplay frame paid for a fresh
// MapServer render. Hence a set, not a string -- but still a closed one, so this
// never becomes a cache for arbitrary layers.
const CACHEABLE_WMS_LAYERS = new Set(["hex_variable", "hex_outline"]);

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

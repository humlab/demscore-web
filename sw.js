const WMS_TILE_CACHE = "demscore-wms-tile-cache-v1";

function isCacheableWmsTile(request) {
  if (request.method !== "GET") return false;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (!url.pathname.endsWith("/mapserver")) return false;

  const service = url.searchParams.get("SERVICE") || url.searchParams.get("service");
  const requestType = url.searchParams.get("REQUEST") || url.searchParams.get("request");
  const layers = url.searchParams.get("LAYERS") || url.searchParams.get("layers");

  return (
    service?.toUpperCase() === "WMS" &&
    requestType?.toUpperCase() === "GETMAP" &&
    layers === "hex_variable"
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
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

export class BackendClient {
  constructor() {
    this.defaultMapServerBase = "/mapserver?map=/etc/mapserver/mapserver.map";
    this.mapServerBase = this.normalizeToPathUrl(this.defaultMapServerBase, this.defaultMapServerBase);
    this.webBackendBase = "";
  }

  normalizeToPathUrl(input, fallback = "") {
    if (typeof input !== "string") return fallback;
    const trimmed = input.trim();
    if (!trimmed) return fallback;

    // Keep requests same-origin: convert absolute URLs to path+query+hash.
    try {
      const url = new URL(trimmed, window.location.origin);
      const pathUrl = `${url.pathname}${url.search}${url.hash}`;
      return pathUrl || fallback;
    } catch (_error) {
      return fallback;
    }
  }

  normalizeApiBase(base) {
    const normalized = this.normalizeToPathUrl(base, "");
    if (!normalized || normalized === "/") return "";
    return normalized.replace(/\/+$/, "");
  }

  normalizeApiPath(path) {
    const normalized = this.normalizeToPathUrl(path, "");
    if (!normalized) return "";
    return normalized.startsWith("/") ? normalized : `/${normalized}`;
  }

  async fetchJson(path, errorLabel) {
    const apiBase = this.normalizeApiBase(this.webBackendBase);
    const apiPath = this.normalizeApiPath(path);
    const response = await fetch(`${apiBase}${apiPath}`);
    if (!response.ok) {
      throw new Error(`${errorLabel}: ${response.status}`);
    }
    return response.json();
  }

  async hydrateRuntime() {
    try {
      const runtime = await this.fetchJson("/api/runtime", "Could not load runtime config");
      if (runtime && typeof runtime.mapServerBase === "string" && runtime.mapServerBase.length > 0) {
        this.mapServerBase = this.normalizeToPathUrl(runtime.mapServerBase, this.defaultMapServerBase);
      } else {
        this.mapServerBase = this.normalizeToPathUrl(this.defaultMapServerBase, this.defaultMapServerBase);
      }
    } catch (_error) {
      this.mapServerBase = this.normalizeToPathUrl(this.defaultMapServerBase, this.defaultMapServerBase);
    }
  }
}

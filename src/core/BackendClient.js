export class BackendClient {
  constructor(location = window.location) {
    this.mapServerBase =
      location.hostname === "localhost" || location.hostname === "127.0.0.1"
        ? "http://127.0.0.1:8088/?map=/etc/mapserver/mapserver.map"
        : `${location.protocol}//${location.hostname}:8088/?map=/etc/mapserver/mapserver.map`;

    this.webBackendBase =
      location.hostname === "localhost" || location.hostname === "127.0.0.1"
        ? "http://127.0.0.1:8091"
        : `${location.protocol}//${location.hostname}:8091`;
  }

  async fetchJson(path, errorLabel) {
    const response = await fetch(`${this.webBackendBase}${path}`);
    if (!response.ok) {
      throw new Error(`${errorLabel}: ${response.status}`);
    }
    return response.json();
  }
}

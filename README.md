# Web App

Simple OpenLayers frontend for the Demscore MapServer WMS layer.

## Build

The browser app is bundled from npm packages rather than loaded from CDNs.

```sh
npm install
npm run build
```

The production build writes `dist/`, with minified HTML/CSS/JS and precompressed
`.gz`/`.br` copies of those files. The deployment `web` service serves that
directory through nginx.

## Development

Start the stack as usual with `./deploy.sh start` from the deployment repo root,
then run the dev server here:

```sh
npm run dev
```

and open `http://127.0.0.1:8092`. It rebuilds on save and reloads the page, and
proxies `/api`, `/healthz` and `/mapserver` to the stack on 8090 (see
`devServer` in `webpack.config.cjs`). It needs Node on the host; the stack on
8090 keeps serving the last `dist` build alongside it.

## Features

- Select dataset (`qog`, `repdem`, `v_dem`)
- Select variable per dataset
- Select year
- Increase hex resolution automatically as the map zooms in
- Switch between multiple baselayers
- Overlay dynamic WMS hex layer from MapServer
- Read UI config from `web-backend` API endpoints
- Configure variable polarity (`positive`/`negative`/`neutral`) in `config/variable_polarity.json` (served through `web-backend`)

## Polarity Configuration

`config/variable_polarity.json` is served by `web-backend` and controls whether higher values map to the favourable end (`positive`), the unfavourable end (`negative`), or neither (`neutral`, drawn low-to-high in the same scheme, the way round its name reads).

- `defaults.polarity`: global fallback
- `dataset_defaults`: fallback per dataset
- `variable_overrides`: explicit per-major-variable settings
- `rules` (optional): regex-based overrides for variable ids

## Backend API

- Webapp config is fetched from same-origin router endpoints (no explicit port in frontend URLs):
  - `/api/config/variables`
  - `/api/config/legend-semantics`
  - `/api/config/variable-polarity`
  - `/api/config/variable-metadata/:dataset` (lightweight summary, loaded on demand per dataset)
  - `/api/config/variable-metadata/:dataset/:variable` (full metadata, loaded only when opening Variable Information)
- WMS tiles are fetched from same-origin router endpoint: `/mapserver?map=/etc/mapserver/mapserver.map...`

## URL

`http://127.0.0.1:8090`

## WMS tile caching

- Toggle cache in repo `.env`:
  - `DEMSCORE_ENABLE_MAPCACHE=1` enables server and browser tile caching (the default)
  - `DEMSCORE_ENABLE_MAPCACHE=0` disables server and browser tile caching
- Start services, in development and production alike, from the deployment repo root: `./deploy.sh start`
- Open app normally: `http://127.0.0.1:8090/`
- WMS requests always use the same-origin `/mapserver` route; the cache policy behind that route is selected from `DEMSCORE_ENABLE_MAPCACHE` via `web-backend` runtime config.

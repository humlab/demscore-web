# Web App

Simple OpenLayers frontend for the Demscore MapServer WMS layer.

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

`config/variable_polarity.json` is served by `web-backend` and controls whether higher values map to blue (`positive`), red (`negative`), or a single-hue green scale (`neutral`).

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

## Optional cached WMS mode

- Toggle cache in repo `.env`:
  - `DEMSCORE_ENABLE_MAPCACHE=0` disables cache
  - `DEMSCORE_ENABLE_MAPCACHE=1` enables cache
- Start services for local dev: `./scripts/dev_up.sh`
- Open app normally: `http://127.0.0.1:8090/`
- The app WMS target is selected automatically from `DEMSCORE_ENABLE_MAPCACHE` via `web-backend` runtime config.

# Web App

Simple Leaflet frontend for the Demscore MapServer WMS layer.

## Features

- Select dataset (`qog`, `repdem`, `v_dem`)
- Select variable per dataset
- Select year and hex size
- Switch between multiple baselayers
- Overlay dynamic WMS hex layer from MapServer
- Read UI config from `web-backend` API endpoints
- Configure variable polarity (`positive`/`negative`) in `config/variable_polarity.json` (served through `web-backend`)

## Polarity Configuration

`config/variable_polarity.json` is served by `web-backend` and controls whether higher values map to blue (`positive`) or red (`negative`).

- `defaults.polarity`: global fallback
- `dataset_defaults`: fallback per dataset
- `variable_overrides`: explicit per-major-variable settings
- `rules` (optional): regex-based overrides for variable ids

## Backend API

- Webapp config is fetched from split endpoints on `http://127.0.0.1:8091`:
  - `/api/config/variables`
  - `/api/config/legend-semantics`
  - `/api/config/variable-polarity`
  - `/api/config/variable-metadata/:dataset` (lightweight summary, loaded on demand per dataset)
  - `/api/config/variable-metadata/:dataset/:variable` (full metadata, loaded only when opening Variable Information)
- Map tiles/imagery are still fetched directly from MapServer (`:8088` or cached `:8089`).

## URL

`http://127.0.0.1:8090`

## Optional cached WMS mode

- Toggle cache in repo `.env`:
  - `DEMSCORE_ENABLE_MAPCACHE=0` disables cache (default)
  - `DEMSCORE_ENABLE_MAPCACHE=1` enables cache
- Start services for local dev: `./scripts/dev_up.sh`
- Open app in cached mode: `http://127.0.0.1:8090/?cache=1`
- Override WMS base manually: `?wmsBase=http://127.0.0.1:8089/?map=/etc/mapserver/mapserver.map`

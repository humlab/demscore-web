# AGENTS.md

## Purpose
This web app is a Leaflet frontend for Demscore hex-map WMS tiles. It loads dataset/variable/year config from `web-backend` and renders dynamic map layers from MapServer.

Primary user flows:
- choose dataset + variable (+ optional variant)
- scrub or animate year timeline
- inspect variable metadata in a dialog
- read legend semantics/polarity-aware coloring

## Architecture (Current)
The app was refactored into a small class hierarchy with one top-level coordinator.

- `app.js`
  - module entrypoint, creates and starts `DemscoreApp`
- `src/core/BaseController.js`
  - shared helpers (`getEl`, `debounce`)
- `src/core/BackendClient.js`
  - resolves backend/mapserver base URLs
  - fetches JSON config payloads with unified error handling
- `src/controllers/MetadataController.js`
  - dataset/variable/variant UI wiring
  - metadata caching and dialog content
  - variable hierarchy building (main variable vs suffix variants)
  - polarity resolution (`default` -> `dataset_default` -> `rules` -> `override` precedence as implemented)
- `src/controllers/MapController.js`
  - Leaflet map setup, baselayers, zoom display
  - WMS layer lifecycle (active layer + pending layer for smooth swaps)
  - legend rendering and overlap rebalancing
- `src/DemscoreApp.js`
  - orchestrates app startup and shared state
  - timeline rendering/scrubbing
  - autoplay state machine and speed controls
  - cross-controller event coordination

## Runtime Data Flow
1. `DemscoreApp.start()` fetches:
   - `/api/config/variables`
   - `/api/config/legend-semantics`
   - `/api/config/variable-polarity`
2. `MetadataController` initializes dataset/variable controls.
3. `MapController` initializes Leaflet map and first WMS layer.
4. User interactions update shared `state` in `DemscoreApp`.
5. `MapController.loadNextLayer()` swaps to a fresh WMS layer when dataset/variable/year changes.

## Config & Endpoints
Config files (served by backend):
- `config/variables.json`
- `config/legend_semantics.json`
- `config/variable_polarity.json`
- `config/variable_metadata.json`

Runtime endpoints:
- `GET /api/config/variables`
- `GET /api/config/legend-semantics`
- `GET /api/config/variable-polarity`
- `GET /api/config/variable-metadata/:dataset`
- `GET /api/config/variable-metadata/:dataset/:variable`

WMS source:
- MapServer on `:8088` (or cache path if enabled in surrounding stack)

## Developer Change Guide
Common tasks and where to work:

- Add/change dataset, variable ranges, defaults:
  - backend config payload (`variables` endpoint)
  - UI behavior mostly in `MetadataController.refreshVariables()`

- Change variable title/metadata dialog behavior:
  - `MetadataController.refreshVariableMetadataPanel()`

- Change polarity mapping behavior:
  - `config/variable_polarity.json`
  - resolution logic in `MetadataController.resolveConfiguredPolarity()`

- Change legend text/rules/colors:
  - `config/legend_semantics.json`
  - rendering in `MapController.refreshLegend()`

- Change autoplay/timeline behavior:
  - `DemscoreApp` methods: `scheduleAutoPlayTick`, `setYear`, `renderTimelineScale`

- Change map baselayers or WMS swap behavior:
  - `MapController.initialize()` and `MapController.loadNextLayer()`

## Guardrails
- Keep responsibilities separated:
  - data/selection logic in `MetadataController`
  - map/layer/legend logic in `MapController`
  - orchestration in `DemscoreApp`
- Prefer extending existing controller methods over adding new global utilities.
- Preserve pending-layer swap pattern to avoid flicker during WMS updates.
- Keep UI element IDs stable unless updating both HTML and controller bindings.

## Quick Validation
After edits, run at minimum:
- `node --check app.js`
- `node --check src/DemscoreApp.js`
- `node --check src/controllers/MetadataController.js`
- `node --check src/controllers/MapController.js`
- `node --check src/core/BaseController.js`
- `node --check src/core/BackendClient.js`

Then do a manual smoke test in browser:
- dataset switch
- variable + variant switch
- year scrub + autoplay
- metadata dialog open/close
- legend update and map tile refresh

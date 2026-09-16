# AGENTS.md

## Purpose
This web app is a Leaflet frontend for Demscore hex-map WMS tiles. It loads dataset/variable/year config from `web-backend` and renders dynamic map layers from MapServer.

Primary user flows:
- choose dataset via the dataset tab strip (each dataset has its own accent colour and background photo)
- choose variable from the always-visible variable list inside the active dataset panel; rows that
  have versions are split buttons whose caret opens a variant menu
- scrub or animate year timeline
- read a variable's codebook description in a hover card, or its full entry in a dialog
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
  - dataset tab strip (render, active state, per-dataset accent colour and panel photo)
  - variable hover card (lazy per-variable metadata fetch, placement, arrow)
  - dataset/variable/variant UI wiring (variant menu per row, not a separate picker)
  - variable list rendering (a `role="radiogroup"` of hidden radios in two-line rows: name over key)
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

- Change how a variable row looks or reads:
  - `MetadataController.buildVariableOption()` (row markup: a `div` holding the picking
    `label` plus, for variables with versions, a caret `button`. The button must stay
    *outside* the label or clicking it would also toggle the label's radio)
  - the second line is the row's selected version ("Main", "Code low"), not the variable
    key; only rows that have versions have one
  - `.variable-list` / `.variable-option*` in `styles.css`; the list is a flex child
    that absorbs leftover panel height, so it grows with the viewport before scrolling
  - note `#controls label` styles all labels: option rows reset margin/font explicitly

- Change dataset tab labels, colours or panel photos:
  - per-dataset `title` (falls back to `label`), `color` and `image` keys in the `variables` payload
  - tabs spell the dataset name out in full ("Quality of Government", not "QoG"), so they are
    equal-width flex columns whose text wraps; there is no separate short label and no panel
    heading repeating the name (the tab *is* the heading, via `aria-labelledby`)
  - fallbacks in `MetadataController.getDatasetTitle()` / `getDatasetImageUrl()` / `DATASET_ACCENTS`
  - photos live in `assets/images/<dataset key with _ as ->.jpg` (e.g. `v_dem` -> `v-dem.jpg`)
  - tab/panel theming via the `--ds-accent`, `--ds-image` and `--ds-scrim` custom properties in `styles.css`
  - the panel scrim opacity is tuned to keep white text at >= 5:1 contrast over every photo;
    re-check it if you swap an image for a lighter one

- Change the variant menu:
  - `MetadataController.bindVariantMenu()` (caret click, Alt+Down / Right from the row,
    menu key handling, dismissal) -> `openVariantMenu()` -> `positionVariantMenu()`
  - `#variantMenu` lives on `<body>` and is `position: fixed` for the same reason the hover
    card is: `#controls` and `.variable-list` both scroll and would clip it. It drops from the
    row, flips above when the row sits too low, and *tracks* its row on scroll rather than
    closing — opening it can itself scroll the list (focus pulls the caret into view), and a
    menu that closed on that scroll would never stay up. It closes once its row scrolls out
    of the list, on outside pointerdown, Escape, Tab, resize and dataset switch
  - variant names come from the variant's own metadata title — the parenthetical the load
    added to the base title ("… (Code low)") — so a row, the legend and the metadata dialog
    always agree; `VARIANT_SUFFIX_LABELS` only covers variants the load did not name, and is
    worded to match `scripts/load_variable_metadata.sh`
  - `VARIANT_SUFFIX_ORDER` sorts the menu (scale variants, then bounds, then spread); the raw
    hierarchy order is alphabetical, which reads wrong ("Code high" above "Code low")
  - each row remembers its choice in `variantByMain` (`${dataset}:${main}`), so leaving a row
    and coming back restores the version it was set to
  - only the *selected* row's caret is in the tab order, so the panel still costs one tab stop
    per control rather than one per row

- Change variable title/metadata dialog behavior:
  - `MetadataController.refreshVariableMetadataPanel()`

- Change the variable hover card:
  - `MetadataController.bindVariableTooltip()` (hover intent, dismissal) ->
    `showVariableTooltip()` (lazy fetch through the same per-variable cache the dialog uses,
    so hovering a row warms the dialog too) -> `getVariableSummary()` -> `renderVariableTooltip()`
    -> `positionVariableTooltip()`
  - card text: `description` (with a restated title prefix stripped), else `question` shown under a
    QUESTION label — most V-Dem `description`s are the codebook's scraped field block
    ("VARIABLE TYPE: ... QUESTION: ..."), which `CODEBOOK_FIELD_DUMP` filters out; a variable with
    no metadata row at all (some V-Dem keys 404) simply gets no card
  - `#variableTooltip` lives on `<body>`, not in the panel: `#controls` and `.variable-list`
    both scroll and would clip it, so it is `position: fixed` and placed from the row's
    bounding rect, flipping to the left (`.is-left`) when the viewport has no room right
  - `.variable-tooltip*` in `styles.css`; `--tip-accent` (dataset accent) colours the edge and
    arrow, `--arrow-top` keeps the arrow on the hovered row when the card is clamped to an edge
  - the card is `pointer-events: none` on purpose — it must never steal the hover from the row

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
- dataset switch (click and arrow-key the tab strip; panel photo and colour follow the active dataset)
- variable list: click a row, arrow-key through the list, and Tab out in one stop
- variant menu: caret opens it, arrow keys and Enter pick a version, Escape returns focus to
  the caret, the row's second line and the legend then name the same version, and the choice
  survives leaving the row and coming back
- year scrub + autoplay
- variable hover card: description appears beside the hovered row, follows arrow-key focus,
  and disappears on scroll, Escape and dataset switch
- metadata dialog open/close
- legend update and map tile refresh

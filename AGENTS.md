# AGENTS.md

## Purpose
This web app is an OpenLayers frontend for Demscore hex-map WMS tiles. It loads dataset/variable/year config from `web-backend` and renders dynamic map layers from MapServer.

Primary user flows:
- narrow the variable list by typing in the search box at the top of the panel, or with the
  topic and dataset filter chips below it; both chip groups are toggles, several may be on at
  once, and all-off with an empty box (the opening state) means no filter
- choose variable from the always-visible variable list, which spans *every* dataset at once;
  each row carries its dataset's colour on its left edge, and picking a row is also what
  switches the dataset
- pick how to see a year from the **View** switch in the map dashboard: Equal Earth,
  Mercator, or the **table**. One radiogroup over three answers, because the two
  projections and the table are one question — how to show this year — asked once. The
  table replaces the map rather than sitting beside it, and picking a projection from the
  table view sets it and brings the map back
- sort the table on any column, and watch the order rearrange itself as the years
  play: a ranking sorted by value is the one reading the map cannot give
- scrub or animate year timeline
- compare at a glance which years a variable covers, from the coverage strip under each
  row and the two years written under that — the one part of a row that works on touch,
  where the hover card does not
- read a variable's codebook description in a hover card, or its full entry in a dialog,
  along with how to cite the dataset, and follow that card's footer to the module's codebook
  PDF or its Demscore download
- read legend semantics/polarity-aware colouring

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
  - the sidebar search box, the topic/dataset filter chips (render, pressed state) and the flat
    cross-dataset variable list
  - per-dataset palette, stamped as `--ds-1`..`--ds-5` onto each row, dataset chip and info
    card — the panel uses the Demscore homepage hero image treatment
  - variable hover card (lazy per-variable metadata fetch, placement, arrow)
  - variable list rendering (a `role="radiogroup"` of hidden radios)
  - metadata caching and dialog content
  - variable hierarchy building (which variables are base ones, so derived versions stay out)
  - polarity resolution (`default` -> `dataset_default` -> `rules` -> `override` precedence as implemented)
- `src/core/palettes.js`
  - the four colour schemes the reader can pick between, and the only place any quantile
    colour is written. `mapserver/hex_classes.inc` is generated from it by
    `scripts/build_hex_classes.mjs` in the deployment repo
- `src/core/projection.js`
  - the two planes the map can be drawn in — Equal Earth (EPSG:8857), the default, and
    Web Mercator (EPSG:3857) — the resolution ladder they share, and the conversion
    between the app's zoom and a resolution
- `src/controllers/MapController.js`
  - OpenLayers map setup, baselayers, projection toggle, zoom display
  - WMS layer lifecycle (active layer + pending layer for smooth swaps)
  - legend rendering and overlap rebalancing
  - legend swatch hover card (which value span each colour stands for)
- `src/controllers/MapDataController.js`
  - the map's non-visual equivalent: the standing summary (`#mapSummary`) and the
    one-sentence live announcement (`#mapAnnouncer`). It used to own a third, the
    `#mapDataDialog` modal of the same rows, opened from a **Data table** button on the
    legend; the table view is that without the modal and without the year standing still,
    so the dialog, its button and the half of this controller that drew it are gone
  - hangs off `MapController`'s `onStateChange`, fired from `refreshLegend()`
- `src/controllers/TableViewController.js`
  - the **table view**: the second reading of the year the map is drawing, from the
    same `demscore.country_scores()` call, so the two can never disagree about what
    a year holds
  - one row per country, columns `±` / `#` / Country / ISO3 / Value / Class /
    Boundary, sorted on any of them but the first two — each of those *is* a
    reading of the sort, so sorting on either is a question about its own answer
  - **`±` is movement, not value.** Whether the row is higher or lower in the
    table than it was in the previous year the series has, as a coloured
    triangle and nothing else: no figure, because a column of arrows and numbers
    reads as a share price and the question while the animation runs is the
    simpler one. The number of places is in the cell's `title` and in the words
    a screen reader gets. It compares *positions under the current sort*, so
    re-sorting rebuilds it — `resolvePreviousPositions()` keys its cache on the
    sort as well as on the year
  - **rows can be followed.** Clicking one, or pressing Enter on it, marks it;
    the mark is on the country (by `rowKey`) and survives the year stepping and
    the table re-sorting, which is the whole of it — a marked row is how a
    reader keeps hold of one country while 245 change places. Escape clears
    every mark, and so does the **Deselect all (n)** button in the head, which
    is `hidden` until there is something to undo and carries the only count of
    how many marks are out. The rows carry a roving `tabindex` so this is not a
    mouse-only feature
  - **each mark gets its own ink**, handed out in the order they are made and
    handed back when a row is unmarked (`nextFollowInk` takes the lowest free
    one). Six of them, named in `FOLLOW_INK_NAMES` and coloured in `styles.css`
    against `[data-follow-ink]` — the names and the colours are in two files and
    are kept in step by hand, because a mark is spoken as well as shown. Past
    six they repeat: following more rows than that is past what eyes do, and
    past what six muted colours can stay distinct through
  - the mark is a `visually-hidden` "(followed, blue)" inside the row's name as
    well as a highlight. A highlight is not something a reader who cannot see it
    can be told, and the colour is the part that distinguishes one mark from
    another — so it is named rather than left as "followed"
  - rows are **moved, not redrawn**, when the year steps. A `<tr>` is kept per
    country in `rowEls` and reordered with `appendChild`, and a FLIP pass gives
    it a transform back to where it was so the browser tweens the difference.
    That is the whole point of the view: with the value column sorted, the
    countries change places under the reader as the animation plays
  - its own read-ahead (`startPrefetch`), which fetches the surrounding years'
    rows and reports in the tile preloader's snapshot shape, so the timeline
    marks go on meaning "this year is ready" in either view
  - hangs off the same `MapController.onStateChange` the summary does
- `src/controllers/AboutController.js`
  - the About dialog, which is also the credits. It was two dialogs — a short About with a
    link into a separate "Sources & licences" — and the link was a seam: what the map is and
    what it is made of are the same question at two depths. One dialog, with the depth in
    disclosures instead
  - the prose at the top is static in `index.html`; everything under `#aboutCredits` is
    rendered from `/api/config/attribution`, so the controller knows the name of no source. A
    boundary source added in the deployment repo reaches this dialog through the generated
    file, and the generator fails if nobody wrote its licence down
  - **which sections start open is a licence decision, not a layout one.** Indicator
    citations, map boundaries and the map's own licence carry obligations and are expanded on
    open; only the software list, whose notices travel in the files themselves, starts closed.
    Nothing in `styles.css` may hide one
  - modal `<dialog>` — the focus trap and Escape come from the browser. Two openers: the
    **About** button on the map and the credit line under it. The second passes
    `"boundary"`, so it lands on the section that answers the question it was asked from.
    There was a third, the data-table dialog's boundary footnote, which went with that
    dialog; the table view's own footnote is plain text
- `src/core/csv.js`
  - the countries of one variable-year as a file, and the only place that file is
    spelled. The table view's download goes through it, as the data-table dialog's did
    before that dialog was removed, so a file that came out of this application has one
    shape whichever button produced it
  - **every row carries its own `dataset`, `variable` and `year`.** The download
    used to name the variable-year in the filename alone, which is a place a file
    loses: renamed once, or its rows pasted under another year's in a spreadsheet,
    and nothing was left saying what the numbers measured or when. It also makes
    several of these files concatenate into one honest table, which is the obvious
    next thing to do with them
- `src/core/attribution.js`
  - the one line the OpenLayers attribution control shows, built once from the same generated
    file and handed to *both* the land source and the WMS source. OpenLayers shows each
    distinct attribution string once, so the same string on both is what makes the credit
    survive either layer being switched off — and the WMS layer, the one derived from the
    licensed sources, used to carry no attribution at all
  - it must never vary with the year: CShapes polygons are on the map in 2020 as much as in
    1920, so a line shown only on historical years would be missing on the years most people
    look at
- `src/DemscoreApp.js`
  - orchestrates app startup and shared state
  - timeline rendering/scrubbing, and the variable caption under it
  - autoplay state machine and speed controls
  - cross-controller event coordination

## Runtime Data Flow
1. `DemscoreApp.start()` fetches:
   - `/api/config/variables`
   - `/api/config/legend-semantics`
   - `/api/config/variable-polarity`
   - `/api/config/variable-coverage` and `/api/config/variable-topics` (both optional)
   - `/api/config/attribution` (optional — `src/core/attribution.js` falls back to a constant
     naming the same licensed sources, because an attribution that depends on a fetch
     succeeding is not an attribution)
2. `MetadataController` initialises the filter chips and the variable list. It loads *every*
   dataset's metadata up front, not just the opening one, because one list holds all their rows.
3. `MapController` initialises the OpenLayers map and first WMS layer.
4. User interactions update shared `state` in `DemscoreApp`.
5. `MapController.loadNextLayer()` swaps to a fresh WMS layer when dataset/variable/year changes.
6. In the table view, step 5 does not happen: `MapController.setDrawingEnabled(false)`
   makes `loadNextLayer()` a no-op, the tile read-ahead is cancelled, and
   `TableViewController` refreshes from `/api/map-data` instead. The OpenLayers map
   is *covered*, not unmounted — it keeps its view, its size and its zoom, and only
   the fetching stops.

## Config & Endpoints
Config files (served by backend):
- `config/variables.json`
- `config/legend_semantics.json`
- `config/variable_polarity.json`
- `config/variable_metadata.json`
- `config/variable_coverage.json` (generated by `scripts/build_variable_coverage.sh`
  in the deployment repo, not hand-edited)
- `config/variable_topics.json` (curated by hand; optional — the list works unfiltered without it)
- `config/attribution_sources.json` (curated by hand: licence display names and deed URLs, one
  entry per boundary `geometry_source_dataset`, the full-form indicator citations, and the
  ShareAlike statement for the map's own output)
- `config/attribution.json` (generated by `scripts/build_attribution.sh` in the deployment repo
  from the two together, not hand-edited)

Runtime endpoints:
- `GET /api/config/variables`
- `GET /api/config/legend-semantics`
- `GET /api/config/variable-polarity`
- `GET /api/config/variable-coverage`
- `GET /api/config/variable-topics`
- `GET /api/config/attribution`
- `GET /api/config/variable-metadata/:dataset`
- `GET /api/config/variable-metadata/:dataset/:variable`
- `GET /api/class-breaks?dataset=&variable=&year=` — the seven quantile class spans behind the
  legend bar, from the same `demscore.country_scores()` call the WMS layer classes on, plus
  `countriesWithData` / `countriesTotal`. Not a config file: it is per year, so it is queried
  live and cached per dataset|variable|year in `MapController`. Everything that reads the map
  without looking at it — the swatch labels, the summary, the announcement — comes from this
  one response, so none of them costs a request of its own
- `GET /api/map-data?dataset=&variable=&year=` — one row per country on the map (name, ISO3,
  value, class, no-data), for the table view. Fetched when that view is on, with the years
  around the one on screen read ahead, so an animation in it is paced by this route

WMS source:
- Same-origin `/mapserver` route through the Demscore router. Server/browser tile caching is
  controlled by `DEMSCORE_ENABLE_MAPCACHE` in `.env`.

## Visual System
The interface follows `Demscore_Handbook_Web_Style_Brief.docx`, the CSS-oriented summary of
Handbook V7: Lato as the working typeface, Open Sans for statistics and metrics, dark navy as
the structural colour, terracotta only as a thin accent, and soft neutral surfaces on white.

- the handbook's own tokens are the first block of `styles.css` (`--navy`, `--terracotta`,
  `--charcoal`, `--muted-surface`, `--rule`, ...); every token the app already spoke in
  (`--accent`, `--text`, `--panel-bg`, `--map-cover-blue`) is *defined from* them, so a
  palette change is one edit at the top rather than a sweep through the file
- the two families load from Google Fonts in `index.html`. Lato carries 100/300/400/700/900
  and no 500/600/800, so a weight in between rounds up at render time; write the weight that
  actually ships rather than one the family does not have
- `--font-numeric` (Open Sans) belongs only to elements showing a number — the year readout,
  the timeline scale, a legend value span, the zoom reading. Everything else is Lato
- `body` carries the handbook's reading measure (1.55). The sidebar is a control rail that
  scrolls, so its labels pin their own tighter leading; do not let prose leading back into it
- corners are `--radius-card` / `--radius-control` / `--radius-inline`, deliberately small:
  the brief calls out heavy rounded cards as the thing to avoid. Pills (`999px`) are for
  chips, which read as toggles by being pill-shaped
- the brief asks for terracotta *sparingly*. It had one use, the rule above the legend dock,
  and that dock is gone — so it is currently unspent. Do not spend it on buttons or active
  states
- the per-dataset palettes (`--ds-1`..`--ds-5`, from backend config) and the map's own
  colours — legend ramps, `LAND_BASEMAP_COLOR` — are data graphics, not interface chrome,
  and stand outside this system

### Loading placeholders
Config arrives over the network, so the sidebar and the timeline are on screen for a moment
before they hold anything. What stands in for the content is placed so that rendering the
content removes it — there is no loading flag to set, and none to forget to unset:

- `.loading-dots` (three dots, `styles.css`) sits *inside* `#topicChips`, `#datasetTabs`,
  `#variableList`, `#mobileSelectedTitle` and `#timelineVariableTitle` in `index.html`. Each of
  those is cleared by its renderer (`innerHTML = ""`, or `textContent =` for the mobile title)
  on the first pass, so the placeholder goes with it. Add a new one the same way — a
  placeholder that lives somewhere its renderer does not clear is a placeholder that has to be
  swept up by hand
- the containers also carry `aria-busy="true"`, which the three renderers drop; that is the
  same news for a reader who is not looking at the dots
- `#timelineWrap` starts `is-awaiting-data`: the marker is hidden and the preload track holds
  a placeholder rule, because a marker parked on a year is a reading of data that is not in
  yet. `renderTimelineScale()` drops the class as it draws the real scale. The wrap's white
  backdrop stays throughout — that is what says the timeline is coming
- both animations are switched off under `prefers-reduced-motion: reduce`

## Developer Change Guide
Common tasks and where to work:

- Add/change dataset, variable ranges, defaults:
  - backend config payload (`variables` endpoint)
  - UI behaviour mostly in `MetadataController.refreshVariables()`

- Change how a variable row looks or reads:
  - `MetadataController.buildVariableOption()` (row markup: a `div` holding the picking
    `label`). Every row is the same shape — a title row over a coverage strip over the two
    years that strip spans. It used to
    be a split button with a caret opening a menu of the variable's other versions; only
    the base version is offered now, which is also why the strip alignment needs no
    padding tricks any more
  - the second line is `.variable-option-coverage`, the coverage strip, on every row, and
    the third is `.variable-option-coverage-axis`, its first and last year. The strip
    replaced the variable key that used to sit there: the key is still one hover away in
    the card, and the strip says something the title does not
  - `.variable-list` / `.variable-option*` in `styles.css`; the list is a flex child
    that absorbs leftover panel height, so it grows with the viewport before scrolling
  - note `#controls label` styles all labels: option rows reset margin/font explicitly

- Change the variable search box:
  - `#variableSearch` in `index.html`, at the top of `#datasetPanel` above the chips, and
    `.variable-search*` in `styles.css`. It is local only and always has been: every row is
    already in the browser, so nothing here reaches the backend
  - `MetadataController.setVariableQuery()` stores it lowercased and rebuilds the list;
    `rowMatchesQuery()` is what a row is tested against, and the phone picker's own box goes
    through the same method, so the two can never drift
  - the query is a third filter and ANDs with the two chip groups, the way they AND with each
    other. `clearFilters()` clears all three
  - a row matches on its title, its variable key, its dataset key, both dataset names and its
    topic labels. The topic labels are deliberate — searching "corruption" with no chip lit
    finds the rows under that chip — and are also why a hit sometimes has none of the typed
    letters in its title
  - `renderFilterSummary()` quotes the query back when a search on its own empties the list. It
    does not when a chip is lit as well, because then there is no telling which of the two did it

- Change the topic grouping:
  - `config/variable_topics.json`, served at `/api/config/variable-topics`. Curated by hand: it is
    *not* derived from the codebook. The codebook section a variable sits under is dataset-scoped
    and, for this variable selection, mostly one variable per section, so it seeds the mapping but
    cannot be it — the reasoning and the evidence are in `topic_classification.wip.md` in the
    deployment repo
  - `order` lists the chips left to right; `assignments[dataset][variable]` is an array, so a
    variable may answer to several chips (the first is its primary topic). A variable in no topic
    is still listed, it just matches no topic chip
  - `normalizeTopicsConfig()` drops anything malformed rather than throwing, and the whole file is
    optional: `DemscoreApp` catches its fetch, and the list works unfiltered without it
  - topic labels are short because the chips share a row; the longer sense goes in `description`,
    which becomes the chip's tooltip

- Change dataset colours:
  - per-dataset `palette` (five shades, darkest first) and `title`/`label` in the `variables`
    payload, which comes from `webapp/config/variables.json` — see the deployment repo's
    `overlayDatasetPresentation()` note; a dataset without a palette gets five shades mixed
    from its `color`, so it stays legible before anyone picks any
  - `MetadataController.applyDatasetPalette()` stamps `--ds-accent` and `--ds-1`..`--ds-5` on
    each variable row, each dataset chip and each info card. The panel uses the Demscore homepage
    hero image treatment; do not tint it with whichever dataset happens to be selected
  - a row is `--ds-4` mixed 55% toward white, hover is `--ds-4` raw, selection is `--ds-3` plus
    an inset edge in `--ds-1`. The mixing is not decoration: V-Dem's shades are far more
    saturated than QoG's or REPDEM's at the same step, so the raw shade made every V-Dem row
    shout while the other two whispered
  - text stays dark on every state. REPDEM's darkest shade is a light orange, so "dark fill,
    white text" is not available across all three palettes. Worst measured small-text contrast
    is 5.6:1; re-check with a calculator if you change a palette
  - which dataset a row belongs to is carried by a 3px left edge in `--ds-1`, not by a label in
    the row. It costs no width, so a long variable title never has to wrap around it, and the
    selected row keeps its edge while the rest of it goes accent
  - chips use the *short* `label` ("V-Dem"), via `getDatasetLabel()`, because they share a
    row — the full `title` rides along as the chip's tooltip
  - the filter chips are `button`s inside the panel, so the panel's own button styling is
    scoped to `#controls .dataset-panel > button` (direct children). Widening that selector
    repaints the chips

- Change what a download contains:
  - `src/core/csv.js`, and nothing else on either side. `COLUMNS` there is the
    whole file — a column is a header and a function of `(row, selection, index)`
  - the first five columns identify the numbers and must stay: a row that cannot
    say which dataset, variable and year it is from is a row that stops meaning
    anything the moment it leaves the page it was downloaded from

- Change the table view, or the animation in it:
  - `src/controllers/TableViewController.js`; `COLUMNS` at the top is the single
    statement of what a column is, and the header, the body, the sort and the CSV
    are all built from it. Adding one means an entry there and nothing else
  - **a column's `width` is written onto its `<col>` as `--col-width`, never as
    `width`.** An inline `width` beats every rule in the stylesheet, so the
    breakpoints that drop a column could not take its width away with it and the
    dropped columns went on reserving their space — which, once there were seven
    of them, left Country with none of the row at all. The stylesheet reads the
    variable, so a media query can still override it
  - `.table-view` and `.table-view-scroll` both need `min-width: 0`. Neither a
    grid item nor a flex item shrinks below its content by default, and under
    `table-layout: fixed` the table is as wide as its `<col>`s add up to — so
    without them the table's width pushes on the pane instead of on the box that
    exists to scroll
  - **`renderRows()` is FLIP, and there is nothing left in it to read.** It used
    to measure `offsetTop` on every row twice — once before the reorder and once
    after — and each of those forces a synchronous layout of the whole table.
    Three forced layouts of a 245-row table per frame (those two and the flush)
    held the animation at **18fps with 6.3s of long tasks in 8s**; a quarter of
    all time at 8x was in the second read alone. It is now arithmetic: every row
    is one line tall — every cell clips rather than wraps — so a row's position
    *is* its index times the row pitch, and both indices are already in hand
    (`renderedIndex` from the last render, `orderKeys` from this one). **55fps
    with no long tasks.**
  - the pitch (`rowPitch()`) is measured once and cached until the row count or
    the window changes. A stale pitch is a cosmetic risk and not a correctness
    one: the transform is transient and every glide ends at zero, so where a row
    *finishes* is the DOM order and nothing else
  - **only rows near the scroller's viewport glide** (`visibleRowBand`,
    `FLIP_BAND_BUFFER_ROWS`). A row that starts and ends off screen costs exactly
    what a visible one costs — a transform, a transition, a stacking context, a
    repaint — and buys nothing. 20 rows move on a year step instead of 245, and
    44 on a re-sort, which moves rows further
  - **`is-entering` is not used during autoplay, and comes off on a timer.** A
    reorder takes every row out of the document for the length of one statement,
    which *cancels* a running CSS animation — so at four years a second the
    260ms entrance restarted before it could finish, `animationend` never fired,
    the class never came off, and the row sat at opacity 0 for the whole
    animation. The pre-unification German and Italian states, which join the
    table when the year crosses back past 1871, were invisible the entire time.
    A row that is on screen for 125ms has no entrance to make anyway
  - a reorder landing *inside* a glide is the one case that still reads the DOM
    (`readCarriedOffsets`), and `glideEndsAt` — one timestamp for the whole
    batch, since a batch shares its duration — means the common frame answers
    "is anything still moving" without touching it. `flipDuration()` keeps the
    glide inside the frame, so this is for frames that bunch behind a slow
    request rather than for the ordinary run
  - the flush (`void this.bodyEl.offsetHeight`) cannot be a
    `requestAnimationFrame`. rAF callbacks run *before* the style recalculation,
    so the invert and the play would land in one recalculation and the rows would
    simply appear in their new places with no movement at all. It is now the only
    forced layout in the pass
  - **guard every per-row write.** `fillRow` runs 245 times a frame, and a style
    or class write dirties the node whether or not the value changed — the class
    swatch's background was 245 identical writes a frame. `cellText` memoises the
    formatted value on the row the first time it is drawn: formatting it when the
    payload arrives is *worse*, because the read-ahead fetches dozens of years
    and most are never drawn. Both were measured
  - `flipDuration()` caps the glide below the interval between two years. A row
    still travelling when the next year arrives never gets anywhere, and a table
    in which nothing settles cannot be read. `shouldAnimate()` is the other half:
    only a year stepping within one variable is a movement — a new variable is a
    different table that happens to share country names
  - **nothing in this view may change size as the year steps.** The rows move;
    the table must not. Three things enforce that and all three are load-bearing:
    - the summary is two lines, each `nowrap` with an ellipsis and its full text
      in `title`. It was one flowing paragraph, and the clause naming how many
      countries have no value this year comes and goes with the year — so it
      rewrapped between one line and two mid-animation and stepped the whole
      table up and down
    - `table-layout: fixed`, with the widths in the `width` of each `COLUMNS`
      entry and a `<colgroup>` built from them. An auto-layout table re-measures
      every column against its widest cell on each redraw, so a value going from
      `0.9` to `0.912` shifts every column beside it — the same jitter sideways.
      It is also why the `±` column carries no figure: a number that grows from
      one digit to two inside a 2.6rem column has nowhere to grow
    - the boundary note under the table is one clipped line, because the sources
      in view change with the year as CShapes entities come and go
    A column added here needs a `width` (Country is the one without: under fixed
    layout it takes what the others leave) and, if it can be long, `clips: true`
    so the cell carries its full text in `title`. A sentence that does not change
    with the year belongs in the caption or on a column header, not in a line
    that is rewritten eight times a second
  - a row's identity is `country` + `validFromYear`, not the name: V-Dem codes a
    pre-partition Vietnam and a northern one over the same nine years, and the
    historical registry can carry several periods of one entity
  - the class swatch is painted from `MapController.legendColorsForPolarity()` —
    the legend's own ramp, through the same polarity-aware reversal — so map and
    table cannot end up describing one year in two colour schemes
  - `.table-view*` in `styles.css`. Its two insets are both measured and both
    written on `#map` by `DemscoreApp`: `--timeline-inset` for the overlay it must
    clear at the top (`syncTimelineInset()`) and `--dashboard-inset` for the map
    dashboard it must clear at the foot (`syncDashboardInset()`). Anything else
    floated over the map pane has to read the same two
  - `#tableView`, `.map-canvas` and `.map-choice-dashboard` are all grid item 1/1
    in `#map`, which is why all three are placed explicitly: an auto-placed canvas
    would find 1/1 taken and step down into a row of its own. The dashboard is a
    child of the *pane* rather than an OpenLayers control for the same reason the
    switcher used to be a sibling of the canvas — the table view covers
    `#mapCanvas` and makes it `inert`, and the way back to the map is in there

- Change which view is on screen, or add a third:
  - `VIEW_KEYS` in `DemscoreApp`, `applyView()` — the one statement of what each
    view turns on and off, which both the switcher and startup come through —
    `startReadAhead()` and `advanceAutoPlayFrame()`
  - the control itself is in `MapController`: `VIEW_CHOICE_KEYS`, `chooseView()`,
    `onViewKeydown()`, `syncViewSelector()`, and `.map-view-*` in `styles.css`. It
    is one radiogroup over the two projections and the table, so the answer lives
    in two places on purpose — the projection in `MapController`, `state.view` in
    `DemscoreApp` — and `currentViewChoiceIndex()` is where the two are read as
    one. The table wins when it is on: the projection it will come back to is
    remembered but is not the answer while nothing is being projected
  - the sliding selection is `--selected` plus `--past-divider`, both written by
    `syncViewSelector()`. The `100%` in its `translateX` is the slab's *own* width,
    which is one track — a percentage inside a transform resolves against the
    element, not the container, so the track expression cannot be reused there
  - **autoplay is paced by the view on screen.** The map's frame is done when its
    tiles are drawn; the table's when its rows are. Neither is a timer, so a slow
    stretch plays slowly rather than skipping — and a view added without a pacing
    answer stops the animation with the button still reading "Pause"
  - the read-ahead goes the same way: nothing may reach for `layerPreloadController`
    by name any more, or a reader in the table view warms tiles nobody will see
  - the choice is a cookie (`readMapView`/`writeMapView` in `core/preferences.js`),
    like the projection and the palette. Map is the default for a first visit

- Change what a legend swatch says on hover:
  - `MapController.renderLegendTip()` for the wording, `formatLegendValue()` for how a number
    reads (shares, index points and GDP figures share one narrow line, so magnitude picks the
    precision), `placeLegendTip()` for placement, `.legend-tip*` in `styles.css`
  - the spans come from `GET /api/class-breaks`; swatch *i* is always quantile class *i + 1*,
    low to high. The mapfile reorders its classes per polarity and `legendColorsForPolarity()`
    reverses the colours to match, so the bar always reads low-to-high left to right — do not
    reorder the swatches themselves
  - the swatches are built once in `initializeLegend()` and only recoloured afterwards; a
    refresh that rebuilt the bar would drop the focus and hover the card hangs off
  - during autoplay the breaks are fetched on hover only: prefetching per year would be stale
    before anyone could read it

- Change variable title/metadata dialog behaviour:
  - `MetadataController.refreshVariableMetadataPanel()`

- Change the variable coverage strip:
  - the numbers are not computed here. `scripts/build_variable_coverage.sh` in the
    deployment repo writes `config/variable_coverage.json` during setup; the list draws
    a strip for every row at once, so nothing in this path may hit the backend
  - `MetadataController.renderCoverageStrip()` turns the variable's digit string into one
    `<path>` via `buildCoverageStripSvg()`. One path per row is deliberate: 60 bars as
    elements across the list would be thousands of nodes, rebuilt on every filter change
  - the axis is per variable: the strip runs from that variable's first year to its last
    and uses the full width of the track, so the two years `buildCoverageAxis()` writes
    underneath are the only scale it has — a strip without them is unreadable, which is why
    `renderCoverageStrip()` inserts them itself rather than leaving it to its callers.
    The axis used to be shared by every dataset and floored at 1900, so that a bar in the
    same place meant the same year on every row; that bought comparison between rows at the
    price of a QoG row spending three quarters of its width on the years before QoG starts,
    and of V-Dem's 18th-century series being cut off at the left edge. The `::before`
    baseline stays, now drawing the variable's own span, so a series with a gap in the
    middle still reads as one strip
  - bar height folds sampling frequency and country coverage into one number, and is
    floored at level 1 so a 32-country sample still shows where its span begins
  - `.variable-option-coverage*` in `styles.css`; the SVG is `fill: currentColor`, which
    is what lets a selected row's white background flip the bars to dark ink for free

- Change the variable hover card:
  - `MetadataController.bindVariableTooltip()` (hover intent, dismissal) ->
    `showVariableTooltip()` (lazy fetch through the same per-variable cache the dialog uses,
    so hovering a row warms the dialog too) -> `getVariableSummary()` -> `renderVariableTooltip()`
    -> `positionVariableTooltip()`
  - the card ends with a COVERAGE block: the same strip the row carries, plus the axis
    endpoint years and a sentence saying what bar height means. The row has to be read
    at a glance and cannot carry either, so the card is the only place they fit
    (`appendVariableTooltipCoverage()`); the axis labels are the *dataset's* years, since
    those are what a strip starting halfway along is read against
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
  - the *persistent* form of the same card is `openVariableInfoPopover()`, opened by a click
    rather than a hover and dismissed by Escape or a click outside. Its triggers are the row
    info buttons (touch only), the phone action button, and the info button in the timeline
    caption; all three are listed in the `pointerdown` allowlist in `bindVariableTooltip()`,
    and a fourth has to be listed there too

- Change polarity mapping behaviour:
  - `config/variable_polarity.json`
  - resolution logic in `MetadataController.resolveConfiguredPolarity()`

- Change the colour schemes, or add one:
  - `src/core/palettes.js`, and nothing else on this side. The picker, the legend bar, the
    direction hint, the cookie and the map's spoken summary are all driven from
    `MAP_PALETTES`; a scheme added there appears in all five
  - the hexagons are painted by MapServer, not here, so a scheme cannot be a stylesheet: it
    travels with the tile request as `palette`, which the `DATA` query turns into an offset
    on `class_idx`. A new scheme therefore also needs a `WHEN` arm in the four `DATA` strings
    and its key in the four `VALIDATION` blocks in `mapserver/mapserver.map`, plus a run of
    `node scripts/build_hex_classes.mjs`
  - **a band's `base` is permanent.** It is baked into every cached tile, and because the
    scheme rides in the URL while the base does not, renumbering one would leave both caches
    serving the old colours under the new legend. Add a band at a fresh base
  - `honoursPolarity` is the real difference between the two kinds of scheme. The diverging
    ones encode *valence* -- one end is the unfavourable end, and `polarity` picks which --
    so their signed band is reversed for positive polarity, here and identically in SQL. The
    sequential ones have no second end to put anything at, so they run low-to-high always and
    ignore polarity; the "which end is bad" cue then lives only in the legend's end labels,
    which are words. That is the trade the reader makes by picking one
  - the default scheme deliberately sends **no** `palette` parameter. It renders identically
    to `palette=default`, but it is a different URL, and both the mapcache and the service
    worker key on the URL

- Change legend text/rules/colours:
  - `config/legend_semantics.json`
  - rendering in `MapController.refreshLegend()`
  - the bar is followed by a **No data** swatch (`.legend-nodata`), which is not part of
    the ramp: a country with no value for this variable and year is not drawn at all, and
    neither is its outline, so what shows through is the land basemap. It was a colour on
    the map that the legend did not speak for, which left the cream over Greenland or
    Antarctica reading as a shade the ramp had run out of. The swatch is painted from
    `--land-basemap`, which `initializeLegend()` writes onto the legend from the same
    `LAND_BASEMAP_COLOR` the basemap style uses, so the two cannot drift
  - it is the one thing in the scale that survives the phone breakpoint, where
    `.timeline-legend-copy` is hidden: the note restates what the ramp already shows, and
    nothing else on a phone says what the cream means
  - **the legend is in two places, because it says two kinds of thing.** The *scale* —
    `.legend-scale`, the ramp with its two end labels and the no-data patch — is a key to
    the picture and is built into `.map-legend-slot` in the dashboard's Colours panel,
    *above* the picker that chose those colours: the bar is what the reader is reading the
    map against and the four schemes under it are the choice that made it, so key first,
    control second. The *words* — `.legend-title` and
    `.legend-note` — are written into `#mapLegendCopy` in the timeline overlay, under the
    variable caption, because what they qualify is the variable and not the bar. Both were
    one 154px navy dock across the foot of the pane; the dock is gone, `#map` is one grid
    row, and everything in `styles.css` under "Quantile legend" is dark on pale rather
    than white on navy because of it
  - the two end labels are clipped to one line with their full text in `title` where the
    pane is narrow. Wrapped they take three lines apiece at 900-1200px, and the dashboard
    is as tall as this panel — three lines there is what turned the View buttons into tall
    rectangles. They still wrap on a phone, where there is no tooltip to recover them from
    and nothing else visible says which way the colours run
  - the note is one line with an ellipsis and its full text in `title`. It runs to a
    sentence and a half for some indicators, and the overlay it sits in is standing on the
    map — a line that wrapped would move `--timeline-inset` and with it the top of the
    table view. It is in `#mapSummary` in full for anyone not hovering
  - **the dashboard's height is the Colours panel's height**, because the panel is the
    tallest of the three and `.map-choice-section` is a flex column whose control fills it.
    Everything that makes this panel taller comes out of the map, which is why the scheme
    names are a `visually-hidden` span plus a tooltip rather than a line of text under each
    swatch strip: four names cost a line of the whole dashboard. Keep the View buttons near
    square by keeping this panel short, not by capping them
  - the dashboard is a single grid row, so it cannot spend more width than `#map` has.
    A window between 900 and 1200px still has the sidebar, which leaves the pane
    560–840px, and at full size the three panels do not fit it — hence the
    `(min-width: 901px) and (max-width: 1200px)` block, where every panel gives a little.
    `#map { overflow: hidden }` does not clip politely: what does not fit disappears, and
    the legend with it

- Change autoplay/timeline behaviour:
  - `DemscoreApp` methods: `scheduleAutoPlayTick`, `setYear`, `renderTimelineScale`
  - the speed stepper carries a `Speed` caption (`.speed-button-label`). It is absolutely
    positioned over the group on purpose: the multiplier has to stay the prominent, centred
    reading, and anything in the flow would push it off the line the Animate button's own
    text sits on. It is `aria-hidden` — the group already carries `aria-label="Timeline speed"`

- Change the variable caption under the timeline:
  - `#timelineVariableTitle` in `index.html`, `DemscoreApp.renderTimelineVariableTitle()`,
    `.timeline-variable-*` in `styles.css`
  - it is rendered from `refreshTimelineForActiveVariable()`, which is the one place the
    timeline is rebuilt for a new selection and therefore the only place either half of the
    caption can have changed. Setting it anywhere else means two places to keep in step
  - it replaces its whole contents, so the boot placeholder in `index.html` goes with the
    first render — see "Loading placeholders"
  - it is now the only place the selection is named. The legend dock at the foot of the map
    used to repeat it word for word, which on a tall window put the year and the thing
    being counted a screen apart; the dock is gone and that repetition with it. Directly
    under the caption is `#mapLegendCopy`, the legend's *words* — what the quantile classes
    are and which way the colours run — on a pill of its own, because what they qualify is
    the variable on the line above. On a phone both are hidden: the picker button above the
    timeline already names the variable, and the strip of map is worth more
  - the caption ends in an info button (`.timeline-variable-info`) that opens
    `MetadataController.openVariableInfoPopover()` — the same persistent card a row's own
    info button opens, for the variable actually on the map. It matters most on a desktop,
    where `.variable-option-info` is `display: none` above the coarse-pointer breakpoint and
    the rows only ever show their card on hover: there was no way to open one and keep it
    open, and none at all without going back to the list
  - it is bound by delegation on `#timelineVariableTitle`, because the caption is rebuilt on
    every selection change and a listener on the button would go with the button. The dataset
    and variable are stamped on the button rather than read from state when it fires, the way
    `.variable-option-info` does it
  - **a new trigger for the persistent card must be added to the click-outside allowlist** in
    `bindVariableTooltip()`'s `pointerdown` handler, or its own opening click counts as a
    click outside and shuts the card in the same gesture that asked for it

- Change the timeline axis / tile-preload progress bar:
  - the axis *is* the preload track: `#timelinePreloadTrack` is a row of
    `.timeline-preload-segment` marks that fill in teal as `LayerPreloadController`
    caches tiles (there is no separate `.timeline-line`)
  - **one mark says two things.** Its *height* is how much data the selected variable
    has for the years it covers; its *fill* is how much of those years is in the tile
    cache, rising from the floor rather than sweeping across, so the two readings
    cannot be confused -- one is how tall, the other is how full. They were two
    stacked rows for a while, a coverage band over the marks, which spent twice the
    height saying two things about the same column
  - `DemscoreApp.buildPreloadSegments()` buckets years into boxes so each stays at
    least `PRELOAD_SEGMENT_MIN_PX` wide, so the segment count depends on the rendered
    track width and is rebuilt (debounced) on window resize
  - boxes are absolutely positioned and centred on the years they cover, using the
    same `(year - yearMin) / span` mapping as the ticks and the selected marker, so
    they line up; the end boxes overhang the track by half a box, which nothing clips
  - a coverage of only a few years caps mark width at `PRELOAD_SEGMENT_MAX_PX`. There
    used to be an `.is-sparse` class for that case, to put a baseline behind marks too
    far apart to tile; the floor is unconditional now, so the spacing no longer changes
    anything
  - `buildTimelineTickYears()` ticks *every* year for spans up to
    `TIMELINE_DENSE_TICK_SPAN`, endpoints included; the wider step ladder ticks the
    round numbers inside the range and then adds the two endpoints itself. The ladder
    is the same 1800..2000 whichever V-Dem variable is on the map, so the endpoints
    are the only part of the axis that says anything about *this* variable, and they
    are always drawn and always labelled
  - `dropTimelineLabelsNearEdges()` then takes the label off any ladder tick that runs
    into an endpoint label (1800 against 1789, and 2000 against 2025 on a narrow
    window). The mark stays; only the number goes, and the endpoint always wins. It
    measures the rendered labels rather than estimating from the year span, because
    how wide "1789" is depends on the font the browser actually used
  - mark height comes from `DemscoreApp.buildCoverageHeightLookup()`, which reads the
    *precomputed* strip (`MetadataController.getCoverageStripData()` ->
    `config/variable_coverage.json`) -- the same digits the variable list draws under
    every row, so one variable is one shape wherever it appears. The strip's buckets
    are coarser than the segments, so a segment takes the mean of the buckets its
    years fall in: a resample, not new detail. Per-year counts would be finer, but
    `countryCountsByYear` is a field the client reads and the backend has never sent,
    and filling it for 165 variables would about triple a 163 KB config fetch made on
    every load. With no usable strip the lookup returns null and every mark falls back
    to the flat `--track-height` the stylesheet gives it, which is what this looked
    like before the two merged
  - `--axis-y` is the floor the marks stand on and the line the whole axis is placed
    from: marks grow up from it by `--coverage-band-height` (which must equal
    `COVERAGE_BAND_PX` in `DemscoreApp`), the tick marks and labels hang below it, and
    the year marker drops from it. `.timeline-preload-track::before` draws that floor,
    always -- it used to appear only where the boxes were too far apart to tile, but
    marks of differing heights need a line to stand on at every spacing. It is darker
    than a resting mark on purpose: at the same weight the two merge and the marks
    read as sitting in a grey trough
  - hovering a mark opens `#timelineMarkTooltip` (`bindTimelineMarkTooltip()` ->
    `segmentAtClientX()` -> `showMarkTooltip()`): the years, what is in them, the cache
    state, and a note saying what height and fill mean. The listener is on the *wrap*,
    not the marks -- `#yearSlider` is stretched over the whole wrap to catch scrub
    gestures and the marks are `pointer-events: none` so they do not eat them, so this
    reads the events that bubble up without taking any. It answers only near the axis
    (`isNearTimelineAxis()`), never mid-drag, and mouse only. The card is at *body*
    level, like the variable card and for the same reason: `#timeline-overlay` carries
    a `transform`, which would make it the containing block for a fixed child and
    shrink the card into whatever room was left right of the pointer
  - `DemscoreApp.renderPreloadState()` aggregates per-year status/progress into each
    box; `renderTimelineScale()` replays the last snapshot after a rebuild
  - box height lives in `--track-height` on `.timeline-slider-wrap`, box width in
    `--preload-box-width` written onto the *wrap* by JS; tick marks sit above the boxes
    and tick labels below, both offset from `--track-height`
  - the end boxes are centred on the wrap's edges, so each hangs half a box width past
    it -- widest on short spans, where the box grows to `PRELOAD_SEGMENT_MAX_PX`. The
    white backdrop (`.timeline-slider-wrap::before`) therefore reaches out by
    `--backdrop-overhang`, derived from the box width, and `#timeline-overlay` keeps a
    gutter wide enough for it; a fixed inset left the end box grazing the corner
  - `.timeline-scale` sits above the marker on purpose, and tick labels use an opaque
    halo instead of `opacity`, so the marker line breaks around a label instead of
    striking through it. A resting `.timeline-preload-segment` is mixed towards the
    paper colour for the same reason rather than given an `opacity`: on a phone the
    axis is drawn over hexagons, and a translucent mark would take its colour from them

- Change anything about the projection, panning limits or world fit:
  - `src/core/projection.js`. The map is drawn in Equal Earth (EPSG:8857) by default
    and so is every hexagon MapServer generates; Web Mercator is offered beside it,
    as a toggle, because comparing the two is the clearest way to see what a
    projection does to the data. The toggle is two thirds of the View switch —
    see "Change which view is on screen" — so a third projection is a fourth
    option in that radiogroup, not a control of its own
  - everything projection-shaped goes through `getMapProjection(key)`, which hands
    back one plane's OpenLayers projection, world box, view box, tile grid, MapServer
    layer pair and hex size ladder. Add a third projection there and the toggle, the
    tile grid, the pan limit, the world fit, the layer names and the mesh sizes
    all follow; nothing else in `MapController` names a projection or a layer
  - **`extent` and `viewExtent` are two different boxes.** `extent` is the whole plane
    and is what the tile grid is cut from, so it can never be narrowed: a tile
    coordinate is a slice of it, and moving it would rename every tile, void the
    browser cache and the mapcache warm-up alike, and leave the preloader counting
    tiles nobody asks for. `viewExtent` is the same box with everything south of
    `VIEW_SOUTH_LIMIT_LAT` (60S) cut off, and it is what `measureWorldFit()` measures
    and what the view is given as its pan `extent`. Nothing below 60S carries an
    indicator value — the southernmost land outside Antarctica is Chile at 55.6S, and
    Antarctica is on the basemap but in no dataset — so that band was a share of the
    scale spent on cream
  - cropped, not deleted: `constrainOnlyCenter` bounds where the centre of the window
    may go, not what may be drawn, so Antarctica is still there to pan down to. It is
    just no longer budgeted for
  - what the crop is worth depends on which axis binds, and the two projections answer
    differently. `worldFitResolution` takes the *larger* of width/window-width and
    height/window-height, so a shorter box only buys anything where height was the
    larger. Equal Earth's world is 2.25:1 and almost every window is taller than that,
    so there the crop is a pan limit and nothing else except on an ultrawide screen
    (measured: no change at 1440x900, 1920x1080 or 1280x1024; zoom 3.10 to 3.23 at
    2560x1080). Web Mercator's world is square, so height binds nearly always and the
    crop is worth 29% of the box — zoom 1.53 to 2.02 at 1440x900, which is the whole
    empty stretch between Cape Horn and the pole
  - the two southern limits are written out as projected metres from PROJ, for the same
    reason `EQUAL_EARTH_HALF_X/_Y` are: the projections are not registered until the
    first map is built, so nothing can be projected at module scope
  - the view is given an explicit `resolutions` ladder, built by
    `viewResolutions()`: the world fit at the top, halving from there, and
    `MAX_ZOOM`'s resolution exactly at the bottom. Handed only a floor and a
    ceiling, OpenLayers keeps the floor and rounds the *span* down to a whole
    number of levels, which made `MAX_ZOOM` of 6 come out as 5.52 in one window
    and 5.72 in another. A ladder cannot be changed after a view has it, so a
    resize rebuilds the view (`applyWorldFit()`) rather than adjusting it
  - **zoom is not `view.getZoom()`**, and the difference is not cosmetic.
    OpenLayers anchors its zoom numbering to whatever resolution the view holds as
    its coarsest, which moves every time the world-fit floor is re-measured and
    differs between the two planes. The app's zoom is Web Mercator metres per pixel,
    computed from the resolution by `zoomForResolution()`, so the hex resolution
    stops, `MAX_ZOOM` and the readout mean one fixed thing on both sides of the
    toggle and across a resize. `MapController.getZoom()` is the only place to read
    it from
  - panning is `extent` plus `constrainOnlyCenter: true` on the view, which says the
    centre of the window must stay on the globe: any point can be brought to the
    middle of the screen and no further. OpenLayers' looser reading — keeping the
    whole viewport inside the world — is the one that cannot be used: the world is a
    fixed box in a window of whatever shape, and at zoom 3.73 in a 740px-tall map it
    stands 1484px high, so nothing north of about 35N could ever be centred
  - the world box is not the transform of `(-180,-90)` and `(180,90)`. Equal Earth is
    widest on the equator (x = `+/-17243959`) and narrowest at the poles
    (`+/-10216474`), so a box built from the corners is 41% too narrow and cuts off
    everything east of about 106E. `EQUAL_EARTH_HALF_X` / `_HALF_Y` are the real
    numbers, and the mapfile and the mapcache preloader use the same two
  - both projections share Web Mercator's resolution ladder, so a zoom level means
    the same metres per pixel in either and the toggle does not move the mesh
  - the toggle carries the scale across as a *multiple of the world view*, not as
    metres per pixel: the two worlds are different sizes, so keeping the metres would
    turn a world view into a view of the Atlantic
  - **each projection has a mesh of its own**, and the toggle switches MapServer
    layers, not just the SRS. `hex_variable`/`hex_outline` are cut in
    Equal Earth, the `_mercator` pair in Web Mercator. Reprojecting
    one mesh into the other plane is what this replaced: a hexagon is a hexagon
    only where it was cut, and an Equal Earth cell pushed into Mercator is twice
    as tall as it is wide by 60N and a sliver by 80N. What the toggle compares is
    what a cell *means* — a fixed amount of ground against a fixed amount of
    screen — not how well one mesh survives being stretched
  - both projections use the **same** hex sizes (200k/100k/50k). A cell is drawn
    `hexSizeM / resolution` pixels across in either plane, so equal sizes are equal
    grain on screen and the toggle changes the shape of the world, not the weave of
    the mesh. Mercator's sizes used to be doubled to equalize the worldwide cell
    *count*; that made every Mercator cell twice as wide on screen. The differing
    counts are the point, not a defect. Both sizes must exist in the database or the
    layer renders nothing. See `hexResolutionStops` in `core/projection.js` and
    `sql/mapserver_hex_mercator.sql`
  - `wmsLayerNames()` returns the layers **in drawing order**, because MapServer
    draws them in the order they are named: the fills, then the outline layer over
    them. A layer added to a GetMap must also be added to
    `CACHEABLE_WMS_LAYERS` in `sw.js` — that set is closed, and one unknown name
    makes the whole tile fall through uncached
  - the land basemap is *not* densified before projecting. Equal Earth curves the
    meridians, so a long straight lat/lon edge is drawn as a chord of the curve it
    should follow, but measured against Natural Earth 110m the worst segment in the
    world (the 141W Alaska/Yukon border) is off by 6.3km — 0.2px at the world view
    and 2.6px at `MAX_ZOOM`, with 8 segments of 10360 over 1px even there. Not worth
    a densify step; re-measure before adding one

- Change map baselayers or WMS swap behaviour:
  - `MapController.initialize()` and `MapController.loadNextLayer()`
  - the pending layer is added at `opacity: 0`, which OpenLayers still renders and so
    still loads tiles for — it only drops the layer at the compositing step. What says
    the layer is ready is `whenPendingLayerDrawn()`, and it must always say something:
    autoplay schedules its next year from that answer, so a swap that never lands stops
    the animation with the button still reading "Pause". It therefore listens for four
    things and takes whichever comes first:
    - the map's `rendercomplete`, the best reading and the only one that also covers a
      layer whose tiles OpenLayers already had. The map only works out whether a frame
      was complete while someone is listening, so one `postrender` of our own is what
      tells a fresh "yes" from a stale one. It cannot be the only reading, because it
      is map-wide: one tile request anywhere that never settles holds it back forever,
      and under a preload-loaded MapServer that is not hypothetical
    - the layer's own `tileloadend`/`tileloaderror` count reaching the number of tiles
      the view asks for (`getVisibleTileCoords()`, the same count the preloader uses).
      Counting the tiles that happened to start, rather than the ones the view asks for,
      would land early: the map loads at most 16 tiles at once, so a layer's first wave
      can report back while the rest is still queued. `PENDING_LAYER_QUIET_MS` then
      rides out the seam between waves
    - `PENDING_LAYER_STALL_MS` since the last tile came back, for a layer that was
      arriving and stopped. A slow MapServer pushes this forward with every tile it
      answers, so slow is waited for and stalled is not; the year is shown as far as it
      got and the rest paints in once that layer is the live one
    - `PENDING_LAYER_DEADLINE_MS` for a layer that never answered at all, where there is
      no arrival rate to judge and nothing to show either way
    `DemscoreApp` keeps a ceiling of its own (`AUTO_PLAY_FRAME_CEILING_MS`) above all of
    these, for the case where the answer is not late but lost — a swap cancelled out from
    under the frame waiting on it. A frame also carries a ticket (`autoPlayTicket`), so a
    late answer cannot schedule a year on top of the one that replaced it
  - a swap can be superseded before it lands — a zoom crossing a hex resolution stop
    reloads the layer while autoplay is still waiting on the previous one. The waiting
    callback (`pendingLayerOnReady`) moves onto the replacement rather than dying with
    the layer it was attached to: autoplay schedules its next year from that callback,
    so dropping it froze the timeline with the button still reading "Pause". An explicit
    `stopPendingLayerSwap()` — pause, or a scrub — still drops it, which is why that
    method clears it and `loadNextLayer()` rescues it first
  - `updateHexLayerForZoom()` compares the new mesh against the *pending* layer when
    there is one, since that is what the map is about to show

- Change the equal-colour area outlines (the black perimeter around each run of
  same-shaded hexagons, toggled by `#areaOutlineToggle` bottom-left):
  - the outlines are a second MapServer layer, `hex_outline`, asked for in the *same*
    GetMap as the fills — `MapController.wmsLayerNames()` decides whether `LAYERS` names
    one layer or two. One request means one image and one cache entry, so outlines can
    never lag a year behind the colours they belong to; the cost is that toggling
    rewrites every tile URL and therefore refetches
  - the checkbox is the Outlines panel of the bottom-centre dashboard
    (`installMapChoiceDashboard()`), beside the View switch and the colour picker. The
    layer toggles and the zoom reading are a separate bottom-left stack
    (`installDisplayOptions()`); OpenLayers has no layer switcher of its own — the price
    of it drawing every layer into one canvas rather than into stacked panes — so the two
    together replace what Leaflet spread over `L.control.layers` and a custom one
  - the layer toggles and the zoom reading carry `.map-display-extra`, which `styles.css`
    hides until Shift+D puts `shows-extras` on the stack
    (`installDisplayExtrasShortcut()`). They are hidden, not absent: their inputs still
    exist, so `syncDisplayOptions()` and the cookie-backed state work whether or not
    anyone has pressed Shift+D
  - the Outlines panel is made `inert` by `syncViewSelector()` while the table view is on.
    An outline is something the picture has and the table has not, so the control is
    turned off rather than left to do nothing when pressed
  - `MapController.setAreaOutlinesEnabled()` stores the choice in a cookie
    (`core/preferences.js`) and calls `onLayerParamsChange`, which `DemscoreApp` wires to
    `restartPreload` — the preload marks count tiles under the old URL and would
    otherwise claim years are cached that are not
  - `LayerPreloadController.start()` includes the toggle in its resume signature for the
    same reason

- Change how the read-ahead and the animation share MapServer:
  - they want the same backend at the same moment, and only one of them is being
    watched. `LayerPreloadController` asks `waitForNetworkTurn()` before every tile it
    cannot answer from the cache; `DemscoreApp.takePreloadNetworkTurn()` grants it
    at once outside autoplay, and during autoplay only after the frame on its way to
    the screen has landed (`MapController.whenLayerSwapSettles()`) and after whatever
    read-ahead request is already out. At most one unwatched year is being rendered
    ahead of the one on screen
  - reading a year the cache already holds is not a request and never waits, which is
    what lets the animation run at full speed across the preloaded stretch and then
    carry on at the rate new tiles arrive
  - pressing Animate restarts the preload run (`startAutoPlay`): it drops the dozen
    requests already in flight, which the first frame would otherwise queue behind, and
    re-anchors the year queue on the year the animation starts from. Years already
    cached keep their marks — the run asks for the same thing, so it resumes
  - what the outlines are drawn from, and why they follow areas rather than hexagons,
    is in the repository root `AGENTS.md` and `mapserver/README.md`

- Change anything about how the map reads without sight:
  - `src/controllers/MapDataController.js`. The map is a WMS image, so there is no feature
    under the pointer to interrogate and nothing inside the tiles an assistive technology can
    be asked about. These three are its equivalent, not a description of it:
    - `#mapSummary` — the standing reading: dataset, variable, year, projection, how the
      colours run, how much of the world carries a value, and each class's span. A `region`,
      **not** a live one: it is several sentences plus seven list items and it is rewritten
      on every frame of an animation
    - `#mapAnnouncer` — the live one, `role="status"`. One sentence, only once the selection
      has stopped moving (`ANNOUNCE_SETTLE_MS`), and never during autoplay. A polite region
      that fires per keystroke is worse than none: the reader hears the first word of each
      announcement and none of the rest
    - the **table view** (`TableViewController`) — the countries as sortable rows, with the
      same rows as a CSV built in the browser from what was already fetched. It replaced a
      modal of the same rows, `#mapDataDialog`, opened from a **Data table** button on the
      legend; the view is reached from the View switch instead and stays on while the year
      moves
  - a change that colours the map from anything other than `demscore.country_scores()` has to
    bring all of this with it; nothing enforces that the picture and the text agree beyond
    their both being read from that function

- Change a control's focus behaviour, a dialog, or the hover card:
  - `:focus-visible` at the top of `styles.css` is the floor every control falls back to.
    A rule that sets `outline: none` has to put something at least as visible in its place
    in the same block — `#yearSlider` is the worked example: the input is transparent and
    stretched over the whole wrap, so its ring is drawn on `.timeline-marker-line` and
    `.timeline-year-label` through `.timeline-slider-wrap:has(#yearSlider:focus-visible)`
  - `#variableTooltip` is two cards in one element. Hovering a row shows it as a `tooltip`;
    clicking an info button shows the same content as a non-modal `dialog` with a close
    button, a focus moved into it and a focus given back.
    `MetadataController.openVariableInfoPopover()` and `hideVariableTooltip()` switch the
    role, the close button and the trigger's `aria-expanded` together — none of the three can
    move without the other two. A new trigger needs `aria-haspopup="dialog"`,
    `aria-expanded`, `aria-controls="variableTooltip"`, *and* an entry in the `pointerdown`
    allowlist (see below)
  - the card's `focusout` closes it, except when the focus is going to the trigger that
    opened it: focus lands on a button before its click handler runs, so closing there would
    beat the toggle to it and the click would reopen what it meant to shut
  - **anything given `display:` in a rule of its own needs a matching `[hidden]` rule**, or
    the `hidden` attribute stops working on it — `.variable-tooltip-close[hidden]` is there
    because it did
  - the phone picker is a grouped list of buttons, not a listbox. It used to claim
    `role="listbox"` over `role="option"` children with none of the keyboard behaviour that
    promises. Restoring the listbox would mean arrow keys, Home/End, typeahead and
    `aria-activedescendant`; nothing here wants to mimic a native select, so it says what it
    is and marks the current one with `aria-current`

- Change the coverage strip's text:
  - `MetadataController.describeCoverage()`. `renderCoverageStrip()` draws the strip and
    hands back what it drew rather than placing the text itself, because the two callers need
    it in different places: in the sidebar the row is a `<label>` wrapping a radio, so text
    put inside it lands in the radio's *name* and, with `aria-describedby` pointing at the
    same span, is then read a second time as its description
  - the phone picker option *is* the button, so its text joins the button's name. The years
    under the strip are `aria-hidden` there (they would otherwise be read as part of the
    button's name), so the whole sentence is added, and the meta line above is the variable
    key alone — it used to repeat the year range the strip now carries

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
- `node --check src/controllers/MapDataController.js`
- `node --check src/controllers/TableViewController.js`
- `node --check src/core/csv.js`
- `node --check src/controllers/AboutController.js`
- `node --check src/core/attribution.js`
- `node --check src/core/palettes.js`
- `node --check src/core/projection.js`
- `node ../scripts/build_hex_classes.mjs --check` and `node ../scripts/check_palette_contrast.mjs`
  if any colour moved — together they check that every scheme still matches the classes
  MapServer paints, and that no adjacent pair has collapsed under a colour-vision deficiency

Then do a manual smoke test in browser:
- boot state (throttle the network or delay `/api/config/**`): three dots under "Filter by
  topic", "Filter by dataset", in the Variable well and in the caption under the timeline; the
  timeline shows its backdrop and a placeholder rule with no year marker; all of it is gone
  once the config lands, with no `.loading-dots`, `[aria-busy]` or `.is-awaiting-data` left in
  the DOM
- search box: typing narrows the list across datasets and the summary reads "n of N
  variables"; a query that matches nothing is quoted back; a query plus a lit chip that match
  nothing reads "No variables match these filters" instead; Escape in the box empties it and
  restores the full list; the box ANDs with the chips rather than replacing them
- panel is white and the rows carry the dataset colour, not the sidebar; a dataset chip, the
  rows it matches and that dataset's info card are recognisably the same colour
- filter chips: a topic chip narrows the list across datasets, a dataset chip narrows it further
  (the two groups AND), clicking a lit chip clears it, and an impossible pair such as
  Gender + V-Dem reports "No variables match these filters" without disturbing the map
- cross-dataset pick: choose a row whose left edge is not the current dataset's colour; the
  accent, legend and map all follow it. How to cite the dataset and where to get it are only
  in the info cards now — no sidebar citation line, no phone Source or PDF action: a card
  carries a SOURCE item and a footer with the codebook PDF beside a "Download data from
  Demscore" link to that dataset's download ID, and the dataset chip's own hover card carries
  the same pair. On a phone those two footer links are full-width buttons rather than text
- variable list: click a row, arrow-key through the list (which crosses dataset boundaries),
  and Tab out in one stop — including while a filter hides the selected row
- coverage strips: every row has one, it fills the row's full width, and the years under
  its two ends are that variable's first and last — a 2012–2024 QoG row and a 1789–2025
  V-Dem row are both full-width and say so underneath. Hovering a strip reports the same
  range and the country count. Two rows are *not* on a shared scale, which is what those
  year labels are there to make plain
- timeline axis: the first and last year of the selected variable are labelled at the two
  ends whichever variable it is, no label collides with them, and the marks standing on the
  axis are the same shape as that variable's row in the variable list. Hovering one names
  its years and says what the height and the fill mean; hovering does not interrupt a scrub,
  and dragging the marker dismisses it
- View switch: all three options fit their panel at every window width — drag the
  window across the whole range and the dashboard is never clipped by `#map`'s
  `overflow: hidden`, and the selection slab lands exactly on the chosen option at
  each of the three positions. Picking Table replaces the map, picking either
  projection brings it back looking at the same place at the same zoom, and both
  choices survive a reload
- CSV download: open one in a spreadsheet and check the first five columns name
  the dataset, the variable and the year on *every* row — not just in the
  filename; scrub to another year, download again, and the two files should
  concatenate into one table that still reads correctly. Both buttons (the table
  view's, and any other added later) must produce the same columns
- table view: rows sort on every column but `±` and `#`, the arrow and
  `aria-sort` agree, the class swatch matches the legend bar's colour for the
  same class, a country with no value for the year keeps its place and sorts to
  the end whichever way the column points, and the CSV is the rows in the order
  shown
- table view columns: drag the window across the whole range — Country must have
  real width at every one of them and the table must never push the pane
  sideways. The bands are 900px (ISO3 and Boundary go) and 1100px (Boundary
  goes); those two edges are where it fails first
- table view `±`: scrub a year and check a row that moved reports the direction it
  moved *in the current sort* — re-sort by Country, where almost nothing moves,
  and the column should go almost all dots. Sort by Value descending and it
  should agree with the rows that just changed places
- following a row: click one, press Animate, and it stays marked and findable as
  the order rearranges. Enter does the same from the keyboard, Escape clears, and
  the mark survives a re-sort and a change of year but is on the country rather
  than on the variable
- following several: mark six rows and check each takes a different ink, that
  unmarking one and marking another gives the freed colour back rather than
  walking the rest along, and that **Deselect all (n)** appears with the first
  mark, counts correctly and goes when the last is cleared
- rows joining mid-animation: animate backwards past 1871 on a V-Dem variable
  and watch for rows that never fade in. The German and Italian states are the
  ones that arrive there; a row stuck at opacity 0 means the entrance animation
  is being restarted by the reorder again
- table view stability: press Animate and watch the table's top edge and its
  column boundaries — neither may move. The summary stays two lines and the
  columns stay put whatever the values do; only the rows move
- table view animation: sort on Value, press Animate, and the rows glide past each
  other rather than jumping; at 8x nothing is still moving when the next year
  lands; under `prefers-reduced-motion: reduce` the order still changes and
  nothing moves. The timeline marks fill in as the *rows* are read ahead, and the
  mark card says "Table rows" rather than "Map tiles"
- table view animation, cost: profile it rather than watching it. At 8x the
  budget is roughly **55fps and no long tasks**; if long tasks come back, the
  thing to look for is a DOM *read* that has crept back into `renderRows` — one
  `offsetTop` or `getBoundingClientRect` on every row is a forced layout of the
  whole table, and three of them a frame is what took it down to 18fps before.
  Scroll halfway down the table and step a year: the rows that glide should be
  the ones on screen, not all 245
- switching view mid-animation: the timeline keeps moving, does not stall on the
  frame that was in flight, and the button never sticks on "Pause"
- year scrub + autoplay; the caption under the timeline names the variable the map is drawing
  and follows every way of changing it — a row, a filter that changes the selection, a
  remembered choice on reload
- the caption's info button opens the full variable card (question, overview, scale, coverage
  strip, source, codebook and download links), the card closes on Escape and on a click
  anywhere outside it but *not* on the opening click, and after switching variable the button
  opens the new one's card
- southern crop: at the widest zoom no more than a sliver of Antarctica is in frame, and
  dragging south stops with 60S at the middle of the window rather than running on into empty
  ocean. Both projections; Mercator is where it shows most
- variable hover card: description appears beside the hovered row, follows arrow-key focus,
  and disappears on scroll, Escape and dataset switch; its COVERAGE strip matches the one
  in the row it points at, and its end years are the shared axis, not the variable's own
- metadata dialog open/close
- legend update and map tile refresh
- dashboard containment: drag the window across the whole range — every width must show
  all three View options, all four colour schemes (or the phone's select), the outline
  toggle, the bar and both end labels, with the whole dashboard inside `#map`. The
  in-between widths (a window wide enough to keep the sidebar but not wide enough for the
  panels at full size, roughly 900–1200px) are the ones that fail first, and `#map`'s
  `overflow: hidden` makes a failure invisible rather than ugly. The credit line at the
  foot must not be under the dashboard at any width either — it is where the CC BY-NC-SA
  and GPL-3.0 attribution is discharged
- keyboard: the pass in the repository root's `ACCESSIBILITY.md`. Tab order should run
  sidebar -> timeline -> map -> map dashboard, which is the visible layout and the reason
  `#timeline-overlay` sits before `<main id="map">` in the source despite being painted over
  it
- colour schemes: each of the four repaints the hexagons *and* the legend bar together, the
  legend note describes the scheme actually on screen, the choice survives a reload, and the
  bar still reads low-to-high left to right in every one of them — compare a positive-polarity
  variable against a negative one in a diverging scheme, where the band is reversed
- projection toggle: Equal Earth and Mercator both draw land and hexagons, the view keeps
  looking at the same place and the same fraction of the world, the zoom readout means the
  same thing in both, and switching back leaves no stale tiles. **Every cell is a regular
  hexagon in both** — slivers, columns or bands mean the wrong mesh is being served for the
  SRS. Zooming in must reach exactly 6 in either projection, at every window size

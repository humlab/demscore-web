(async function init() {
  const mapServerBase =
    window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
      ? "http://127.0.0.1:8088/?map=/etc/mapserver/mapserver.map"
      : `${window.location.protocol}//${window.location.hostname}:8088/?map=/etc/mapserver/mapserver.map`;
  const webBackendBase =
    window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
      ? "http://127.0.0.1:8091"
      : `${window.location.protocol}//${window.location.hostname}:8091`;

  async function fetchBackendJson(path, errorLabel) {
    const response = await fetch(`${webBackendBase}${path}`);
    if (!response.ok) {
      throw new Error(`${errorLabel}: ${response.status}`);
    }
    return response.json();
  }

  const [meta, legendMeta, polarityMeta] = await Promise.all([
    fetchBackendJson("/api/config/variables", "Could not load variables config"),
    fetchBackendJson("/api/config/legend-semantics", "Could not load legend semantics config"),
    fetchBackendJson("/api/config/variable-polarity", "Could not load variable polarity config"),
  ]);
  if (!meta || typeof meta !== "object" || !meta.datasets || !meta.defaults) {
    throw new Error("web-backend variables payload is missing required datasets/defaults sections");
  }
  const varMetaByDataset = {};
  const fullVarMetaByDataset = {};

  function getEl(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Element #${id} not found — try a hard refresh (Ctrl+Shift+R)`);
    return el;
  }

  const datasetSelect = getEl("datasetSelect");
  const datasetCitation = getEl("datasetCitation");
  const datasetCodebookWrap = getEl("datasetCodebookWrap");
  const datasetCodebookLink = getEl("datasetCodebookLink");
  const variableMetaBtn = getEl("variableMetaBtn");
  const variableMetaDialog = getEl("variableMetaDialog");
  const variableMetaTitle = getEl("variableMetaTitle");
  const variableMetaCloseBtn = getEl("variableMetaCloseBtn");
  const variableMetaContent = getEl("variableMetaContent");
  const variableSelect = getEl("variableSelect");
  const variantPicker = getEl("variantPicker");
  const variantPickerSummary = getEl("variantPickerSummary");
  const variantSelect = getEl("variantSelect");
  const yearSlider = getEl("yearSlider");
  const yearDisplay = getEl("yearDisplay");
  const yearDisplayHero = getEl("yearDisplayHero");
  const timelineSelectedMarker = getEl("timelineSelectedMarker");
  const yearPlayBtn = getEl("yearPlayBtn");
  const speedDownBtn = getEl("speedDownBtn");
  const speedUpBtn = getEl("speedUpBtn");
  const speedDisplay = getEl("speedDisplay");
  const timelineScale = getEl("timelineScale");
  const timelineWrap = getEl("timelineWrap");
  const loadingIndicator = getEl("loading-indicator");
  const AUTO_PLAY_MIN_SPEED = 1;
  const AUTO_PLAY_MAX_SPEED = 4;
  let markerDragPointerId = null;

  function debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  const VARIANT_SUFFIXES = new Set(["codelow", "codehigh", "sd", "mean", "nr", "ord", "osp"]);
  const POLARITY_POSITIVE = "positive";
  const POLARITY_NEGATIVE = "negative";
  const POLARITY_VALUES = new Set([POLARITY_POSITIVE, POLARITY_NEGATIVE]);
  const POLARITY_CONFIG = {
    defaultPolarity:
      polarityMeta?.defaults?.polarity && POLARITY_VALUES.has(polarityMeta.defaults.polarity)
        ? polarityMeta.defaults.polarity
        : POLARITY_NEGATIVE,
    datasetDefaults:
      polarityMeta?.dataset_defaults && typeof polarityMeta.dataset_defaults === "object"
        ? polarityMeta.dataset_defaults
        : {},
    variableOverrides:
      polarityMeta?.variable_overrides && typeof polarityMeta.variable_overrides === "object"
        ? polarityMeta.variable_overrides
        : {},
    rules: Array.isArray(polarityMeta?.rules)
      ? polarityMeta.rules
          .map((rule) => {
            const compiled = { ...rule };
            if (typeof rule.match === "string" && rule.match.length > 0) {
              try {
                compiled._regex = new RegExp(rule.match);
              } catch (_) {
                compiled._regex = null;
              }
            } else {
              compiled._regex = null;
            }
            return compiled;
          })
          .filter((rule) => rule._regex && POLARITY_VALUES.has(rule.polarity))
      : [],
  };
  const polarityByMajorCache = new Map();

  function stripVariantSuffixChain(variable) {
    let base = variable;
    while (true) {
      const splitIdx = base.lastIndexOf("_");
      if (splitIdx <= 0) return base;
      const suffix = base.slice(splitIdx + 1);
      if (!VARIANT_SUFFIXES.has(suffix)) return base;
      base = base.slice(0, splitIdx);
    }
  }

  function buildVariableHierarchy(variables, defaultVariable) {
    const variableSet = new Set(variables);
    const mainVariables = [];
    const mainSeen = new Set();

    for (const variable of variables) {
      const candidateBase = stripVariantSuffixChain(variable);
      const main = candidateBase !== variable && variableSet.has(candidateBase) ? candidateBase : variable;
      if (!mainSeen.has(main)) {
        mainSeen.add(main);
        mainVariables.push(main);
      }
    }

    const variantsByMain = {};
    for (const main of mainVariables) {
      variantsByMain[main] = [];
    }

    for (const variable of variables) {
      const candidateBase = stripVariantSuffixChain(variable);
      if (candidateBase !== variable && variableSet.has(candidateBase)) {
        variantsByMain[candidateBase].push(variable);
      }
    }

    const defaultMainCandidate = stripVariantSuffixChain(defaultVariable || "");
    const defaultMain =
      defaultVariable && variableSet.has(defaultVariable) && defaultMainCandidate !== defaultVariable && variableSet.has(defaultMainCandidate)
        ? defaultMainCandidate
        : defaultVariable;

    return {
      mainVariables,
      mainVariableSet: new Set(mainVariables),
      variantsByMain,
      defaultMain,
    };
  }

  const datasetHierarchies = {};
  for (const [datasetKey, ds] of Object.entries(meta.datasets)) {
    datasetHierarchies[datasetKey] = buildVariableHierarchy(ds.variables || [], ds.defaultVariable);
  }

  const state = {
    dataset: meta.defaults.dataset,
    variable: meta.defaults.variable,
    mainVariable: null,
    year: meta.defaults.year,
    isAutoPlaying: false,
    autoPlaySpeed: 1,
    autoPlayTimer: null,
  };

  for (const [key, ds] of Object.entries(meta.datasets)) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = `${ds.label} (${key})`;
    datasetSelect.appendChild(opt);
  }

  datasetSelect.value = state.dataset;

  async function ensureDatasetMetadata(datasetKey) {
    if (varMetaByDataset[datasetKey]) return;
    try {
      const payload = await fetchBackendJson(
        `/api/config/variable-metadata/${encodeURIComponent(datasetKey)}`,
        `Could not load variable metadata for dataset ${datasetKey}`,
      );
      if (payload && typeof payload === "object") {
        varMetaByDataset[datasetKey] = {
          citation: typeof payload.citation === "string" ? payload.citation : null,
          variables: payload.variables && typeof payload.variables === "object" ? payload.variables : {},
        };
      } else {
        varMetaByDataset[datasetKey] = { citation: null, variables: {} };
      }
    } catch (error) {
      console.warn(error);
      varMetaByDataset[datasetKey] = { citation: null, variables: {} };
    }
  }

  async function ensureVariableFullMetadata(datasetKey, variableKey) {
    fullVarMetaByDataset[datasetKey] ||= {};
    if (Object.prototype.hasOwnProperty.call(fullVarMetaByDataset[datasetKey], variableKey)) {
      return fullVarMetaByDataset[datasetKey][variableKey];
    }
    try {
      const payload = await fetchBackendJson(
        `/api/config/variable-metadata/${encodeURIComponent(datasetKey)}/${encodeURIComponent(variableKey)}`,
        `Could not load full metadata for ${datasetKey}.${variableKey}`,
      );
      fullVarMetaByDataset[datasetKey][variableKey] = payload && typeof payload === "object" ? payload : null;
    } catch (error) {
      console.warn(error);
      fullVarMetaByDataset[datasetKey][variableKey] = null;
    }
    return fullVarMetaByDataset[datasetKey][variableKey];
  }

  function getVariableTitle(datasetKey, variableKey) {
    const variableTitle = varMetaByDataset[datasetKey]?.variables?.[variableKey];
    if (typeof variableTitle === "string" && variableTitle.trim().length > 0) return variableTitle;
    return variableKey;
  }

  function hasVariableMetadataSummary(datasetKey, variableKey) {
    return Object.prototype.hasOwnProperty.call(varMetaByDataset[datasetKey]?.variables || {}, variableKey);
  }

  function getCachedFullVariableMetadata(datasetKey, variableKey) {
    const datasetCache = fullVarMetaByDataset[datasetKey];
    if (!datasetCache || !Object.prototype.hasOwnProperty.call(datasetCache, variableKey)) {
      return undefined;
    }
    return datasetCache[variableKey];
  }

  function resolveConfiguredPolarity(datasetKey, majorVariable) {
    const datasetOverrides = POLARITY_CONFIG.variableOverrides?.[datasetKey];
    const overridePolarity = datasetOverrides?.[majorVariable];
    if (POLARITY_VALUES.has(overridePolarity)) {
      return overridePolarity;
    }

    const matchingRule = POLARITY_CONFIG.rules.find((rule) => {
      const datasetMatch = !rule.dataset || rule.dataset === datasetKey;
      return datasetMatch && rule._regex && rule._regex.test(majorVariable);
    });
    if (matchingRule && POLARITY_VALUES.has(matchingRule.polarity)) {
      return matchingRule.polarity;
    }

    const datasetDefault = POLARITY_CONFIG.datasetDefaults?.[datasetKey];
    if (POLARITY_VALUES.has(datasetDefault)) {
      return datasetDefault;
    }

    return POLARITY_CONFIG.defaultPolarity;
  }

  function resolvePolarityForMajorVariable(datasetKey, majorVariable) {
    const cacheKey = `${datasetKey}:${majorVariable}`;
    if (polarityByMajorCache.has(cacheKey)) {
      return polarityByMajorCache.get(cacheKey);
    }
    const polarity = resolveConfiguredPolarity(datasetKey, majorVariable);
    polarityByMajorCache.set(cacheKey, polarity);
    return polarity;
  }

  function getActiveMajorVariable() {
    if (state.mainVariable) return state.mainVariable;
    return stripVariantSuffixChain(state.variable || "");
  }

  function getActivePolarity() {
    return resolvePolarityForMajorVariable(state.dataset, getActiveMajorVariable());
  }

  function appendVariableMetaItem(container, label, value) {
    if (typeof value !== "string" || value.trim().length === 0) return;
    const item = document.createElement("div");
    item.className = "variable-meta-item";
    const title = document.createElement("p");
    title.className = "variable-meta-label";
    title.textContent = label;
    const body = document.createElement("p");
    body.className = "variable-meta-value";
    body.textContent = value.trim();
    item.appendChild(title);
    item.appendChild(body);
    container.appendChild(item);
  }

  function closeVariableMetadataDialog() {
    if (typeof variableMetaDialog.close === "function") {
      variableMetaDialog.close();
      return;
    }
    variableMetaDialog.removeAttribute("open");
  }

  function refreshVariableMetadataPanel() {
    variableMetaContent.innerHTML = "";
    const hasSummary = hasVariableMetadataSummary(state.dataset, state.variable);
    const title = getVariableTitle(state.dataset, state.variable);
    variableMetaTitle.textContent = `Variable information: ${title} (${state.variable})`;

    if (!hasSummary) {
      variableMetaBtn.disabled = true;
      if (variableMetaDialog.open || variableMetaDialog.hasAttribute("open")) {
        closeVariableMetadataDialog();
      }
      return;
    }

    const metaForVariable = getCachedFullVariableMetadata(state.dataset, state.variable);
    if (metaForVariable === null) {
      variableMetaBtn.disabled = true;
      if (variableMetaDialog.open || variableMetaDialog.hasAttribute("open")) {
        closeVariableMetadataDialog();
      }
      return;
    }

    if (metaForVariable === undefined) {
      variableMetaBtn.disabled = false;
      return;
    }

    appendVariableMetaItem(variableMetaContent, "Variable", `${title} (${state.variable})`);

    appendVariableMetaItem(variableMetaContent, "Description", metaForVariable.description);
    if (
      typeof metaForVariable.description_full === "string" &&
      metaForVariable.description_full.trim().length > 0 &&
      metaForVariable.description_full.trim() !== (metaForVariable.description || "").trim()
    ) {
      appendVariableMetaItem(variableMetaContent, "Full Description", metaForVariable.description_full);
    }
    appendVariableMetaItem(variableMetaContent, "Question", metaForVariable.question);
    appendVariableMetaItem(variableMetaContent, "Clarification", metaForVariable.clarification);
    appendVariableMetaItem(variableMetaContent, "Scale", metaForVariable.scale);
    appendVariableMetaItem(variableMetaContent, "Sources", metaForVariable.sources);
    appendVariableMetaItem(variableMetaContent, "Data Release", metaForVariable.data_release);
    appendVariableMetaItem(variableMetaContent, "Aggregation", metaForVariable.aggregation);
    appendVariableMetaItem(variableMetaContent, "Cross-Coder Aggregation", metaForVariable.cross_coder_aggregation);
    appendVariableMetaItem(variableMetaContent, "Country-Year Aggregation", metaForVariable.country_year_aggregation);
    appendVariableMetaItem(variableMetaContent, "Variable Citation", metaForVariable.variable_citation);
    appendVariableMetaItem(variableMetaContent, "Dataset Tag", metaForVariable.dataset_tag);
    appendVariableMetaItem(variableMetaContent, "Original Tag", metaForVariable.original_tag);
    appendVariableMetaItem(variableMetaContent, "Source Long Tag", metaForVariable.source_long_tag);
    appendVariableMetaItem(variableMetaContent, "Additional Versions", metaForVariable.additional_versions);
    appendVariableMetaItem(variableMetaContent, "Raw Codebook Block", metaForVariable.raw_block_text);

    const hasContent = variableMetaContent.children.length > 0;
    variableMetaBtn.disabled = !hasContent;
    if (!hasContent && (variableMetaDialog.open || variableMetaDialog.hasAttribute("open"))) {
      closeVariableMetadataDialog();
    }
  }

  function refreshCitation(datasetKey) {
    const citation = varMetaByDataset[datasetKey]?.citation;
    if (citation) {
      datasetCitation.textContent = `Dataset source: ${citation}`;
      datasetCitation.hidden = false;
    } else {
      datasetCitation.hidden = true;
    }
  }

  function refreshCodebookLink(datasetKey) {
    const codebookUrl = meta.datasets?.[datasetKey]?.codebook;
    if (typeof codebookUrl === "string" && codebookUrl.length > 0) {
      datasetCodebookLink.href = codebookUrl;
      datasetCodebookWrap.hidden = false;
    } else {
      datasetCodebookLink.removeAttribute("href");
      datasetCodebookWrap.hidden = true;
    }
  }

  function refreshVariantSelector(datasetKey, mainVariable, preferredVariable) {
    const hierarchy = datasetHierarchies[datasetKey];
    const variants = hierarchy?.variantsByMain?.[mainVariable] || [];

    variantSelect.innerHTML = "";

    const mainOpt = document.createElement("option");
    mainOpt.value = mainVariable;
    mainOpt.textContent = `${getVariableTitle(datasetKey, mainVariable)} (${mainVariable}) - Main`;
    variantSelect.appendChild(mainOpt);

    for (const variant of variants) {
      const opt = document.createElement("option");
      opt.value = variant;
      const title = getVariableTitle(datasetKey, variant);
      opt.textContent = title ? `${title} (${variant})` : variant;
      variantSelect.appendChild(opt);
    }

    if (variants.length === 0) {
      variantPicker.hidden = true;
      variantPicker.open = false;
      state.variable = mainVariable;
      variantSelect.value = mainVariable;
      return;
    }

    variantPicker.hidden = false;
    variantPickerSummary.textContent = `Variants (${variants.length})`;

    const canUsePreferred =
      !!preferredVariable && (preferredVariable === mainVariable || variants.includes(preferredVariable));
    const nextVariable = canUsePreferred ? preferredVariable : mainVariable;

    state.variable = nextVariable;
    variantSelect.value = nextVariable;
    variantPicker.open = nextVariable !== mainVariable;
  }

  function refreshVariables(datasetKey) {
    const ds = meta.datasets[datasetKey];
    const hierarchy = datasetHierarchies[datasetKey];
    variableSelect.innerHTML = "";
    for (const v of hierarchy.mainVariables) {
      const opt = document.createElement("option");
      opt.value = v;
      const title = getVariableTitle(datasetKey, v);
      opt.textContent = title ? `${title} (${v})` : v;
      variableSelect.appendChild(opt);
    }

    const preferredMain = hierarchy.mainVariableSet.has(hierarchy.defaultMain)
      ? hierarchy.defaultMain
      : hierarchy.mainVariables[0] || "";

    state.mainVariable = preferredMain;
    variableSelect.value = preferredMain;
    refreshVariantSelector(datasetKey, preferredMain, preferredMain);

    yearSlider.min = String(ds.yearMin);
    yearSlider.max = String(ds.yearMax);
    if (state.year < ds.yearMin || state.year > ds.yearMax) {
      state.year = Math.min(Math.max(state.year, ds.yearMin), ds.yearMax);
    }
    yearSlider.value = String(state.year);
    renderTimelineScale(ds.yearMin, ds.yearMax);
    refreshYearDisplay();
    if (state.isAutoPlaying && state.year >= ds.yearMax) {
      stopAutoPlay();
    }
  }

  function updateTimelineMarker() {
    const yearMin = Number.parseInt(yearSlider.min, 10);
    const yearMax = Number.parseInt(yearSlider.max, 10);
    const span = yearMax - yearMin;
    const pct = span > 0 ? ((state.year - yearMin) / span) * 100 : 0;
    timelineWrap.style.setProperty("--selected-pct", `${Math.max(0, Math.min(100, pct))}%`);
  }

  function highlightTimelineTick(year) {
    const ticks = timelineScale.querySelectorAll(".timeline-tick");
    let closestTick = null;
    let closestDelta = Number.POSITIVE_INFINITY;
    for (const tick of ticks) {
      const tickYear = Number.parseInt(tick.dataset.year || "", 10);
      if (Number.isNaN(tickYear)) continue;
      const delta = Math.abs(tickYear - year);
      if (delta < closestDelta) {
        closestDelta = delta;
        closestTick = tick;
      }
    }
    for (const tick of ticks) {
      tick.classList.toggle("is-selected", tick === closestTick);
    }
  }

  function refreshYearDisplay() {
    const yearText = String(state.year);
    yearDisplay.textContent = yearText;
    yearDisplayHero.textContent = yearText;
    updateTimelineMarker();
    highlightTimelineTick(state.year);
  }

  function buildTimelineTickYears(yearMin, yearMax) {
    if (yearMin >= yearMax) return [];
    const span = yearMax - yearMin;
    let minorStep, majorStep;
    if (span <= 20)       { minorStep = 2;  majorStep = 10; }
    else if (span <= 60)  { minorStep = 5;  majorStep = 10; }
    else if (span <= 150) { minorStep = 10; majorStep = 50; }
    else if (span <= 300) { minorStep = 25; majorStep = 50; }
    else                  { minorStep = 50; majorStep = 100; }
    const start = Math.ceil(yearMin / minorStep) * minorStep;
    const ticks = [];
    for (let y = start; y <= yearMax; y += minorStep) {
      if (y > yearMin && y < yearMax) {
        ticks.push({ year: y, major: y % majorStep === 0 });
      }
    }
    return ticks;
  }

  function renderTimelineScale(yearMin, yearMax) {
    timelineScale.innerHTML = "";
    const ticks = buildTimelineTickYears(yearMin, yearMax);
    const span = yearMax - yearMin;

    for (const { year, major } of ticks) {
      const tick = document.createElement("div");
      tick.className = "timeline-tick" + (major ? " is-major" : "");
      tick.dataset.year = String(year);
      const pct = span > 0 ? ((year - yearMin) / span) * 100 : 0;
      tick.style.left = `${pct}%`;

      const mark = document.createElement("span");
      mark.className = "timeline-tick-mark";
      tick.appendChild(mark);

      if (major) {
        const label = document.createElement("span");
        label.className = "timeline-tick-label";
        label.textContent = String(year);
        tick.appendChild(label);
      }

      timelineScale.appendChild(tick);
    }
    highlightTimelineTick(state.year);
  }

  await ensureDatasetMetadata(state.dataset);
  refreshVariables(state.dataset);
  refreshCitation(state.dataset);
  refreshCodebookLink(state.dataset);

  const osm = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
    maxZoom: 20,
    subdomains: "abcd",
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
  });

  const stamenTerrain = L.tileLayer(
    "https://tiles.stadiamaps.com/tiles/stamen_terrain_background/{z}/{x}/{y}{r}.png",
    {
      maxZoom: 18,
      attribution:
        "&copy; <a href=\"https://stadiamaps.com/\" target=\"_blank\" rel=\"noopener noreferrer\">Stadia Maps</a> " +
        "&copy; <a href=\"https://stamen.com/\" target=\"_blank\" rel=\"noopener noreferrer\">Stamen Design</a> " +
        "&copy; <a href=\"https://openmaptiles.org/\" target=\"_blank\" rel=\"noopener noreferrer\">OpenMapTiles</a> " +
        "&copy; OpenStreetMap contributors",
    },
  );

  const esriWorldImagery = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri",
    },
  );

  const map = L.map("map", {
    center: [20, 10],
    zoom: 2,
    minZoom: 1,
    maxZoom: 4,
    layers: [osm],
    maxBounds: [
      [-85, -180],
      [85, 180],
    ],
    maxBoundsViscosity: 1.0,
    worldCopyJump: false,
  });

  const demscoreHexPaneName = "demscoreHexPane";
  map.createPane(demscoreHexPaneName);
  const demscoreHexPane = map.getPane(demscoreHexPaneName);
  demscoreHexPane.style.zIndex = "350";
  demscoreHexPane.style.pointerEvents = "none";
  demscoreHexPane.classList.add("demscore-hex-pane");

  const hexLayerGroup = L.layerGroup([]).addTo(map);
  let activeWmsLayer = L.tileLayer.wms(mapServerBase, {
    layers: "hex_variable",
    styles: "",
    format: "image/png",
    transparent: true,
    version: "1.1.1",
    dataset: state.dataset,
    variable: state.variable,
    polarity: getActivePolarity(),
    year: String(state.year),
    hex_size: String(hexSizeFromZoom()),
    tileSize: 512,
    updateWhenIdle: true,
    updateInterval: 400,
    keepBuffer: 0,
    pane: demscoreHexPaneName,
    zIndex: 2,
    noWrap: true,
    bounds: L.latLngBounds(
      [-85, -180],
      [85, 180],
    ),
  });
  hexLayerGroup.addLayer(activeWmsLayer);
  let pendingWmsLayer = null;
  let loadingRevealTimer = null;

  function showLoadingIndicator() {
    if (loadingRevealTimer !== null) {
      window.clearTimeout(loadingRevealTimer);
    }
    loadingRevealTimer = window.setTimeout(() => {
      loadingRevealTimer = null;
      loadingIndicator.classList.add("is-loading");
    }, 500);
  }

  function hideLoadingIndicator() {
    if (loadingRevealTimer !== null) {
      window.clearTimeout(loadingRevealTimer);
      loadingRevealTimer = null;
    }
    loadingIndicator.classList.remove("is-loading");
  }

  const layerControl = L.control.layers(
    {
      "Stamen Terrain": stamenTerrain,
      "OpenStreetMap": osm,
      "Esri World Imagery": esriWorldImagery,
    },
    {
      "Demscore Hex Layer": hexLayerGroup,
    },
    { collapsed: false, position: "bottomleft" },
  );
  layerControl.addTo(map);

  // ---- Legend ---------------------------------------------------------------
  // Colors match the 7 CLASS definitions in mapserver.map (class_idx 1..7).
  // ntile(7) ORDER BY value → class 1 = lowest, class 7 = highest.
  const LEGEND_COLORS_NEGATIVE = [
    "#313695", // class 1 – lowest
    "#4575b4",
    "#74add1",
    "#abd9e9",
    "#fdae61",
    "#f46d43",
    "#d73027", // class 7 – highest
  ];

  const LEGEND_MEANING = {
    defaults: {
      title: "Quantile class (country-year)",
      low: "Lower value",
      high: "Higher value",
      note: "Colors show relative rank for the selected year.",
      direction: "low-to-high",
    },
    datasetDefaults: legendMeta?.dataset_defaults || {},
    rules: Array.isArray(legendMeta?.rules)
      ? legendMeta.rules
          .map((rule) => {
            const compiled = { ...rule };
            if (typeof rule.match === "string" && rule.match.length > 0) {
              try {
                compiled._regex = new RegExp(rule.match);
              } catch (_) {
                compiled._regex = null;
              }
            } else {
              compiled._regex = null;
            }
            return compiled;
          })
          .filter((rule) => rule._regex)
      : [],
  };

  if (legendMeta?.defaults && typeof legendMeta.defaults === "object") {
    LEGEND_MEANING.defaults = { ...LEGEND_MEANING.defaults, ...legendMeta.defaults };
  }

  function resolveLegendMeaning(dataset, variable) {
    const merged = {
      ...LEGEND_MEANING.defaults,
      ...(LEGEND_MEANING.datasetDefaults?.[dataset] || {}),
    };

    const matchingRule = LEGEND_MEANING.rules.find((rule) => {
      const datasetMatch = !rule.dataset || rule.dataset === dataset;
      return datasetMatch && rule._regex && rule._regex.test(variable);
    });

    return matchingRule ? { ...merged, ...matchingRule } : merged;
  }

  const legend = L.control({ position: "bottomright" });
  let legendTitleEl;
  let legendSubtitleEl;
  let legendBarEl;
  let legendLowEl;
  let legendHighEl;
  let legendNoteEl;

  legend.onAdd = function () {
    const div = L.DomUtil.create("div", "map-legend");
    div.innerHTML = `
      <div class="legend-title"></div>
      <div class="legend-subtitle"></div>
      <div class="legend-bar"></div>
      <div class="legend-labels"><span></span><span></span></div>
      <div class="legend-note"></div>`;
    legendTitleEl = div.querySelector(".legend-title");
    legendSubtitleEl = div.querySelector(".legend-subtitle");
    legendBarEl = div.querySelector(".legend-bar");
    legendLowEl = div.querySelector(".legend-labels span:first-child");
    legendHighEl = div.querySelector(".legend-labels span:last-child");
    legendNoteEl = div.querySelector(".legend-note");
    return div;
  };
  legend.addTo(map);

  function rectsOverlap(a, b, gap = 0) {
    return !(
      a.right + gap <= b.left ||
      a.left >= b.right + gap ||
      a.bottom + gap <= b.top ||
      a.top >= b.bottom + gap
    );
  }

  function rebalanceLegendPosition() {
    const legendEl = legend.getContainer();
    const layersEl = layerControl.getContainer();
    if (!legendEl || !layersEl) return;

    legendEl.style.marginBottom = "";

    const legendRect = legendEl.getBoundingClientRect();
    const layersRect = layersEl.getBoundingClientRect();
    const overlaps = rectsOverlap(legendRect, layersRect, 8);
    if (!overlaps) return;

    legendEl.style.marginBottom = `${Math.ceil(layersRect.height + 12)}px`;
  }

  function refreshLegend() {
    const text = resolveLegendMeaning(state.dataset, state.variable);
    const variableTitle = getVariableTitle(state.dataset, state.variable);
    const datasetLabel = meta.datasets[state.dataset]?.label || state.dataset;
    const polarity = getActivePolarity();
    const legendColors = polarity === POLARITY_POSITIVE
      ? LEGEND_COLORS_NEGATIVE.slice().reverse()
      : LEGEND_COLORS_NEGATIVE;
    if (legendTitleEl) legendTitleEl.textContent = text.title;
    if (legendSubtitleEl) {
      legendSubtitleEl.textContent = `${variableTitle} (${state.variable}) - ${datasetLabel}, ${state.year}`;
    }
    if (legendBarEl) {
      legendBarEl.innerHTML = legendColors
        .map((c) => `<span class="legend-swatch" style="background:${c}"></span>`)
        .join("");
    }
    if (legendLowEl) legendLowEl.textContent = text.low;
    if (legendHighEl) legendHighEl.textContent = text.high;
    if (legendNoteEl) {
      const directionHint = polarity === POLARITY_POSITIVE
        ? "Higher values are mapped to blue tones."
        : "Higher values are mapped to red tones.";
      legendNoteEl.textContent = `${text.note} ${directionHint}`;
    }
    window.requestAnimationFrame(rebalanceLegendPosition);
  }
  // ---------------------------------------------------------------------------

  function hexSizeFromZoom() {
    const zoom = map.getZoom();
    // Coarse steps reduce render-cost jumps between adjacent zoom levels.
    if (zoom <= 2) return 200000;
    if (zoom <= 3) return 200000;
    return 200000;
  }

  function loadNextLayer(onReady) {
    if (pendingWmsLayer) {
      pendingWmsLayer.off("load");
      hexLayerGroup.removeLayer(pendingWmsLayer);
      pendingWmsLayer = null;
      hideLoadingIndicator();
    }
    const nextLayer = L.tileLayer.wms(mapServerBase, {
      layers: "hex_variable",
      styles: "",
      format: "image/png",
      transparent: true,
      version: "1.1.1",
      dataset: state.dataset,
      variable: state.variable,
      polarity: getActivePolarity(),
      year: String(state.year),
      hex_size: String(hexSizeFromZoom()),
      tileSize: 512,
      updateWhenIdle: true,
      keepBuffer: 0,
      pane: demscoreHexPaneName,
      zIndex: 2,
      noWrap: true,
      bounds: L.latLngBounds([-85, -180], [85, 180]),
    });
    hexLayerGroup.addLayer(nextLayer);
    nextLayer.setOpacity(0);
    pendingWmsLayer = nextLayer;
    showLoadingIndicator();
    nextLayer.once("load", () => {
      if (pendingWmsLayer !== nextLayer) return;
      nextLayer.setOpacity(1);
      hexLayerGroup.removeLayer(activeWmsLayer);
      activeWmsLayer = nextLayer;
      pendingWmsLayer = null;
      hideLoadingIndicator();
      if (onReady) onReady();
    });
  }

  function updateWmsLayer() {
    refreshVariableMetadataPanel();
    refreshLegend();
    loadNextLayer();
  }

  function updateHexLayerForZoom() {
    const nextHexSize = String(hexSizeFromZoom());
    const activeHexSize = String(activeWmsLayer.wmsParams?.hex_size ?? "");
    if (activeHexSize === nextHexSize) return;

    // Re-parameterize in place so existing tiles stay visible while new ones load.
    activeWmsLayer.setParams({ hex_size: nextHexSize });
    if (pendingWmsLayer) {
      pendingWmsLayer.setParams({ hex_size: nextHexSize });
    }
  }

  function advanceAutoPlayLayer() {
    loadNextLayer(() => {
      if (state.isAutoPlaying) scheduleAutoPlayTick();
    });
  }

  function setYear(nextYear, immediate = false) {
    const ds = meta.datasets[state.dataset];
    const clamped = Math.min(Math.max(nextYear, ds.yearMin), ds.yearMax);
    if (clamped === state.year && !immediate) return false;
    state.year = clamped;
    yearSlider.value = String(state.year);
    refreshYearDisplay();
    if (immediate) {
      updateWmsLayer();
    } else {
      applyYear();
    }
    return true;
  }

  function scrubToYear(parsedYear, immediateFinal = false) {
    if (Number.isNaN(parsedYear)) return;
    if (state.isAutoPlaying) {
      // Keep autoplay active but jump its timeline anchor to the scrubbed year.
      if (pendingWmsLayer) {
        pendingWmsLayer.off("load");
        hexLayerGroup.removeLayer(pendingWmsLayer);
        pendingWmsLayer = null;
      }
      setYear(parsedYear, true);
      scheduleAutoPlayTick();
      return;
    }
    setYear(parsedYear, immediateFinal);
  }

  function yearFromClientX(clientX) {
    const rect = timelineWrap.getBoundingClientRect();
    if (rect.width <= 0) return state.year;
    const rawPct = (clientX - rect.left) / rect.width;
    const pct = Math.max(0, Math.min(1, rawPct));
    const yearMin = Number.parseInt(yearSlider.min, 10);
    const yearMax = Number.parseInt(yearSlider.max, 10);
    if (!Number.isFinite(yearMin) || !Number.isFinite(yearMax)) return state.year;
    const span = yearMax - yearMin;
    return span > 0 ? Math.round(yearMin + pct * span) : yearMin;
  }

  function startMarkerDrag(event) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    markerDragPointerId = event.pointerId;
    timelineSelectedMarker.classList.add("is-dragging");
    if (timelineSelectedMarker.setPointerCapture) {
      timelineSelectedMarker.setPointerCapture(event.pointerId);
    }
    scrubToYear(yearFromClientX(event.clientX), false);
  }

  function moveMarkerDrag(event) {
    if (markerDragPointerId === null || event.pointerId !== markerDragPointerId) return;
    event.preventDefault();
    scrubToYear(yearFromClientX(event.clientX), false);
  }

  function endMarkerDrag(event) {
    if (markerDragPointerId === null || event.pointerId !== markerDragPointerId) return;
    event.preventDefault();
    scrubToYear(yearFromClientX(event.clientX), true);
    if (timelineSelectedMarker.hasPointerCapture?.(event.pointerId)) {
      timelineSelectedMarker.releasePointerCapture(event.pointerId);
    }
    markerDragPointerId = null;
    timelineSelectedMarker.classList.remove("is-dragging");
  }

  function getAutoPlayStepMs() {
    const speed = Math.max(AUTO_PLAY_MIN_SPEED, Number(state.autoPlaySpeed) || AUTO_PLAY_MIN_SPEED);
    return Math.round(1000 / speed);
  }

  function setAutoPlaySpeed(nextSpeed) {
    const parsed = Number(nextSpeed);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(AUTO_PLAY_MAX_SPEED, Math.max(AUTO_PLAY_MIN_SPEED, Math.round(parsed)));
    if (clamped === state.autoPlaySpeed) return;
    state.autoPlaySpeed = clamped;
    speedDisplay.textContent = `${state.autoPlaySpeed}x`;
    if (state.isAutoPlaying) {
      scheduleAutoPlayTick();
    }
  }

  function clearAutoPlayTimer() {
    if (state.autoPlayTimer !== null) {
      window.clearTimeout(state.autoPlayTimer);
      state.autoPlayTimer = null;
    }
  }

  function updatePlayButton() {
    const iconName = state.isAutoPlaying ? "pause" : "play";
    const label = state.isAutoPlaying ? "Pause" : "Animate";
    yearPlayBtn.innerHTML = `<i data-lucide="${iconName}" aria-hidden="true"></i><span>${label}</span>`;
    if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.lucide.createIcons();
    }
    yearPlayBtn.setAttribute("aria-label", state.isAutoPlaying ? "Pause timeline" : "Play timeline");
  }

  function stopAutoPlay() {
    state.isAutoPlaying = false;
    clearAutoPlayTimer();
    updatePlayButton();
    L.DomUtil.removeClass(map.getContainer(), "autoplay-active");
    if (pendingWmsLayer) {
      pendingWmsLayer.off("load");
      hexLayerGroup.removeLayer(pendingWmsLayer);
      pendingWmsLayer = null;
    }
    hideLoadingIndicator();
  }

  function scheduleAutoPlayTick() {
    clearAutoPlayTimer();
    if (!state.isAutoPlaying) return;
    state.autoPlayTimer = window.setTimeout(() => {
      if (!state.isAutoPlaying) return;
      const ds = meta.datasets[state.dataset];
      if (state.year >= ds.yearMax) {
        stopAutoPlay();
        return;
      }
      state.year += 1;
      yearSlider.value = String(state.year);
      refreshYearDisplay();
      refreshLegend();
      advanceAutoPlayLayer();
      // next scheduleAutoPlayTick() is called from advanceAutoPlayLayer's load handler
    }, getAutoPlayStepMs());
  }

  function startAutoPlay() {
    const ds = meta.datasets[state.dataset];
    if (state.year >= ds.yearMax) {
      scrubToYear(ds.yearMin, false);
    }
    state.isAutoPlaying = true;
    updatePlayButton();
    L.DomUtil.addClass(map.getContainer(), "autoplay-active");
    scheduleAutoPlayTick();
  }

  datasetSelect.addEventListener("change", async () => {
    stopAutoPlay();
    state.dataset = datasetSelect.value;
    await ensureDatasetMetadata(state.dataset);
    refreshVariables(state.dataset);
    refreshCitation(state.dataset);
    refreshCodebookLink(state.dataset);
    updateWmsLayer();
  });

  variableSelect.addEventListener("change", () => {
    state.mainVariable = variableSelect.value;
    refreshVariantSelector(state.dataset, state.mainVariable, state.mainVariable);
    updateWmsLayer();
  });

  variantSelect.addEventListener("change", () => {
    state.variable = variantSelect.value;
    updateWmsLayer();
  });

  variableMetaBtn.addEventListener("click", async () => {
    if (variableMetaBtn.disabled) return;
    const currentDataset = state.dataset;
    const currentVariable = state.variable;

    variableMetaBtn.disabled = true;
    await ensureVariableFullMetadata(currentDataset, currentVariable);
    if (state.dataset !== currentDataset || state.variable !== currentVariable) {
      refreshVariableMetadataPanel();
      return;
    }
    refreshVariableMetadataPanel();
    if (variableMetaBtn.disabled) return;

    if (typeof variableMetaDialog.showModal === "function") {
      variableMetaDialog.showModal();
    } else {
      variableMetaDialog.setAttribute("open", "");
    }
  });

  variableMetaCloseBtn.addEventListener("click", () => {
    closeVariableMetadataDialog();
  });

  const applyYear = debounce(updateWmsLayer, 400);

  yearSlider.addEventListener("input", () => {
    const parsed = Number.parseInt(yearSlider.value, 10);
    scrubToYear(parsed, false);
  });

  yearPlayBtn.addEventListener("click", () => {
    if (state.isAutoPlaying) {
      stopAutoPlay();
    } else {
      startAutoPlay();
    }
  });

  timelineSelectedMarker.addEventListener("pointerdown", startMarkerDrag);
  timelineSelectedMarker.addEventListener("pointermove", moveMarkerDrag);
  timelineSelectedMarker.addEventListener("pointerup", endMarkerDrag);
  timelineSelectedMarker.addEventListener("pointercancel", endMarkerDrag);

  speedDownBtn.addEventListener("click", () => {
    setAutoPlaySpeed(state.autoPlaySpeed - 1);
  });

  speedUpBtn.addEventListener("click", () => {
    setAutoPlaySpeed(state.autoPlaySpeed + 1);
  });

  const zoomControl = L.control({ position: "bottomleft" });
  zoomControl.onAdd = function () {
    const div = L.DomUtil.create("div", "zoom-display");
    div.textContent = `Zoom: ${map.getZoom()}`;
    return div;
  };
  zoomControl.addTo(map);

  map.on("zoomend", () => {
    zoomControl.getContainer().textContent = `Zoom: ${map.getZoom()}`;
    updateHexLayerForZoom();
  });

  map.on("resize", rebalanceLegendPosition);
  window.addEventListener("resize", rebalanceLegendPosition);

  speedDisplay.textContent = `${state.autoPlaySpeed}x`;
  updatePlayButton();
  updateWmsLayer();
})().catch((err) => {
  const app = document.getElementById("app");
  app.innerHTML = `<pre style=\"padding:16px;color:#b91c1c\">${String(err)}</pre>`;
  console.error(err);
});

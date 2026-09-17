import { BaseController } from "../core/BaseController.js";
import { readVariableChoices, writeVariableChoices } from "../core/preferences.js";

const VARIANT_SUFFIXES = new Set(["codelow", "codehigh", "sd", "mean", "nr", "ord", "osp"]);
// Fallback names for V-Dem's version suffixes, worded as the metadata pipeline
// words them (scripts/load_variable_metadata.sh) so a row, the legend and the
// metadata dialog never call the same variant different things — minus the
// trailing "variant", which the menu's own context already supplies. The
// variant's own title is preferred over this map wherever the load produced one.
const VARIANT_SUFFIX_LABELS = {
  codelow: "Code low",
  codehigh: "Code high",
  sd: "Standard deviation",
  osp: "OSP",
  ord: "ORD",
  mean: "Mean",
  nr: "NR",
};
// Reading order for the menu: scale variants first, then bounds, then spread.
// The raw list is alphabetical, which puts "Code high" above "Code low".
const VARIANT_SUFFIX_ORDER = ["ord", "osp", "mean", "codelow", "codehigh", "sd", "nr"];
// The base variable is the one whose name does not say what it is, so it says it.
const VARIANT_MAIN_LABEL = "Main variant";
// The variable list is ordered by the label the reader sees, not by the order the
// config happens to list the keys in.
const VARIABLE_COLLATOR = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const DATASET_ACCENTS = ["#114b84", "#0f766e", "#9a3412", "#5b21b6", "#155e75", "#166534"];
const DATASET_IMAGE_DIR = "./assets/images";
const POLARITY_POSITIVE = "positive";
const POLARITY_NEGATIVE = "negative";
const POLARITY_NEUTRAL = "neutral";
const POLARITY_VALUES = new Set([POLARITY_POSITIVE, POLARITY_NEGATIVE, POLARITY_NEUTRAL]);
// Hover card: wait out a pointer that is only passing over the row, then park the
// card beside it with a small gap for the arrow.
const TOOLTIP_HOVER_DELAY_MS = 170;
const TOOLTIP_GAP_PX = 14;
const TOOLTIP_VIEWPORT_MARGIN_PX = 10;
const TOOLTIP_ARROW_INSET_PX = 18;
// Coverage strip geometry, in the SVG's own units: one unit per bucket across,
// and a short track down that CSS stretches to whatever height the row gives it.
const COVERAGE_TRACK_H = 10;
const COVERAGE_BAR_MIN_H = 2.5;
// Bars are slightly narrower than their bucket, so neighbours stay countable.
const COVERAGE_BAR_W = 0.78;
// Rows from different datasets sit next to each other in one list, so every
// strip is drawn against a single shared axis — two adjacent bars in the same
// place have to mean the same year. The axis is clipped at 1900 because V-Dem
// reaches back to 1789 while QoG starts in 1963: on a true 1789 axis every
// QoG and REPDEM strip would be squashed into the right third of the track for
// the sake of a handful of historical V-Dem series. Anything earlier is marked
// as continuing off the left edge rather than dropped silently.
const COVERAGE_AXIS_MIN_YEAR = 1900;
const VARIANT_MENU_GAP_PX = 4;
const VARIANT_MENU_MARGIN_PX = 10;
// Most V-Dem descriptions are the codebook's field block scraped verbatim
// ("VARIABLE TYPE: D PROJECT MANAGER(S): ... QUESTION: ..."), which reads as
// noise in a card. Those entries carry the same prose in `question`.
const CODEBOOK_FIELD_DUMP = /\b(?:VARIABLE TYPE|PROJECT MANAGER\(S\)|ADDITIONAL VERSIONS|QUESTION|CLARIFICATION):/;

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

function buildVariableHierarchy(variables) {
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

  return {
    mainVariables,
    mainVariableSet: new Set(mainVariables),
    variantsByMain,
  };
}

// Rows are identified by dataset *and* variable everywhere now, including the
// "is this row's menu already open" check.
function variantMenuKey(option) {
  return `${option.dataset.dataset}:${option.dataset.variable}`;
}

// The topics file is curated by hand and served straight through, so nothing
// upstream guarantees its shape. Anything malformed drops out here rather than
// throwing halfway through a render: an untopiced variable is still listed, it
// just answers to no chip.
function normalizeTopicsConfig(topicsMeta) {
  const topics = new Map();
  const rawTopics = topicsMeta?.topics;
  if (rawTopics && typeof rawTopics === "object") {
    for (const [id, entry] of Object.entries(rawTopics)) {
      const label = typeof entry?.label === "string" && entry.label.trim() ? entry.label.trim() : id;
      const description = typeof entry?.description === "string" ? entry.description.trim() : "";
      topics.set(id, { id, label, description });
    }
  }

  const order = [];
  const seen = new Set();
  for (const id of Array.isArray(topicsMeta?.order) ? topicsMeta.order : []) {
    if (topics.has(id) && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  // A topic defined but left out of `order` still belongs in the list; it goes
  // after the ordered ones rather than vanishing.
  for (const id of topics.keys()) {
    if (!seen.has(id)) order.push(id);
  }

  // `${dataset}:${mainVariable}` -> topic ids, first being the primary one.
  const byVariable = new Map();
  const rawAssignments = topicsMeta?.assignments;
  if (rawAssignments && typeof rawAssignments === "object") {
    for (const [datasetKey, variables] of Object.entries(rawAssignments)) {
      if (!variables || typeof variables !== "object") continue;
      for (const [variableKey, ids] of Object.entries(variables)) {
        const list = (Array.isArray(ids) ? ids : [ids]).filter((id) => topics.has(id));
        if (list.length > 0) byVariable.set(`${datasetKey}:${variableKey}`, list);
      }
    }
  }

  return { topics, order, byVariable };
}

export class MetadataController extends BaseController {
  constructor({ meta, polarityMeta, coverageMeta, topicsMeta, state, backendClient }) {
    super();
    this.meta = meta;
    this.state = state;
    this.backendClient = backendClient;
    this.coverageMeta =
      coverageMeta?.datasets && typeof coverageMeta.datasets === "object" ? coverageMeta.datasets : {};
    this.topicsConfig = normalizeTopicsConfig(topicsMeta);

    this.varMetaByDataset = {};
    this.fullVarMetaByDataset = {};
    this.datasetHierarchies = {};
    this.polarityByMajorCache = new Map();

    this.polarityConfig = {
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

    for (const [datasetKey, ds] of Object.entries(this.meta.datasets)) {
      this.datasetHierarchies[datasetKey] = buildVariableHierarchy(ds.variables || []);
    }

    this.datasetAccents = {};
    Object.keys(this.meta.datasets).forEach((datasetKey, index) => {
      const configured = this.meta.datasets[datasetKey]?.color;
      this.datasetAccents[datasetKey] =
        typeof configured === "string" && configured.trim()
          ? configured.trim()
          : DATASET_ACCENTS[index % DATASET_ACCENTS.length];
    });
    this.datasetTabButtons = new Map();
    this.topicChipButtons = new Map();
    // Both filter sets are additive and empty means "no filter", so the list
    // opens showing every variable rather than hiding most of them behind a
    // choice the reader has not made yet.
    this.activeTopics = new Set();
    this.activeDatasets = new Set();
    this.tooltipTimer = null;
    this.tooltipVariable = null;
    // Which variant each row is set to, so a row keeps its choice while the
    // reader browses other rows. Keyed `${dataset}:${mainVariable}`.
    this.variantByMain = new Map();
    // The whole list, every dataset's rows in title order, cached once every
    // dataset's titles are in. Filtering reads from it rather than rebuilding.
    this.allVariableRows = null;
    // The shared year axis the coverage strips are drawn against.
    this.coverageAxis = null;
    // Which variable each dataset was last left on, restored from the cookie.
    this.variableChoices = readVariableChoices();
    this.openVariantMenuFor = null;

    this.datasetSection = this.getEl("datasetSection");
    this.datasetTabs = this.getEl("datasetTabs");
    this.topicChips = this.getEl("topicChips");
    this.filterSummary = this.getEl("filterSummary");
    this.datasetPanel = this.getEl("datasetPanel");
    this.datasetCitation = this.getEl("datasetCitation");
    this.datasetCodebookWrap = this.getEl("datasetCodebookWrap");
    this.datasetCodebookLink = this.getEl("datasetCodebookLink");
    this.variableMetaBtn = this.getEl("variableMetaBtn");
    this.variableMetaDialog = this.getEl("variableMetaDialog");
    this.variableMetaTitle = this.getEl("variableMetaTitle");
    this.variableMetaCloseBtn = this.getEl("variableMetaCloseBtn");
    this.variableMetaContent = this.getEl("variableMetaContent");
    this.variableList = this.getEl("variableList");
    this.variableTooltip = this.getEl("variableTooltip");
    this.variableTooltipTitle = this.getEl("variableTooltipTitle");
    this.variableTooltipKey = this.getEl("variableTooltipKey");
    this.variableTooltipBody = this.getEl("variableTooltipBody");
    this.variantMenu = this.getEl("variantMenu");
    this.variantMenuTitle = this.getEl("variantMenuTitle");
    this.variantMenuItems = this.getEl("variantMenuItems");
  }

  async initialize() {
    this.renderDatasetChips();
    this.renderTopicChips();
    this.preloadDatasetImages();
    this.applyDatasetChrome(this.state.dataset);
    // One list now holds every dataset's rows, and a row is titled by its
    // dataset's metadata, so all of it has to be in before the first render —
    // not just the dataset the map happens to be showing.
    await Promise.all(Object.keys(this.meta.datasets).map((key) => this.ensureDatasetMetadata(key)));
    this.applyInitialSelection();
    this.refreshVariables();
    this.refreshCitation(this.state.dataset);
    this.refreshCodebookLink(this.state.dataset);
    this.refreshVariableMetadataPanel();
  }

  getDatasetTitle(ds, fallbackKey) {
    if (typeof ds?.title === "string" && ds.title.trim()) return ds.title.trim();
    if (typeof ds?.label === "string" && ds.label.trim()) return ds.label.trim();
    return fallbackKey;
  }

  // The short form ("V-Dem", not "Varieties of Democracy"). Chips share a row
  // and badges share a line with the variable title, so both need the name that
  // does not wrap; the full title rides along as the tooltip.
  getDatasetLabel(ds, fallbackKey) {
    if (typeof ds?.label === "string" && ds.label.trim()) return ds.label.trim();
    return this.getDatasetTitle(ds, fallbackKey);
  }

  getDatasetAccent(datasetKey) {
    return this.datasetAccents[datasetKey] || DATASET_ACCENTS[0];
  }

  getDatasetImageUrl(datasetKey) {
    const configured = this.meta.datasets[datasetKey]?.image;
    if (typeof configured === "string" && configured.trim()) return configured.trim();
    return `${DATASET_IMAGE_DIR}/${datasetKey.replace(/_/g, "-")}.jpg`;
  }

  preloadDatasetImages() {
    for (const datasetKey of Object.keys(this.meta.datasets)) {
      const image = new Image();
      image.src = this.getDatasetImageUrl(datasetKey);
    }
  }

  // Datasets are filters now, not tabs: the list spans all of them at once, so
  // there is no one panel a tab could own. They stay in dataset order and keep
  // their accent, which is also what the badge on each row is coloured with.
  renderDatasetChips() {
    this.datasetTabs.innerHTML = "";
    this.datasetTabButtons.clear();

    for (const [key, ds] of Object.entries(this.meta.datasets)) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip chip-dataset";
      chip.id = `datasetChip-${key}`;
      chip.dataset.dataset = key;
      chip.setAttribute("aria-pressed", "false");
      chip.title = `${this.getDatasetTitle(ds, key)} (${key})`;
      chip.style.setProperty("--ds-accent", this.getDatasetAccent(key));
      chip.textContent = this.getDatasetLabel(ds, key);
      this.datasetTabs.appendChild(chip);
      this.datasetTabButtons.set(key, chip);
    }
    this.syncFilterChipState();
  }

  renderTopicChips() {
    this.topicChips.innerHTML = "";
    this.topicChipButtons.clear();

    for (const id of this.topicsConfig.order) {
      const topic = this.topicsConfig.topics.get(id);
      if (!topic) continue;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip chip-topic";
      chip.dataset.topic = id;
      chip.setAttribute("aria-pressed", "false");
      if (topic.description) chip.title = topic.description;
      chip.textContent = topic.label;
      this.topicChips.appendChild(chip);
      this.topicChipButtons.set(id, chip);
    }
    // With no topics configured the row is dead weight, so it goes away rather
    // than sitting there empty above the list.
    this.topicChips.closest(".filter-row")?.toggleAttribute("hidden", this.topicChipButtons.size === 0);
    this.syncFilterChipState();
  }

  syncFilterChipState() {
    for (const [key, chip] of this.datasetTabButtons) {
      const on = this.activeDatasets.has(key);
      chip.classList.toggle("is-active", on);
      chip.setAttribute("aria-pressed", on ? "true" : "false");
    }
    for (const [id, chip] of this.topicChipButtons) {
      const on = this.activeTopics.has(id);
      chip.classList.toggle("is-active", on);
      chip.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  // The panel's accent, photo and citation follow the *selected* variable's
  // dataset now that no tab declares one.
  applyDatasetChrome(datasetKey) {
    const accent = this.getDatasetAccent(datasetKey);
    this.datasetSection.style.setProperty("--ds-accent", accent);
    this.datasetSection.style.setProperty("--ds-image", `url("${this.getDatasetImageUrl(datasetKey)}")`);
    this.datasetCitation.style.setProperty("--ds-accent", accent);
    this.datasetSection.dataset.dataset = datasetKey;
  }

  bindEvents({ onBeforeDatasetChange, onDatasetChange, onVariableChange }) {
    this.datasetTabs.addEventListener("click", (event) => {
      const chip = event.target.closest(".chip-dataset");
      if (!chip || !this.datasetTabs.contains(chip)) return;
      this.toggleFilter(this.activeDatasets, chip.dataset.dataset);
    });

    this.topicChips.addEventListener("click", (event) => {
      const chip = event.target.closest(".chip-topic");
      if (!chip || !this.topicChips.contains(chip)) return;
      this.toggleFilter(this.activeTopics, chip.dataset.topic);
    });

    this.variableList.addEventListener("change", (event) => {
      const input = event.target;
      if (!input || input.type !== "radio") return;
      const datasetKey = input.dataset.dataset;
      const mainVariable = input.dataset.variable;
      if (!datasetKey || !mainVariable) return;
      // Picking a row restores whichever version that row was last set to.
      void this.selectVariable(datasetKey, mainVariable, this.getSelectedVariant(datasetKey, mainVariable), {
        onBeforeDatasetChange,
        onVariableChange,
      });
    });

    this.bindVariantMenu({ onBeforeDatasetChange, onVariableChange });

    this.variableMetaBtn.addEventListener("click", async () => {
      if (this.variableMetaBtn.disabled) return;
      const currentDataset = this.state.dataset;
      const currentVariable = this.state.variable;

      this.variableMetaBtn.disabled = true;
      await this.ensureVariableFullMetadata(currentDataset, currentVariable);
      if (this.state.dataset !== currentDataset || this.state.variable !== currentVariable) {
        this.refreshVariableMetadataPanel();
        return;
      }

      this.refreshVariableMetadataPanel();
      if (this.variableMetaBtn.disabled) return;

      if (typeof this.variableMetaDialog.showModal === "function") {
        this.variableMetaDialog.showModal();
      } else {
        this.variableMetaDialog.setAttribute("open", "");
      }
    });

    this.variableMetaCloseBtn.addEventListener("click", () => {
      this.closeVariableMetadataDialog();
    });

    this.bindVariableTooltip();
  }

  async changeDataset(datasetKey, { onBeforeDatasetChange, onDatasetChange } = {}) {
    if (!datasetKey || datasetKey === this.state.dataset || !this.meta.datasets[datasetKey]) return;

    this.state.dataset = datasetKey;
    this.applyDatasetChrome(datasetKey);
    if (typeof onBeforeDatasetChange === "function") {
      onBeforeDatasetChange(datasetKey);
    }

    await this.ensureDatasetMetadata(datasetKey);
    if (this.state.dataset !== datasetKey) return;

    // The list is not rebuilt here any more: it spans every dataset, so the
    // dataset changing underneath it changes which row is selected, not which
    // rows exist.
    this.refreshCitation(datasetKey);
    this.refreshCodebookLink(datasetKey);
    this.refreshVariableMetadataPanel();
    if (typeof onDatasetChange === "function") {
      await onDatasetChange(datasetKey);
    }
  }

  // Startup arrives with a dataset and a variable key but no main/variant split:
  // the cookie may name a variant, the config default names a main, and either
  // may have been dropped from the config since. The list used to work this out
  // per dataset as it rendered; it spans every dataset now, so it is resolved
  // once, for the dataset the map opens on.
  applyInitialSelection() {
    const datasetKey = this.state.dataset;
    const hierarchy = this.datasetHierarchies[datasetKey];

    const remembered = this.getRememberedSelection(datasetKey);
    if (remembered) {
      this.variantByMain.set(this.variantMemoryKey(datasetKey, remembered.mainVariable), remembered.variable);
      this.state.mainVariable = remembered.mainVariable;
      this.state.variable = remembered.variable;
      return;
    }

    const configured = this.state.variable;
    let mainVariable = "";
    if (configured && hierarchy?.mainVariableSet.has(configured)) {
      mainVariable = configured;
    } else if (configured) {
      const base = stripVariantSuffixChain(configured);
      if (hierarchy?.variantsByMain?.[base]?.includes(configured)) {
        mainVariable = base;
        this.variantByMain.set(this.variantMemoryKey(datasetKey, base), configured);
      }
    }
    if (!mainVariable) {
      mainVariable = this.getAllVariableRows().find((row) => row.datasetKey === datasetKey)?.mainVariable || "";
    }

    this.state.mainVariable = mainVariable;
    this.state.variable = this.getSelectedVariant(datasetKey, mainVariable);
  }

  // A chip is a toggle, and several may be on at once: topics OR together, as do
  // datasets, and the two groups AND with each other.
  toggleFilter(set, value) {
    if (!value) return;
    if (set.has(value)) set.delete(value);
    else set.add(value);
    this.syncFilterChipState();
    this.refreshVariables();
  }

  clearFilters() {
    if (this.activeTopics.size === 0 && this.activeDatasets.size === 0) return;
    this.activeTopics.clear();
    this.activeDatasets.clear();
    this.syncFilterChipState();
    this.refreshVariables();
  }

  getDatasetConfig(datasetKey = this.state.dataset) {
    return this.meta.datasets[datasetKey];
  }

  getVariableCoverage(datasetKey = this.state.dataset, variableKey = this.state.variable) {
    const ds = this.getDatasetConfig(datasetKey);
    if (!ds) return null;

    const rawCoverage = ds.variableCoverage?.[variableKey];
    const rawYears = Array.isArray(rawCoverage?.availableYears) ? rawCoverage.availableYears : [];
    const availableYears = [...new Set(rawYears.map((year) => Number(year)).filter(Number.isInteger))].sort(
      (a, b) => a - b,
    );

    const fallbackYearMin = Number.isInteger(ds.yearMin) ? ds.yearMin : availableYears[0];
    const fallbackYearMax = Number.isInteger(ds.yearMax) ? ds.yearMax : availableYears[availableYears.length - 1];
    const yearMin = Number.isInteger(rawCoverage?.yearMin) ? rawCoverage.yearMin : fallbackYearMin;
    const yearMax = Number.isInteger(rawCoverage?.yearMax) ? rawCoverage.yearMax : fallbackYearMax;

    if (!Number.isInteger(yearMin) || !Number.isInteger(yearMax) || yearMin > yearMax) {
      return null;
    }

    const normalizedAvailableYears = availableYears.length > 0
      ? availableYears.filter((year) => year >= yearMin && year <= yearMax)
      : Array.from({ length: yearMax - yearMin + 1 }, (_value, index) => yearMin + index);

    return {
      yearMin,
      yearMax,
      availableYears: normalizedAvailableYears,
      countryCountsByYear:
        rawCoverage?.countryCountsByYear && typeof rawCoverage.countryCountsByYear === "object"
          ? rawCoverage.countryCountsByYear
          : {},
    };
  }

  getActiveVariableCoverage() {
    return this.getVariableCoverage(this.state.dataset, this.state.variable);
  }

  getVariableTitle(datasetKey, variableKey) {
    const variableTitle = this.varMetaByDataset[datasetKey]?.variables?.[variableKey];
    if (typeof variableTitle === "string" && variableTitle.trim().length > 0) return variableTitle;
    return variableKey;
  }

  getActivePolarity() {
    return this.resolvePolarityForVariable(this.state.dataset, this.state.variable || "");
  }

  async ensureDatasetMetadata(datasetKey) {
    if (this.varMetaByDataset[datasetKey]) return;
    try {
      const payload = await this.backendClient.fetchJson(
        `/api/config/variable-metadata/${encodeURIComponent(datasetKey)}`,
        `Could not load variable metadata for dataset ${datasetKey}`,
      );
      if (payload && typeof payload === "object") {
        this.varMetaByDataset[datasetKey] = {
          citation: typeof payload.citation === "string" ? payload.citation : null,
          variables: payload.variables && typeof payload.variables === "object" ? payload.variables : {},
        };
      } else {
        this.varMetaByDataset[datasetKey] = { citation: null, variables: {} };
      }
    } catch (error) {
      console.warn(error);
      this.varMetaByDataset[datasetKey] = { citation: null, variables: {} };
    }
  }

  async ensureVariableFullMetadata(datasetKey, variableKey) {
    this.fullVarMetaByDataset[datasetKey] ||= {};
    if (Object.prototype.hasOwnProperty.call(this.fullVarMetaByDataset[datasetKey], variableKey)) {
      return this.fullVarMetaByDataset[datasetKey][variableKey];
    }
    try {
      const payload = await this.backendClient.fetchJson(
        `/api/config/variable-metadata/${encodeURIComponent(datasetKey)}/${encodeURIComponent(variableKey)}`,
        `Could not load full metadata for ${datasetKey}.${variableKey}`,
      );
      this.fullVarMetaByDataset[datasetKey][variableKey] = payload && typeof payload === "object" ? payload : null;
    } catch (error) {
      console.warn(error);
      this.fullVarMetaByDataset[datasetKey][variableKey] = null;
    }
    return this.fullVarMetaByDataset[datasetKey][variableKey];
  }

  resolveConfiguredPolarity(datasetKey, variable) {
    const datasetOverrides = this.polarityConfig.variableOverrides?.[datasetKey];
    const overridePolarity = datasetOverrides?.[variable];
    if (POLARITY_VALUES.has(overridePolarity)) {
      return overridePolarity;
    }

    const matchingRule = this.polarityConfig.rules.find((rule) => {
      const datasetMatch = !rule.dataset || rule.dataset === datasetKey;
      return datasetMatch && rule._regex && rule._regex.test(variable);
    });
    if (matchingRule && POLARITY_VALUES.has(matchingRule.polarity)) {
      return matchingRule.polarity;
    }

    const datasetDefault = this.polarityConfig.datasetDefaults?.[datasetKey];
    if (POLARITY_VALUES.has(datasetDefault)) {
      return datasetDefault;
    }

    return this.polarityConfig.defaultPolarity;
  }

  resolvePolarityForVariable(datasetKey, variable) {
    const cacheKey = `${datasetKey}:${variable}`;
    if (this.polarityByMajorCache.has(cacheKey)) {
      return this.polarityByMajorCache.get(cacheKey);
    }
    const polarity = this.resolveConfiguredPolarity(datasetKey, variable);
    this.polarityByMajorCache.set(cacheKey, polarity);
    return polarity;
  }

  // A row is a split control: the label picks the variable, and — where the
  // variable has versions — a caret button opens the variant menu. The button
  // sits outside the label, or clicking it would also toggle the label's radio.
  buildVariableOption(datasetKey, variable) {
    const option = document.createElement("div");
    option.className = "variable-option";
    // Two datasets may name a variable the same thing, so every lookup that used
    // to key on the variable alone is now qualified by its dataset.
    option.dataset.variable = variable;
    option.dataset.dataset = datasetKey;

    const label = document.createElement("label");
    label.className = "variable-option-pick";

    const input = document.createElement("input");
    input.type = "radio";
    input.name = "variableList";
    input.value = `${datasetKey}:${variable}`;
    input.dataset.dataset = datasetKey;
    input.dataset.variable = variable;
    label.appendChild(input);

    const title = this.getVariableTitle(datasetKey, variable);
    // Title and badge share a line, so the badge needs a flex row of its own —
    // the label itself is a block that stacks title, version and strip.
    const titleRow = document.createElement("span");
    titleRow.className = "variable-option-title-row";

    const name = document.createElement("span");
    name.className = "variable-option-name";
    name.textContent = title;
    titleRow.appendChild(name);

    // Which dataset a row came from is the one thing the flat list took away
    // that the tabs used to say for free.
    const badge = document.createElement("span");
    badge.className = "variable-option-badge";
    badge.style.setProperty("--ds-accent", this.getDatasetAccent(datasetKey));
    badge.textContent = this.getDatasetLabel(this.meta.datasets[datasetKey], datasetKey);
    titleRow.appendChild(badge);

    label.appendChild(titleRow);

    const variants = this.getVariantsFor(datasetKey, variable);
    if (variants.length > 0) {
      // The second line reports which version this row is set to — the part that
      // actually varies — rather than echoing the variable key.
      const variantLabel = document.createElement("span");
      variantLabel.className = "variable-option-variant";
      label.appendChild(variantLabel);
    }

    // Last line: where this variable has data, on the axis its whole dataset
    // shares, so two rows can be compared by eye without reading any numbers.
    const coverage = document.createElement("span");
    coverage.className = "variable-option-coverage";
    label.appendChild(coverage);

    option.appendChild(label);

    if (variants.length > 0) {
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "variable-option-variants";
      trigger.tabIndex = -1;
      trigger.setAttribute("aria-haspopup", "true");
      trigger.setAttribute("aria-expanded", "false");
      trigger.setAttribute("aria-label", `Versions of ${title} (${variants.length + 1})`);
      trigger.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2 4.5 6 8.5 10 4.5" /></svg>';
      option.appendChild(trigger);
    }

    this.renderVariantLabel(datasetKey, option, variable);
    this.renderCoverageStrip(datasetKey, option, variable);
    return option;
  }

  getVariantsFor(datasetKey, mainVariable) {
    const variants = this.datasetHierarchies[datasetKey]?.variantsByMain?.[mainVariable] || [];
    return [...variants].sort((a, b) =>
      this.variantSortKey(mainVariable, a).localeCompare(this.variantSortKey(mainVariable, b)),
    );
  }

  variantSortKey(mainVariable, variable) {
    return variable
      .slice(mainVariable.length + 1)
      .split("_")
      .map((suffix) => {
        const rank = VARIANT_SUFFIX_ORDER.indexOf(suffix);
        return `${String(rank < 0 ? VARIANT_SUFFIX_ORDER.length : rank).padStart(2, "0")}${suffix}`;
      })
      .join("-");
  }

  // The remembered choice is a whole variable, variant included, and the config
  // it was saved against may have moved on since — so it only counts if the
  // dataset still has it.
  getRememberedSelection(datasetKey) {
    const variable = this.variableChoices[datasetKey];
    const hierarchy = this.datasetHierarchies[datasetKey];
    if (!variable || !hierarchy) return null;
    if (hierarchy.mainVariableSet.has(variable)) return { mainVariable: variable, variable };

    const mainVariable = stripVariantSuffixChain(variable);
    if (hierarchy.variantsByMain[mainVariable]?.includes(variable)) return { mainVariable, variable };
    return null;
  }

  rememberVariableChoice(datasetKey, variable) {
    if (!datasetKey || !variable || this.variableChoices[datasetKey] === variable) return;
    this.variableChoices[datasetKey] = variable;
    writeVariableChoices(this.variableChoices);
  }

  variantMemoryKey(datasetKey, mainVariable) {
    return `${datasetKey}:${mainVariable}`;
  }

  getSelectedVariant(datasetKey, mainVariable) {
    const remembered = this.variantByMain.get(this.variantMemoryKey(datasetKey, mainVariable));
    if (remembered === mainVariable) return mainVariable;
    return remembered && this.getVariantsFor(datasetKey, mainVariable).includes(remembered)
      ? remembered
      : mainVariable;
  }

  // "Main" for the base variable. For a variant, the metadata load already names
  // it — "Electoral Democracy Index (Code low)" — so take the parenthetical it
  // added to the base title and let the suffix map cover anything unnamed.
  getVariantLabel(datasetKey, mainVariable, variable) {
    if (variable === mainVariable) return VARIANT_MAIN_LABEL;

    const title = this.getVariableTitle(datasetKey, variable);
    const baseTitle = this.getVariableTitle(datasetKey, mainVariable);
    if (title !== variable && title.startsWith(baseTitle)) {
      const qualifier = /^\((.+)\)$/.exec(title.slice(baseTitle.length).trim());
      if (qualifier) return this.stripVariantWord(qualifier[1]);
    }

    return variable
      .slice(mainVariable.length + 1)
      .split("_")
      .map((suffix) => VARIANT_SUFFIX_LABELS[suffix] || suffix)
      .join(" + ");
  }

  // "ORD variant" -> "ORD": every entry in the menu is a variant, so only the
  // main entry gains from spelling it out.
  stripVariantWord(label) {
    const stripped = label.replace(/\s+variant$/i, "").trim();
    return stripped.length > 0 ? stripped : label;
  }

  renderVariantLabel(datasetKey, option, mainVariable) {
    const target = option.querySelector(".variable-option-variant");
    if (!target) return;
    const selected = this.getSelectedVariant(datasetKey, mainVariable);
    target.textContent = this.getVariantLabel(datasetKey, mainVariable, selected);
    option.classList.toggle("has-variant-selected", selected !== mainVariable);
  }

  // ---- Variable coverage strip ----
  // A sparkline of where a variable has data, drawn on the axis its dataset
  // shares. Bar height folds together how often the variable is sampled and how
  // many countries it reaches, both baked into scripts/build_variable_coverage.sh
  // — the list shows every row at once, so nothing here may hit the database.

  getCoverageStripData(datasetKey, variableKey) {
    const dataset = this.coverageMeta?.[datasetKey];
    const entry = dataset?.variables?.[variableKey];
    if (!dataset || !entry || typeof entry.levels !== "string" || entry.levels.length === 0) return null;
    return { dataset, entry };
  }

  // The axis every strip shares: 1900 (or the earliest year anything actually
  // has, if that is later) through the latest year any dataset reaches.
  getCoverageAxis() {
    if (this.coverageAxis) return this.coverageAxis;
    let min = Infinity;
    let max = -Infinity;
    for (const dataset of Object.values(this.coverageMeta)) {
      if (Number.isFinite(dataset?.yearMin)) min = Math.min(min, dataset.yearMin);
      if (Number.isFinite(dataset?.yearMax)) max = Math.max(max, dataset.yearMax);
    }
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
    this.coverageAxis = { yearMin: Math.max(min, COVERAGE_AXIS_MIN_YEAR), yearMax: max };
    return this.coverageAxis;
  }

  renderCoverageStrip(datasetKey, option, mainVariable) {
    const target = option.querySelector(".variable-option-coverage");
    if (!target) return;

    const variable = this.getSelectedVariant(datasetKey, mainVariable);
    const data = this.getCoverageStripData(datasetKey, variable);
    const axis = this.getCoverageAxis();
    if (!data || !axis) {
      // A variable the precompute never saw gets no strip rather than an empty
      // track, which would read as "this variable has no data anywhere".
      target.innerHTML = "";
      target.hidden = true;
      return;
    }

    const { dataset, entry } = data;
    target.hidden = false;
    target.innerHTML = this.buildCoverageStripSvg(entry.levels, dataset);
    // Data that starts before the axis does is still there; the strip just
    // cannot show it, so the row says so instead of implying a later start.
    target.classList.toggle("is-clipped", entry.yearMin < axis.yearMin);
    target.title =
      `Data ${entry.yearMin}\u2013${entry.yearMax}` +
      `, up to ${entry.maxCountries} countries` +
      ` (axis: ${axis.yearMin}\u2013${axis.yearMax}` +
      `${entry.yearMin < axis.yearMin ? `, continues before ${axis.yearMin}` : ""})`;
  }

  // One <svg> holding one <path>, for the row strip and the hover card alike:
  // a bar per element would put tens of thousands of nodes in a V-Dem list, and
  // the list is rebuilt from scratch on every dataset switch.
  buildCoverageStripSvg(levels, dataset, className = "variable-option-coverage-svg") {
    const axis = this.getCoverageAxis();
    const buckets = levels.length;
    if (!axis || buckets === 0) return "";

    // The bucket string is spaced across its own dataset's span, so the path is
    // emitted in years and the viewBox is the shared axis. That way one code
    // path puts a QoG strip and a V-Dem strip on the same scale without either
    // knowing about the other.
    const spanStart = Number.isFinite(dataset?.yearMin) ? dataset.yearMin : axis.yearMin;
    const spanEnd = Number.isFinite(dataset?.yearMax) ? dataset.yearMax : axis.yearMax;
    const bucketYears = (spanEnd - spanStart + 1) / buckets;
    const barYears = bucketYears * COVERAGE_BAR_W;

    const bars = [];
    for (let i = 0; i < buckets; i += 1) {
      const level = Number(levels[i]);
      if (!Number.isFinite(level) || level <= 0) continue;
      const x = spanStart + i * bucketYears;
      // Buckets entirely before the axis starts are dropped; the clipped marker
      // on the row is what reports them.
      if (x + barYears <= axis.yearMin) continue;
      // Level 1 is "present but thin". Sitting it at a quarter of the track
      // keeps a 32-country sample visibly above the baseline instead of merging
      // into it, while still ranking below a 165-country one.
      const height = COVERAGE_BAR_MIN_H + ((level - 1) / 8) * (COVERAGE_TRACK_H - COVERAGE_BAR_MIN_H);
      const y = (COVERAGE_TRACK_H - height).toFixed(2);
      const left = Math.max(x, axis.yearMin);
      const width = x + barYears - left;
      if (width <= 0) continue;
      bars.push(`M${left.toFixed(2)} ${y}h${width.toFixed(2)}v${height.toFixed(2)}h-${width.toFixed(2)}z`);
    }
    if (bars.length === 0) return "";
    const axisSpan = axis.yearMax - axis.yearMin + 1;
    return (
      `<svg class="${className}" viewBox="${axis.yearMin} 0 ${axisSpan} ${COVERAGE_TRACK_H}"` +
      ` preserveAspectRatio="none" aria-hidden="true" focusable="false">` +
      `<path d="${bars.join("")}" /></svg>`
    );
  }

  // ---- Variable hover card ----
  // The card is a body-level element positioned in viewport coordinates: the
  // sidebar and the variable list both scroll, and either would clip a card
  // parented inside them.
  bindVariableTooltip() {
    this.variableList.addEventListener("pointerover", (event) => {
      // Touch and pen taps select a row; only a hovering mouse gets the card.
      if (event.pointerType && event.pointerType !== "mouse") return;
      const option = event.target.closest(".variable-option");
      if (!option || !this.variableList.contains(option)) return;
      this.scheduleVariableTooltip(option);
    });

    this.variableList.addEventListener("pointerleave", () => this.hideVariableTooltip());
    this.variableList.addEventListener("focusin", (event) => {
      const option = event.target.closest(".variable-option");
      if (option) this.scheduleVariableTooltip(option);
    });
    this.variableList.addEventListener("focusout", () => this.hideVariableTooltip());

    // Any scrolling container moves the row out from under the card, so drop it.
    document.addEventListener("scroll", () => this.hideVariableTooltip(), true);
    window.addEventListener("resize", () => this.hideVariableTooltip());
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.hideVariableTooltip();
    });
  }

  scheduleVariableTooltip(option) {
    if (this.openVariantMenuFor) return;
    const variable = option.dataset.variable;
    // The hovered row names its own dataset. Reading the selected one here asked
    // the backend for, say, a REPDEM variable under v_dem and 404ed.
    const datasetKey = option.dataset.dataset;
    if (!variable || !datasetKey) return;
    const key = `${datasetKey}:${variable}`;
    if (key === this.tooltipVariable) return;
    this.hideVariableTooltip();
    this.tooltipVariable = key;
    this.tooltipTimer = window.setTimeout(() => {
      void this.showVariableTooltip(option, datasetKey, variable);
    }, TOOLTIP_HOVER_DELAY_MS);
  }

  hideVariableTooltip() {
    window.clearTimeout(this.tooltipTimer);
    this.tooltipTimer = null;
    this.tooltipVariable = null;
    this.variableTooltip.hidden = true;
  }

  async showVariableTooltip(option, datasetKey, variable) {
    const key = `${datasetKey}:${variable}`;
    let metaForVariable = this.getCachedFullVariableMetadata(datasetKey, variable);
    if (metaForVariable === undefined) {
      metaForVariable = await this.ensureVariableFullMetadata(datasetKey, variable);
      // The pointer may have moved on to another row while we fetched.
      if (this.tooltipVariable !== key) return;
    }
    if (!metaForVariable) return;

    const title = this.getVariableTitle(datasetKey, variable);
    const summary = this.getVariableSummary(metaForVariable, title);
    if (!summary.text) return;

    this.renderVariableTooltip(datasetKey, variable, metaForVariable, title, summary);
    this.variableTooltip.hidden = false;
    this.positionVariableTooltip(option);
  }

  getVariableSummary(metaForVariable, title) {
    for (const value of [metaForVariable.description, metaForVariable.description_full]) {
      if (typeof value !== "string" || value.trim().length === 0) continue;
      if (CODEBOOK_FIELD_DUMP.test(value)) continue;
      return { label: "", text: this.stripDescriptionTitlePrefix(value.trim(), title) };
    }
    const question = typeof metaForVariable.question === "string" ? metaForVariable.question.trim() : "";
    return question ? { label: "Question", text: question } : { label: "", text: "" };
  }

  // Codebook descriptions often open by restating the variable name ("Rule of Law
  // - The variable measures ..."), which the card already shows as its heading.
  stripDescriptionTitlePrefix(description, title) {
    if (!title || !description.toLowerCase().startsWith(title.toLowerCase())) return description;
    const rest = description.slice(title.length).replace(/^\s*[-–—:]\s*/, "");
    return rest.length > 0 && rest !== description.slice(title.length) ? rest : description;
  }

  renderVariableTooltip(datasetKey, variable, metaForVariable, title, summary) {
    this.variableTooltip.style.setProperty("--tip-accent", this.getDatasetAccent(datasetKey));
    this.variableTooltipTitle.textContent = title;
    this.variableTooltipKey.textContent = variable;
    // Untitled variables already show their key as the name, so skip the echo.
    this.variableTooltipKey.hidden = title === variable;

    this.variableTooltipBody.innerHTML = "";
    const paragraph = document.createElement("p");
    paragraph.className = "variable-tooltip-desc";
    if (summary.label) {
      const label = document.createElement("span");
      label.className = "variable-tooltip-item-label";
      label.textContent = summary.label;
      paragraph.appendChild(label);
    }
    paragraph.appendChild(document.createTextNode(summary.text));
    this.variableTooltipBody.appendChild(paragraph);

    this.appendVariableTooltipItem("Scale", metaForVariable.scale);
    this.appendVariableTooltipCoverage(datasetKey, variable);
  }

  // The same strip the row carries, but with room to say what it means: the row
  // has to be read at a glance, so the years it is plotted against and the reason
  // one bar is taller than the next can only be spelled out here.
  appendVariableTooltipCoverage(datasetKey, variable) {
    const data = this.getCoverageStripData(datasetKey, variable);
    const axisRange = this.getCoverageAxis();
    if (!data || !axisRange) return;
    const { dataset, entry } = data;

    const section = document.createElement("div");
    section.className = "variable-tooltip-coverage";

    const label = document.createElement("span");
    label.className = "variable-tooltip-item-label";
    label.textContent = "Coverage";
    section.appendChild(label);

    const track = document.createElement("span");
    track.className = "variable-tooltip-coverage-track";
    track.innerHTML = this.buildCoverageStripSvg(entry.levels, dataset, "variable-tooltip-coverage-svg");
    section.appendChild(track);

    // The endpoints belong to the shared axis, not the variable's own range —
    // they are what makes a strip that starts halfway along legible as "this one
    // starts in 1960", which is the whole point of sharing the axis.
    const axis = document.createElement("span");
    axis.className = "variable-tooltip-coverage-axis";
    for (const year of [axisRange.yearMin, axisRange.yearMax]) {
      const tick = document.createElement("span");
      tick.textContent = String(year);
      axis.appendChild(tick);
    }
    section.appendChild(axis);

    const note = document.createElement("p");
    note.className = "variable-tooltip-coverage-note";
    const range =
      entry.yearMin === entry.yearMax
        ? `${entry.yearMin} only`
        : `${entry.yearMin}–${entry.yearMax}`;
    const clipped =
      entry.yearMin < axisRange.yearMin
        ? ` The strip starts at ${axisRange.yearMin}, so earlier data is not drawn.`
        : "";
    note.textContent =
      `Data ${range}, up to ${entry.maxCountries} ${entry.maxCountries === 1 ? "country" : "countries"}. ` +
      `Bar height combines how many countries reported and how many of the years in that step carry data.` +
      clipped;
    section.appendChild(note);

    this.variableTooltipBody.appendChild(section);
  }

  appendVariableTooltipItem(label, value) {
    if (typeof value !== "string" || value.trim().length === 0) return;
    const item = document.createElement("p");
    item.className = "variable-tooltip-item";

    const name = document.createElement("span");
    name.className = "variable-tooltip-item-label";
    name.textContent = label;
    item.appendChild(name);
    item.appendChild(document.createTextNode(value.trim()));

    this.variableTooltipBody.appendChild(item);
  }

  positionVariableTooltip(option) {
    const anchor = option.getBoundingClientRect();
    const card = this.variableTooltip;
    card.classList.remove("is-left");

    const { offsetWidth: width, offsetHeight: height } = card;
    const spaceRight = window.innerWidth - anchor.right - TOOLTIP_GAP_PX - TOOLTIP_VIEWPORT_MARGIN_PX;
    const placeLeft = spaceRight < width && anchor.left - TOOLTIP_GAP_PX > width;
    card.classList.toggle("is-left", placeLeft);

    const left = placeLeft ? anchor.left - TOOLTIP_GAP_PX - width : anchor.right + TOOLTIP_GAP_PX;
    const maxLeft = window.innerWidth - width - TOOLTIP_VIEWPORT_MARGIN_PX;
    const anchorCenter = anchor.top + anchor.height / 2;
    const maxTop = window.innerHeight - height - TOOLTIP_VIEWPORT_MARGIN_PX;
    const top = Math.min(Math.max(anchorCenter - height / 2, TOOLTIP_VIEWPORT_MARGIN_PX), Math.max(maxTop, 0));

    card.style.left = `${Math.min(Math.max(left, TOOLTIP_VIEWPORT_MARGIN_PX), Math.max(maxLeft, 0))}px`;
    card.style.top = `${top}px`;
    // Keep the arrow on the hovered row even when the card is clamped to an edge.
    const arrowTop = Math.min(Math.max(anchorCenter - top, TOOLTIP_ARROW_INSET_PX), height - TOOLTIP_ARROW_INSET_PX);
    card.style.setProperty("--arrow-top", `${arrowTop}px`);
  }

  // Picking a row is now also how the dataset changes: the list spans all of
  // them, so the row carries which one it belongs to and the panel follows it.
  async selectVariable(datasetKey, mainVariable, variable, { onBeforeDatasetChange, onVariableChange } = {}) {
    const datasetChanged = datasetKey !== this.state.dataset;
    if (datasetChanged) {
      if (typeof onBeforeDatasetChange === "function") onBeforeDatasetChange(datasetKey);
      this.state.dataset = datasetKey;
      this.applyDatasetChrome(datasetKey);
      await this.ensureDatasetMetadata(datasetKey);
      if (this.state.dataset !== datasetKey) return;
      this.refreshCitation(datasetKey);
      this.refreshCodebookLink(datasetKey);
    }

    this.state.mainVariable = mainVariable;
    this.state.variable = variable;
    this.variantByMain.set(this.variantMemoryKey(datasetKey, mainVariable), variable);
    this.rememberVariableChoice(datasetKey, variable);
    this.markSelectedVariableOption(datasetKey, mainVariable);
    const option = this.variableList.querySelector(
      `.variable-option[data-dataset="${CSS.escape(datasetKey)}"][data-variable="${CSS.escape(mainVariable)}"]`,
    );
    if (option) {
      this.renderVariantLabel(datasetKey, option, mainVariable);
      // Versions can cover different years (a `_mean` that starts later than its
      // base), so the strip follows the row's version like the label does.
      this.renderCoverageStrip(datasetKey, option, mainVariable);
    }
    this.refreshVariableMetadataPanel();
    if (typeof onVariableChange === "function") {
      onVariableChange();
    }
  }

  // ---- Variant menu ----
  // Body-level like the hover card, for the same reason: the variable list and
  // the sidebar both scroll, and either would clip a menu parented inside them.
  bindVariantMenu(callbacks) {
    this.variableList.addEventListener("click", (event) => {
      const trigger = event.target.closest(".variable-option-variants");
      if (!trigger || !this.variableList.contains(trigger)) return;
      // The trigger lives beside the label, so this click is not a row pick.
      event.preventDefault();
      const option = trigger.closest(".variable-option");
      if (this.openVariantMenuFor === variantMenuKey(option)) {
        this.closeVariantMenu();
        return;
      }
      this.openVariantMenu(option, callbacks);
    });

    // Alt+Down / Right opens the menu from the focused row, as a split button does.
    this.variableList.addEventListener("keydown", (event) => {
      const option = event.target.closest(".variable-option");
      if (!option) return;
      const opensMenu = (event.altKey && event.key === "ArrowDown") || event.key === "ArrowRight";
      if (!opensMenu || !option.querySelector(".variable-option-variants")) return;
      event.preventDefault();
      this.openVariantMenu(option, callbacks);
    });

    this.variantMenu.addEventListener("keydown", (event) => {
      const items = [...this.variantMenu.querySelectorAll(".variant-menu-item")];
      const currentIndex = items.indexOf(document.activeElement);
      let nextIndex = null;
      if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % items.length;
      else if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + items.length) % items.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = items.length - 1;
      else if (event.key === "Escape" || event.key === "Tab") {
        this.closeVariantMenu({ restoreFocus: true });
        if (event.key === "Escape") event.preventDefault();
        return;
      }
      if (nextIndex === null) return;
      event.preventDefault();
      items[nextIndex]?.focus();
    });

    document.addEventListener("pointerdown", (event) => {
      if (!this.openVariantMenuFor) return;
      if (this.variantMenu.contains(event.target) || event.target.closest?.(".variable-option-variants")) return;
      this.closeVariantMenu();
    });

    // The menu tracks its row rather than closing on any scroll: opening it can
    // itself scroll the list (focus pulls the caret fully into view), and a menu
    // that vanished on its own opening scroll would never stay up. It closes
    // only once the row it belongs to has scrolled out of the list.
    document.addEventListener(
      "scroll",
      (event) => {
        if (!this.openVariantMenuFor) return;
        if (event.target === this.variantMenu || this.variantMenu.contains(event.target)) return;
        const option = this.variableList.querySelector(".variable-option.is-menu-open");
        if (!option) {
          this.closeVariantMenu();
          return;
        }
        const row = option.getBoundingClientRect();
        const list = this.variableList.getBoundingClientRect();
        if (row.bottom <= list.top || row.top >= list.bottom) {
          this.closeVariantMenu();
          return;
        }
        this.positionVariantMenu(option);
      },
      true,
    );
    window.addEventListener("resize", () => this.closeVariantMenu());
  }

  openVariantMenu(option, callbacks) {
    // The row says which dataset it belongs to; the map's current one may be a
    // different dataset entirely now that the list spans all of them.
    const datasetKey = option.dataset.dataset;
    const mainVariable = option.dataset.variable;
    const variants = this.getVariantsFor(datasetKey, mainVariable);
    if (variants.length === 0) return;

    // The card and the menu would otherwise sit on top of each other.
    this.hideVariableTooltip();
    this.closeVariantMenu();

    this.variantMenuTitle.textContent = this.getVariableTitle(datasetKey, mainVariable);
    this.variantMenuItems.innerHTML = "";
    const selected = this.getSelectedVariant(datasetKey, mainVariable);

    for (const variable of [mainVariable, ...variants]) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "variant-menu-item";
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-checked", variable === selected ? "true" : "false");
      item.dataset.variable = variable;

      const label = document.createElement("span");
      label.className = "variant-menu-item-label";
      label.textContent = this.getVariantLabel(datasetKey, mainVariable, variable);
      item.appendChild(label);

      const key = document.createElement("span");
      key.className = "variant-menu-item-key";
      key.textContent = variable;
      item.appendChild(key);

      item.addEventListener("click", () => {
        this.closeVariantMenu({ restoreFocus: true });
        void this.selectVariable(datasetKey, mainVariable, variable, callbacks);
      });
      this.variantMenuItems.appendChild(item);
    }

    this.openVariantMenuFor = variantMenuKey(option);
    option.classList.add("is-menu-open");
    option.querySelector(".variable-option-variants")?.setAttribute("aria-expanded", "true");
    this.variantMenu.hidden = false;
    this.positionVariantMenu(option);
    this.variantMenu.querySelector('.variant-menu-item[aria-checked="true"]')?.focus();
  }

  closeVariantMenu({ restoreFocus = false } = {}) {
    if (!this.openVariantMenuFor) return;
    const option = this.variableList.querySelector(".variable-option.is-menu-open");
    if (option) {
      option.classList.remove("is-menu-open");
      const trigger = option.querySelector(".variable-option-variants");
      trigger?.setAttribute("aria-expanded", "false");
      if (restoreFocus) trigger?.focus();
    }
    this.variantMenu.hidden = true;
    this.openVariantMenuFor = null;
  }

  positionVariantMenu(option) {
    const anchor = option.getBoundingClientRect();
    const menu = this.variantMenu;
    const { offsetWidth: width, offsetHeight: height } = menu;

    // Drops from the row like a split button's menu, flipping above it when the
    // row sits too low for the menu to fit below.
    const below = anchor.bottom + VARIANT_MENU_GAP_PX;
    const flipUp = below + height > window.innerHeight - VARIANT_MENU_MARGIN_PX && anchor.top - height > 0;
    const top = flipUp ? anchor.top - VARIANT_MENU_GAP_PX - height : below;
    const maxLeft = window.innerWidth - width - VARIANT_MENU_MARGIN_PX;
    const maxTop = window.innerHeight - height - VARIANT_MENU_MARGIN_PX;

    menu.classList.toggle("is-above", flipUp);
    menu.style.left = `${Math.min(Math.max(anchor.left, VARIANT_MENU_MARGIN_PX), Math.max(maxLeft, 0))}px`;
    menu.style.top = `${Math.min(Math.max(top, VARIANT_MENU_MARGIN_PX), Math.max(maxTop, 0))}px`;
  }

  markSelectedVariableOption(datasetKey, variable) {
    for (const option of this.variableList.querySelectorAll(".variable-option")) {
      const isSelected = option.dataset.variable === variable && option.dataset.dataset === datasetKey;
      option.classList.toggle("is-selected", isSelected);
      const input = option.querySelector("input");
      input.checked = isSelected;
      // Roving tabindex: one stop for the whole group, as radio groups behave.
      input.tabIndex = isSelected ? 0 : -1;
      // Only the selected row's caret joins the tab order, so tabbing through
      // the panel still costs one stop per control rather than one per row.
      const trigger = option.querySelector(".variable-option-variants");
      if (trigger) trigger.tabIndex = isSelected ? 0 : -1;
    }

    // A filter can hide the selected row, and a radiogroup whose every stop is
    // -1 cannot be tabbed into at all. The first visible row takes the stop in
    // that case, without becoming selected.
    if (!this.variableList.querySelector(".variable-option.is-selected")) {
      const first = this.variableList.querySelector(".variable-option input");
      if (first) first.tabIndex = 0;
    }
  }

  scrollSelectedVariableIntoView() {
    const selected = this.variableList.querySelector(".variable-option.is-selected");
    if (!selected) return;
    const listHeight = this.variableList.clientHeight;
    if (listHeight <= 0) return;
    const top = selected.offsetTop - this.variableList.offsetTop;
    if (top >= 0 && top + selected.offsetHeight <= listHeight) return;
    this.variableList.scrollTop = top - (listHeight - selected.offsetHeight) / 2;
  }

  refreshVariables() {
    this.hideVariableTooltip();
    this.closeVariantMenu();
    const rows = this.getFilteredRows();

    this.variableList.innerHTML = "";
    for (const row of rows) {
      this.variableList.appendChild(this.buildVariableOption(row.datasetKey, row.mainVariable));
    }

    // Filtering never changes what the map is showing — the selected variable
    // may simply not be on screen. Hiding it would otherwise silently disagree
    // with the legend and the map.
    this.renderFilterSummary(rows.length);
    this.markSelectedVariableOption(this.state.dataset, this.state.mainVariable);
    this.scrollSelectedVariableIntoView();
  }

  // Every dataset's main variables in one list, ordered by the title the reader
  // sees. Cached once every dataset's metadata is in, since until then the rows
  // would sort by key and have to be rebuilt anyway.
  getAllVariableRows() {
    if (this.allVariableRows) return this.allVariableRows;

    const rows = [];
    for (const datasetKey of Object.keys(this.meta.datasets)) {
      for (const mainVariable of this.datasetHierarchies[datasetKey]?.mainVariables || []) {
        rows.push({
          datasetKey,
          mainVariable,
          title: this.getVariableTitle(datasetKey, mainVariable),
          topics: this.getTopicsFor(datasetKey, mainVariable),
        });
      }
    }
    rows.sort(
      (a, b) =>
        VARIABLE_COLLATOR.compare(a.title, b.title) ||
        VARIABLE_COLLATOR.compare(a.mainVariable, b.mainVariable),
    );

    if (Object.keys(this.meta.datasets).every((key) => this.varMetaByDataset[key])) {
      this.allVariableRows = rows;
    }
    return rows;
  }

  getFilteredRows() {
    const rows = this.getAllVariableRows();
    if (this.activeTopics.size === 0 && this.activeDatasets.size === 0) return rows;
    return rows.filter((row) => {
      if (this.activeDatasets.size > 0 && !this.activeDatasets.has(row.datasetKey)) return false;
      if (this.activeTopics.size > 0 && !row.topics.some((id) => this.activeTopics.has(id))) return false;
      return true;
    });
  }

  getTopicsFor(datasetKey, mainVariable) {
    return this.topicsConfig.byVariable.get(`${datasetKey}:${mainVariable}`) || [];
  }

  renderFilterSummary(shownCount) {
    if (!this.filterSummary) return;
    const total = this.getAllVariableRows().length;
    const filtered = this.activeTopics.size > 0 || this.activeDatasets.size > 0;

    if (!filtered) {
      this.filterSummary.textContent = `${total} variables`;
      this.filterSummary.hidden = false;
      return;
    }
    if (shownCount === 0) {
      this.filterSummary.textContent = "No variables match these filters";
    } else {
      this.filterSummary.textContent = `${shownCount} of ${total} variables`;
    }
    this.filterSummary.hidden = false;
  }

  refreshCitation(datasetKey) {
    const citation = this.varMetaByDataset[datasetKey]?.citation;
    if (citation) {
      this.datasetCitation.textContent = `Dataset source: ${citation}`;
      this.datasetCitation.hidden = false;
    } else {
      this.datasetCitation.hidden = true;
    }
  }

  refreshCodebookLink(datasetKey) {
    const codebookUrl = this.meta.datasets?.[datasetKey]?.codebook;
    if (typeof codebookUrl === "string" && codebookUrl.length > 0) {
      this.datasetCodebookLink.href = codebookUrl;
      this.datasetCodebookWrap.hidden = false;
    } else {
      this.datasetCodebookLink.removeAttribute("href");
      this.datasetCodebookWrap.hidden = true;
    }
  }

  appendVariableMetaItem(container, label, value) {
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

  closeVariableMetadataDialog() {
    if (typeof this.variableMetaDialog.close === "function") {
      this.variableMetaDialog.close();
      return;
    }
    this.variableMetaDialog.removeAttribute("open");
  }

  hasVariableMetadataSummary(datasetKey, variableKey) {
    return Object.prototype.hasOwnProperty.call(this.varMetaByDataset[datasetKey]?.variables || {}, variableKey);
  }

  getCachedFullVariableMetadata(datasetKey, variableKey) {
    const datasetCache = this.fullVarMetaByDataset[datasetKey];
    if (!datasetCache || !Object.prototype.hasOwnProperty.call(datasetCache, variableKey)) {
      return undefined;
    }
    return datasetCache[variableKey];
  }

  refreshVariableMetadataPanel() {
    this.variableMetaContent.innerHTML = "";
    const hasSummary = this.hasVariableMetadataSummary(this.state.dataset, this.state.variable);
    const title = this.getVariableTitle(this.state.dataset, this.state.variable);
    this.variableMetaTitle.textContent = `Variable information: ${title} (${this.state.variable})`;

    if (!hasSummary) {
      this.variableMetaBtn.disabled = true;
      if (this.variableMetaDialog.open || this.variableMetaDialog.hasAttribute("open")) {
        this.closeVariableMetadataDialog();
      }
      return;
    }

    const metaForVariable = this.getCachedFullVariableMetadata(this.state.dataset, this.state.variable);
    if (metaForVariable === null) {
      this.variableMetaBtn.disabled = true;
      if (this.variableMetaDialog.open || this.variableMetaDialog.hasAttribute("open")) {
        this.closeVariableMetadataDialog();
      }
      return;
    }

    if (metaForVariable === undefined) {
      this.variableMetaBtn.disabled = false;
      return;
    }

    this.appendVariableMetaItem(this.variableMetaContent, "Variable", `${title} (${this.state.variable})`);
    this.appendVariableMetaItem(this.variableMetaContent, "Description", metaForVariable.description);
    if (
      typeof metaForVariable.description_full === "string" &&
      metaForVariable.description_full.trim().length > 0 &&
      metaForVariable.description_full.trim() !== (metaForVariable.description || "").trim()
    ) {
      this.appendVariableMetaItem(this.variableMetaContent, "Full Description", metaForVariable.description_full);
    }

    this.appendVariableMetaItem(this.variableMetaContent, "Question", metaForVariable.question);
    this.appendVariableMetaItem(this.variableMetaContent, "Clarification", metaForVariable.clarification);
    this.appendVariableMetaItem(this.variableMetaContent, "Scale", metaForVariable.scale);
    this.appendVariableMetaItem(this.variableMetaContent, "Sources", metaForVariable.sources);
    this.appendVariableMetaItem(this.variableMetaContent, "Data Release", metaForVariable.data_release);
    this.appendVariableMetaItem(this.variableMetaContent, "Aggregation", metaForVariable.aggregation);
    this.appendVariableMetaItem(
      this.variableMetaContent,
      "Cross-Coder Aggregation",
      metaForVariable.cross_coder_aggregation,
    );
    this.appendVariableMetaItem(
      this.variableMetaContent,
      "Country-Year Aggregation",
      metaForVariable.country_year_aggregation,
    );
    this.appendVariableMetaItem(this.variableMetaContent, "Variable Citation", metaForVariable.variable_citation);
    this.appendVariableMetaItem(this.variableMetaContent, "Dataset Tag", metaForVariable.dataset_tag);
    this.appendVariableMetaItem(this.variableMetaContent, "Original Tag", metaForVariable.original_tag);
    this.appendVariableMetaItem(this.variableMetaContent, "Source Long Tag", metaForVariable.source_long_tag);
    this.appendVariableMetaItem(this.variableMetaContent, "Additional Versions", metaForVariable.additional_versions);
    this.appendVariableMetaItem(this.variableMetaContent, "Raw Codebook Block", metaForVariable.raw_block_text);

    const hasContent = this.variableMetaContent.children.length > 0;
    this.variableMetaBtn.disabled = !hasContent;
    if (!hasContent && (this.variableMetaDialog.open || this.variableMetaDialog.hasAttribute("open"))) {
      this.closeVariableMetadataDialog();
    }
  }
}

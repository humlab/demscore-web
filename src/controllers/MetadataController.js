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
const POLARITY_VALUES = new Set([POLARITY_POSITIVE, POLARITY_NEGATIVE]);
// Hover card: wait out a pointer that is only passing over the row, then park the
// card beside it with a small gap for the arrow.
const TOOLTIP_HOVER_DELAY_MS = 170;
const TOOLTIP_GAP_PX = 14;
const TOOLTIP_VIEWPORT_MARGIN_PX = 10;
const TOOLTIP_ARROW_INSET_PX = 18;
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

export class MetadataController extends BaseController {
  constructor({ meta, polarityMeta, state, backendClient }) {
    super();
    this.meta = meta;
    this.state = state;
    this.backendClient = backendClient;

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
    this.tooltipTimer = null;
    this.tooltipVariable = null;
    // Which variant each row is set to, so a row keeps its choice while the
    // reader browses other rows. Keyed `${dataset}:${mainVariable}`.
    this.variantByMain = new Map();
    // Alphabetical main-variable order per dataset, cached once its titles are in.
    this.sortedMainVariables = new Map();
    // Which variable each dataset was last left on, restored from the cookie.
    this.variableChoices = readVariableChoices();
    this.openVariantMenuFor = null;

    this.datasetSection = this.getEl("datasetSection");
    this.datasetTabs = this.getEl("datasetTabs");
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
    this.renderDatasetTabs();
    this.preloadDatasetImages();
    this.selectDatasetTab(this.state.dataset);
    await this.ensureDatasetMetadata(this.state.dataset);
    this.refreshVariables(this.state.dataset);
    this.refreshCitation(this.state.dataset);
    this.refreshCodebookLink(this.state.dataset);
    this.refreshVariableMetadataPanel();
  }

  getDatasetTitle(ds, fallbackKey) {
    if (typeof ds?.title === "string" && ds.title.trim()) return ds.title.trim();
    if (typeof ds?.label === "string" && ds.label.trim()) return ds.label.trim();
    return fallbackKey;
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

  renderDatasetTabs() {
    this.datasetTabs.innerHTML = "";
    this.datasetTabButtons.clear();

    for (const [key, ds] of Object.entries(this.meta.datasets)) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "dataset-tab";
      tab.id = `datasetTab-${key}`;
      tab.dataset.dataset = key;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", "datasetPanel");
      tab.title = `${this.getDatasetTitle(ds, key)} (${key})`;
      tab.style.setProperty("--ds-accent", this.getDatasetAccent(key));
      tab.textContent = this.getDatasetTitle(ds, key);
      this.datasetTabs.appendChild(tab);
      this.datasetTabButtons.set(key, tab);
    }
  }

  selectDatasetTab(datasetKey) {
    for (const [key, tab] of this.datasetTabButtons) {
      const isActive = key === datasetKey;
      tab.classList.toggle("is-active", isActive);
      tab.setAttribute("aria-selected", isActive ? "true" : "false");
      tab.tabIndex = isActive ? 0 : -1;
    }

    const accent = this.getDatasetAccent(datasetKey);
    this.datasetSection.style.setProperty("--ds-accent", accent);
    this.datasetSection.style.setProperty("--ds-image", `url("${this.getDatasetImageUrl(datasetKey)}")`);
    this.datasetCitation.style.setProperty("--ds-accent", accent);
    this.datasetSection.dataset.dataset = datasetKey;
    this.datasetPanel.setAttribute("aria-labelledby", `datasetTab-${datasetKey}`);
  }

  bindEvents({ onBeforeDatasetChange, onDatasetChange, onVariableChange }) {
    this.datasetTabs.addEventListener("click", (event) => {
      const tab = event.target.closest(".dataset-tab");
      if (!tab || !this.datasetTabs.contains(tab)) return;
      void this.changeDataset(tab.dataset.dataset, { onBeforeDatasetChange, onDatasetChange });
    });

    this.datasetTabs.addEventListener("keydown", (event) => {
      const keys = [...this.datasetTabButtons.keys()];
      const currentIndex = keys.indexOf(this.state.dataset);
      if (currentIndex < 0) return;

      let nextIndex = null;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        nextIndex = (currentIndex + 1) % keys.length;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        nextIndex = (currentIndex - 1 + keys.length) % keys.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = keys.length - 1;
      }
      if (nextIndex === null) return;

      event.preventDefault();
      const nextKey = keys[nextIndex];
      this.datasetTabButtons.get(nextKey)?.focus();
      void this.changeDataset(nextKey, { onBeforeDatasetChange, onDatasetChange });
    });

    this.variableList.addEventListener("change", (event) => {
      const input = event.target;
      if (!input || input.type !== "radio") return;
      // Picking a row restores whichever version that row was last set to.
      this.selectVariable(input.value, this.getSelectedVariant(this.state.dataset, input.value), onVariableChange);
    });

    this.bindVariantMenu(onVariableChange);

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
    this.selectDatasetTab(datasetKey);
    if (typeof onBeforeDatasetChange === "function") {
      onBeforeDatasetChange(datasetKey);
    }

    await this.ensureDatasetMetadata(datasetKey);
    if (this.state.dataset !== datasetKey) return;

    this.refreshVariables(datasetKey);
    this.refreshCitation(datasetKey);
    this.refreshCodebookLink(datasetKey);
    this.refreshVariableMetadataPanel();
    if (typeof onDatasetChange === "function") {
      await onDatasetChange(datasetKey);
    }
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
    const majorVariable = this.state.mainVariable || stripVariantSuffixChain(this.state.variable || "");
    return this.resolvePolarityForMajorVariable(this.state.dataset, majorVariable);
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

  resolveConfiguredPolarity(datasetKey, majorVariable) {
    const datasetOverrides = this.polarityConfig.variableOverrides?.[datasetKey];
    const overridePolarity = datasetOverrides?.[majorVariable];
    if (POLARITY_VALUES.has(overridePolarity)) {
      return overridePolarity;
    }

    const matchingRule = this.polarityConfig.rules.find((rule) => {
      const datasetMatch = !rule.dataset || rule.dataset === datasetKey;
      return datasetMatch && rule._regex && rule._regex.test(majorVariable);
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

  resolvePolarityForMajorVariable(datasetKey, majorVariable) {
    const cacheKey = `${datasetKey}:${majorVariable}`;
    if (this.polarityByMajorCache.has(cacheKey)) {
      return this.polarityByMajorCache.get(cacheKey);
    }
    const polarity = this.resolveConfiguredPolarity(datasetKey, majorVariable);
    this.polarityByMajorCache.set(cacheKey, polarity);
    return polarity;
  }

  // A row is a split control: the label picks the variable, and — where the
  // variable has versions — a caret button opens the variant menu. The button
  // sits outside the label, or clicking it would also toggle the label's radio.
  buildVariableOption(datasetKey, variable) {
    const option = document.createElement("div");
    option.className = "variable-option";
    option.dataset.variable = variable;

    const label = document.createElement("label");
    label.className = "variable-option-pick";

    const input = document.createElement("input");
    input.type = "radio";
    input.name = "variableList";
    input.value = variable;
    label.appendChild(input);

    const title = this.getVariableTitle(datasetKey, variable);
    const name = document.createElement("span");
    name.className = "variable-option-name";
    name.textContent = title;
    label.appendChild(name);

    const variants = this.getVariantsFor(datasetKey, variable);
    if (variants.length > 0) {
      // The second line reports which version this row is set to — the part that
      // actually varies — rather than echoing the variable key.
      const variantLabel = document.createElement("span");
      variantLabel.className = "variable-option-variant";
      label.appendChild(variantLabel);
    } else if (title !== variable && this.sharedTitles?.has(title)) {
      // Except where the title alone cannot identify the row: QoG and RepDem
      // carry the same indicator once per sample (qog_std_ts_* / qog_oecd_ts_*,
      // repdem_basic_* / repdem_wecee_*), so those rows still need their key.
      const key = document.createElement("span");
      key.className = "variable-option-key";
      key.textContent = variable;
      label.appendChild(key);
    }

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
    return option;
  }

  collectSharedTitles(datasetKey, mainVariables) {
    const counts = new Map();
    for (const variable of mainVariables) {
      const title = this.getVariableTitle(datasetKey, variable);
      counts.set(title, (counts.get(title) || 0) + 1);
    }
    return new Set([...counts].filter(([, count]) => count > 1).map(([title]) => title));
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

  // Titles arrive with the dataset's metadata, so the order is only cached once
  // that load has landed — until then a row is titled by its key.
  getSortedMainVariables(datasetKey) {
    const cached = this.sortedMainVariables.get(datasetKey);
    if (cached) return cached;

    const sorted = [...(this.datasetHierarchies[datasetKey]?.mainVariables || [])].sort(
      (a, b) =>
        VARIABLE_COLLATOR.compare(this.getVariableTitle(datasetKey, a), this.getVariableTitle(datasetKey, b)) ||
        VARIABLE_COLLATOR.compare(a, b),
    );
    if (this.varMetaByDataset[datasetKey]) {
      this.sortedMainVariables.set(datasetKey, sorted);
    }
    return sorted;
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
    if (!variable || variable === this.tooltipVariable) return;
    this.hideVariableTooltip();
    this.tooltipVariable = variable;
    this.tooltipTimer = window.setTimeout(() => {
      void this.showVariableTooltip(option, variable);
    }, TOOLTIP_HOVER_DELAY_MS);
  }

  hideVariableTooltip() {
    window.clearTimeout(this.tooltipTimer);
    this.tooltipTimer = null;
    this.tooltipVariable = null;
    this.variableTooltip.hidden = true;
  }

  async showVariableTooltip(option, variable) {
    const datasetKey = this.state.dataset;
    let metaForVariable = this.getCachedFullVariableMetadata(datasetKey, variable);
    if (metaForVariable === undefined) {
      metaForVariable = await this.ensureVariableFullMetadata(datasetKey, variable);
      // The pointer may have moved on, or the dataset changed, while we fetched.
      if (this.tooltipVariable !== variable || this.state.dataset !== datasetKey) return;
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

  selectVariable(mainVariable, variable, onVariableChange) {
    this.state.mainVariable = mainVariable;
    this.state.variable = variable;
    this.variantByMain.set(this.variantMemoryKey(this.state.dataset, mainVariable), variable);
    this.rememberVariableChoice(this.state.dataset, variable);
    this.markSelectedVariableOption(mainVariable);
    const option = this.variableList.querySelector(`.variable-option[data-variable="${CSS.escape(mainVariable)}"]`);
    if (option) this.renderVariantLabel(this.state.dataset, option, mainVariable);
    this.refreshVariableMetadataPanel();
    if (typeof onVariableChange === "function") {
      onVariableChange();
    }
  }

  // ---- Variant menu ----
  // Body-level like the hover card, for the same reason: the variable list and
  // the sidebar both scroll, and either would clip a menu parented inside them.
  bindVariantMenu(onVariableChange) {
    this.variableList.addEventListener("click", (event) => {
      const trigger = event.target.closest(".variable-option-variants");
      if (!trigger || !this.variableList.contains(trigger)) return;
      // The trigger lives beside the label, so this click is not a row pick.
      event.preventDefault();
      const option = trigger.closest(".variable-option");
      if (this.openVariantMenuFor === option.dataset.variable) {
        this.closeVariantMenu();
        return;
      }
      this.openVariantMenu(option, onVariableChange);
    });

    // Alt+Down / Right opens the menu from the focused row, as a split button does.
    this.variableList.addEventListener("keydown", (event) => {
      const option = event.target.closest(".variable-option");
      if (!option) return;
      const opensMenu = (event.altKey && event.key === "ArrowDown") || event.key === "ArrowRight";
      if (!opensMenu || !option.querySelector(".variable-option-variants")) return;
      event.preventDefault();
      this.openVariantMenu(option, onVariableChange);
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

  openVariantMenu(option, onVariableChange) {
    const datasetKey = this.state.dataset;
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
        this.selectVariable(mainVariable, variable, onVariableChange);
      });
      this.variantMenuItems.appendChild(item);
    }

    this.openVariantMenuFor = mainVariable;
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

  markSelectedVariableOption(variable) {
    for (const option of this.variableList.querySelectorAll(".variable-option")) {
      const isSelected = option.dataset.variable === variable;
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

  refreshVariables(datasetKey) {
    this.hideVariableTooltip();
    this.closeVariantMenu();
    const mainVariables = this.getSortedMainVariables(datasetKey);
    this.sharedTitles = this.collectSharedTitles(datasetKey, mainVariables);

    // A dataset the reader has already picked a variable in opens on that
    // variable again; one they have not opens on the first row of the list.
    const remembered = this.getRememberedSelection(datasetKey);
    const preferredMain = remembered ? remembered.mainVariable : mainVariables[0] || "";
    if (remembered) {
      this.variantByMain.set(this.variantMemoryKey(datasetKey, preferredMain), remembered.variable);
    }

    this.variableList.innerHTML = "";
    for (const v of mainVariables) {
      this.variableList.appendChild(this.buildVariableOption(datasetKey, v));
    }

    this.state.mainVariable = preferredMain;
    this.state.variable = this.getSelectedVariant(datasetKey, preferredMain);
    this.markSelectedVariableOption(preferredMain);
    this.scrollSelectedVariableIntoView();
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

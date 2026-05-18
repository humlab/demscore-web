import { BaseController } from "../core/BaseController.js";

const VARIANT_SUFFIXES = new Set(["codelow", "codehigh", "sd", "mean", "nr", "ord", "osp"]);
const POLARITY_POSITIVE = "positive";
const POLARITY_NEGATIVE = "negative";
const POLARITY_VALUES = new Set([POLARITY_POSITIVE, POLARITY_NEGATIVE]);

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
    defaultVariable &&
    variableSet.has(defaultVariable) &&
    defaultMainCandidate !== defaultVariable &&
    variableSet.has(defaultMainCandidate)
      ? defaultMainCandidate
      : defaultVariable;

  return {
    mainVariables,
    mainVariableSet: new Set(mainVariables),
    variantsByMain,
    defaultMain,
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
      this.datasetHierarchies[datasetKey] = buildVariableHierarchy(ds.variables || [], ds.defaultVariable);
    }

    this.datasetSelect = this.getEl("datasetSelect");
    this.datasetCitation = this.getEl("datasetCitation");
    this.datasetCodebookWrap = this.getEl("datasetCodebookWrap");
    this.datasetCodebookLink = this.getEl("datasetCodebookLink");
    this.variableMetaBtn = this.getEl("variableMetaBtn");
    this.variableMetaDialog = this.getEl("variableMetaDialog");
    this.variableMetaTitle = this.getEl("variableMetaTitle");
    this.variableMetaCloseBtn = this.getEl("variableMetaCloseBtn");
    this.variableMetaContent = this.getEl("variableMetaContent");
    this.variableSelect = this.getEl("variableSelect");
    this.variantPicker = this.getEl("variantPicker");
    this.variantPickerSummary = this.getEl("variantPickerSummary");
    this.variantSelect = this.getEl("variantSelect");
  }

  async initialize() {
    for (const [key, ds] of Object.entries(this.meta.datasets)) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = `${ds.label} (${key})`;
      this.datasetSelect.appendChild(opt);
    }

    this.datasetSelect.value = this.state.dataset;
    await this.ensureDatasetMetadata(this.state.dataset);
    this.refreshVariables(this.state.dataset);
    this.refreshCitation(this.state.dataset);
    this.refreshCodebookLink(this.state.dataset);
    this.refreshVariableMetadataPanel();
  }

  bindEvents({ onBeforeDatasetChange, onDatasetChange, onVariableChange }) {
    this.datasetSelect.addEventListener("change", async () => {
      this.state.dataset = this.datasetSelect.value;
      if (typeof onBeforeDatasetChange === "function") {
        onBeforeDatasetChange(this.state.dataset);
      }
      await this.ensureDatasetMetadata(this.state.dataset);
      this.refreshVariables(this.state.dataset);
      this.refreshCitation(this.state.dataset);
      this.refreshCodebookLink(this.state.dataset);
      this.refreshVariableMetadataPanel();
      if (typeof onDatasetChange === "function") {
        await onDatasetChange(this.state.dataset);
      }
    });

    this.variableSelect.addEventListener("change", () => {
      this.state.mainVariable = this.variableSelect.value;
      this.refreshVariantSelector(this.state.dataset, this.state.mainVariable, this.state.mainVariable);
      this.refreshVariableMetadataPanel();
      if (typeof onVariableChange === "function") {
        onVariableChange();
      }
    });

    this.variantSelect.addEventListener("change", () => {
      this.state.variable = this.variantSelect.value;
      this.refreshVariableMetadataPanel();
      if (typeof onVariableChange === "function") {
        onVariableChange();
      }
    });

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
  }

  getDatasetConfig(datasetKey = this.state.dataset) {
    return this.meta.datasets[datasetKey];
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

  refreshVariables(datasetKey) {
    const hierarchy = this.datasetHierarchies[datasetKey];
    this.variableSelect.innerHTML = "";

    for (const v of hierarchy.mainVariables) {
      const opt = document.createElement("option");
      opt.value = v;
      const title = this.getVariableTitle(datasetKey, v);
      opt.textContent = title ? `${title} (${v})` : v;
      this.variableSelect.appendChild(opt);
    }

    const preferredMain = hierarchy.mainVariableSet.has(hierarchy.defaultMain)
      ? hierarchy.defaultMain
      : hierarchy.mainVariables[0] || "";

    this.state.mainVariable = preferredMain;
    this.variableSelect.value = preferredMain;
    this.refreshVariantSelector(datasetKey, preferredMain, preferredMain);
  }

  refreshVariantSelector(datasetKey, mainVariable, preferredVariable) {
    const hierarchy = this.datasetHierarchies[datasetKey];
    const variants = hierarchy?.variantsByMain?.[mainVariable] || [];

    this.variantSelect.innerHTML = "";

    const mainOpt = document.createElement("option");
    mainOpt.value = mainVariable;
    mainOpt.textContent = `${this.getVariableTitle(datasetKey, mainVariable)} (${mainVariable}) - Main`;
    this.variantSelect.appendChild(mainOpt);

    for (const variant of variants) {
      const opt = document.createElement("option");
      opt.value = variant;
      const title = this.getVariableTitle(datasetKey, variant);
      opt.textContent = title ? `${title} (${variant})` : variant;
      this.variantSelect.appendChild(opt);
    }

    if (variants.length === 0) {
      this.variantPicker.hidden = true;
      this.variantPicker.open = false;
      this.state.variable = mainVariable;
      this.variantSelect.value = mainVariable;
      return;
    }

    this.variantPicker.hidden = false;
    this.variantPickerSummary.textContent = `Variants (${variants.length})`;

    const canUsePreferred =
      !!preferredVariable && (preferredVariable === mainVariable || variants.includes(preferredVariable));
    const nextVariable = canUsePreferred ? preferredVariable : mainVariable;

    this.state.variable = nextVariable;
    this.variantSelect.value = nextVariable;
    this.variantPicker.open = nextVariable !== mainVariable;
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

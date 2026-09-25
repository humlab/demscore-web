import { BaseController } from "../core/BaseController.js";
import { refreshIcons } from "../core/icons.js";
import { readVariableChoices, writeVariableChoices } from "../core/preferences.js";

// V-Dem publishes each indicator several times over — `_codelow`, `_sd`, `_osp`
// and so on. Only the base variable is offered, so these suffixes are used for
// one thing now: recognising a derived variable so it can be kept out of the
// list. The rows stay in the database and a direct WMS request still renders
// them.
const VARIANT_SUFFIXES = new Set(["codelow", "codehigh", "sd", "mean", "nr", "ord", "osp"]);
// The variable list is ordered by the label the reader sees, not by the order the
// config happens to list the keys in.
const VARIABLE_COLLATOR = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const DATASET_ACCENTS = ["#114b84", "#0f766e", "#9a3412", "#5b21b6", "#155e75", "#166534"];
// Darkest to lightest. `--ds-1` marks dataset tag and chip borders,
// `--ds-3` fills a selected chip, `--ds-4` tints an unselected one.
const DATASET_PALETTE_STEPS = 5;
// Ink for a fill painted in a dataset's own colour. The three configured
// palettes do not agree on one answer -- REPDEM's sand takes black and V-Dem's
// magenta takes white -- so it is decided per dataset from the colour's
// luminance rather than fixed in the stylesheet. 0.45 sits in the gap between
// REPDEM (0.65) and the two dark palettes (0.12-0.16).
const DATASET_INK_LIGHT = "#fff";
const DATASET_INK_DARK = "#1b1712";
const DATASET_INK_LUMINANCE_SPLIT = 0.45;

// WCAG relative luminance, for hex colours only: every palette we ship is hex,
// and anything else keeps the light ink it had before.
function hexLuminance(color) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(typeof color === "string" ? color.trim() : "");
  if (!match) return null;
  const digits = match[1].length === 3 ? [...match[1]].map((c) => c + c) : match[1].match(/../g);
  const [r, g, b] = digits.map((pair) => {
    const channel = parseInt(pair, 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function readableInkOn(color) {
  const luminance = hexLuminance(color);
  if (luminance === null) return DATASET_INK_LIGHT;
  return luminance > DATASET_INK_LUMINANCE_SPLIT ? DATASET_INK_DARK : DATASET_INK_LIGHT;
}
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

  return {
    mainVariables,
    mainVariableSet: new Set(mainVariables),
  };
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
  constructor({ meta, polarityMeta, coverageMeta, topicsMeta, selectionPreference, state, backendClient }) {
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
    this.datasetPalettes = {};
    this.datasetInks = {};
    Object.keys(this.meta.datasets).forEach((datasetKey, index) => {
      const ds = this.meta.datasets[datasetKey];
      const palette = Array.isArray(ds?.palette)
        ? ds.palette.filter((shade) => typeof shade === "string" && shade.trim()).map((shade) => shade.trim())
        : [];
      const configured = ds?.color;
      const accent =
        typeof configured === "string" && configured.trim()
          ? configured.trim()
          : palette[0] || DATASET_ACCENTS[index % DATASET_ACCENTS.length];
      this.datasetAccents[datasetKey] = accent;
      // `--ds-1` is the shade an active chip is filled with, so the ink is read
      // off that exact colour -- not off the accent, which a config may set to
      // something other than its palette's first shade.
      this.datasetInks[datasetKey] = readableInkOn(palette.length >= DATASET_PALETTE_STEPS ? palette[0] : accent);
      // Datasets are told apart by tinting their rows, so a dataset without a
      // palette still needs five usable shades: they are mixed from its accent,
      // which keeps a new dataset legible before anyone picks colours for it.
      this.datasetPalettes[datasetKey] =
        palette.length >= DATASET_PALETTE_STEPS
          ? palette.slice(0, DATASET_PALETTE_STEPS)
          : Array.from({ length: DATASET_PALETTE_STEPS }, (_, step) =>
              `color-mix(in srgb, ${accent} ${100 - step * 22}%, #fff)`,
            );
    });
    this.datasetTabButtons = new Map();
    this.topicChipButtons = new Map();
    // Both filter sets are additive and empty means "no filter", so the list
    // opens showing every variable rather than hiding most of them behind a
    // choice the reader has not made yet.
    this.activeTopics = new Set();
    this.activeDatasets = new Set();
    // The sidebar search box, lowercased. A third filter alongside the two chip
    // groups, ANDed with them the same way they AND with each other.
    this.variableQuery = "";
    this.tooltipTimer = null;
    this.tooltipVariable = null;
    // The whole list, every dataset's rows in title order, cached once every
    // dataset's titles are in. Filtering reads from it rather than rebuilding.
    this.allVariableRows = null;
    // Which variable each dataset was last left on, restored from the cookie.
    this.variableChoices = readVariableChoices();
    // The active dataset/variable/year restored for this page load. It gets
    // first claim over the older per-dataset variable cookie, but only for the
    // dataset it was saved with.
    this.selectionPreference = selectionPreference && typeof selectionPreference === "object"
      ? selectionPreference
      : null;

    this.datasetSection = this.getEl("datasetSection");
    this.datasetTabs = this.getEl("datasetTabs");
    this.topicChips = this.getEl("topicChips");
    this.filterSummary = this.getEl("filterSummary");
    this.datasetPanel = this.getEl("datasetPanel");
    this.variableSearch = this.getEl("variableSearch");
    this.variableList = this.getEl("variableList");
    this.mobileControls = this.getEl("mobileControls");
    this.mobileVariablePickerBtn = this.getEl("mobileVariablePickerBtn");
    this.mobileSelectedDataset = this.getEl("mobileSelectedDataset");
    this.mobileSelectedTitle = this.getEl("mobileSelectedTitle");
    this.mobileSelectedMeta = this.getEl("mobileSelectedMeta");
    this.mobileVariableInfoBtn = this.getEl("mobileVariableInfoBtn");
    this.mobileVariablePickerDialog = this.getEl("mobileVariablePickerDialog");
    this.mobileVariablePickerCloseBtn = this.getEl("mobileVariablePickerCloseBtn");
    this.mobileVariableSearch = this.getEl("mobileVariableSearch");
    this.mobileTopicChips = this.getEl("mobileTopicChips");
    this.mobileVariablePickerList = this.getEl("mobileVariablePickerList");
    this.variableTooltip = this.getEl("variableTooltip");
    this.variableTooltipTitle = this.getEl("variableTooltipTitle");
    this.variableTooltipKey = this.getEl("variableTooltipKey");
    this.variableTooltipDataset = this.getEl("variableTooltipDataset");
    this.variableTooltipBody = this.getEl("variableTooltipBody");
    this.variableTooltipCloseBtn = this.getEl("variableTooltipCloseBtn");
    this.tooltipHideTimer = null;
    this.tooltipPersistent = false;
    // Which button opened the persistent card, so its `aria-expanded` can be
    // put back and the focus returned to it when the card closes.
    this.tooltipTrigger = null;
    this.mobilePickerTopics = new Set();
    this.mobilePickerQuery = "";
  }

  async initialize() {
    this.renderDatasetChips();
    this.renderTopicChips();
    this.renderMobileTopicChips();
    this.applyDatasetChrome(this.state.dataset);
    // One list now holds every dataset's rows, and a row is titled by its
    // dataset's metadata, so all of it has to be in before the first render —
    // not just the dataset the map happens to be showing.
    await Promise.all(Object.keys(this.meta.datasets).map((key) => this.ensureDatasetMetadata(key)));
    this.applyInitialSelection();
    this.refreshVariables();
    this.refreshVariableMetadataPanel();
    this.refreshMobileSelectionSummary();
    this.refreshMobilePicker();
  }

  getDatasetTitle(ds, fallbackKey) {
    if (typeof ds?.title === "string" && ds.title.trim()) return ds.title.trim();
    if (typeof ds?.label === "string" && ds.label.trim()) return ds.label.trim();
    return fallbackKey;
  }

  // The short form ("V-Dem", not "Varieties of Democracy"). Chips share a row,
  // so they need the name that does not wrap; the full title rides along as the
  // tooltip.
  getDatasetLabel(ds, fallbackKey) {
    if (typeof ds?.label === "string" && ds.label.trim()) return ds.label.trim();
    return this.getDatasetTitle(ds, fallbackKey);
  }

  getDatasetAccent(datasetKey) {
    return this.datasetAccents[datasetKey] || DATASET_ACCENTS[0];
  }

  // Dataset colour now lives on the things that belong to one dataset — a row,
  // a chip, an info card — rather than on the whole panel, which is neutral.
  applyDatasetPalette(el, datasetKey) {
    const palette = this.datasetPalettes[datasetKey] || [];
    el.style.setProperty("--ds-accent", this.getDatasetAccent(datasetKey));
    el.style.setProperty("--ds-ink", this.datasetInks[datasetKey] || DATASET_INK_LIGHT);
    palette.forEach((shade, index) => el.style.setProperty(`--ds-${index + 1}`, shade));
  }

  // Datasets are filters now, not tabs: the list spans all of them at once, so
  // there is no one panel a tab could own. They stay in dataset order and keep
  // their accent, which is also what each row's dataset tag is coloured with.
  renderDatasetChips() {
    this.datasetTabs.innerHTML = "";
    this.datasetTabs.removeAttribute("aria-busy");
    this.datasetTabButtons.clear();

    for (const [key, ds] of Object.entries(this.meta.datasets)) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip chip-dataset";
      chip.id = `datasetChip-${key}`;
      chip.dataset.dataset = key;
      chip.setAttribute("aria-pressed", "false");
      chip.setAttribute("aria-label", `Filter by dataset: ${this.getDatasetTitle(ds, key)} (${key})`);
      this.applyDatasetPalette(chip, key);
      chip.textContent = this.getDatasetLabel(ds, key);
      this.datasetTabs.appendChild(chip);
      this.datasetTabButtons.set(key, chip);
    }
    this.syncFilterChipState();
  }

  renderTopicChips() {
    this.topicChips.innerHTML = "";
    this.topicChips.removeAttribute("aria-busy");
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

  renderMobileTopicChips() {
    this.mobileTopicChips.innerHTML = "";

    const allChip = document.createElement("button");
    allChip.type = "button";
    allChip.className = "mobile-topic-chip is-active";
    allChip.dataset.topic = "";
    allChip.setAttribute("aria-pressed", "true");
    allChip.textContent = "All";
    this.mobileTopicChips.appendChild(allChip);

    for (const id of this.topicsConfig.order) {
      const topic = this.topicsConfig.topics.get(id);
      if (!topic) continue;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "mobile-topic-chip";
      chip.dataset.topic = id;
      chip.setAttribute("aria-pressed", "false");
      if (topic.description) chip.title = topic.description;
      chip.textContent = topic.label;
      this.mobileTopicChips.appendChild(chip);
    }

    this.mobileTopicChips.hidden = this.topicsConfig.order.length === 0;
    this.syncMobileTopicChipState();
  }

  syncMobileTopicChipState() {
    const allActive = this.mobilePickerTopics.size === 0;
    for (const chip of this.mobileTopicChips.querySelectorAll(".mobile-topic-chip")) {
      const topic = chip.dataset.topic || "";
      const on = topic ? this.mobilePickerTopics.has(topic) : allActive;
      chip.classList.toggle("is-active", on);
      chip.setAttribute("aria-pressed", on ? "true" : "false");
    }
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

  // The panel itself is neutral: a dataset photo and scrim behind every control
  // claimed the whole sidebar for whichever dataset happened to be selected,
  // which is not what the colour means. Dataset colour now lives only on the
  // things that belong to one dataset — a row, a chip, an info card.
  applyDatasetChrome(datasetKey) {
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

    // Rebuilt on every keystroke, undebounced: the whole list is a few dozen
    // rows that are already in memory, and the same handler on the phone
    // picker has always worked this way.
    this.variableSearch.addEventListener("input", () => {
      this.setVariableQuery(this.variableSearch.value);
    });

    // Escape empties the field rather than leaving the list narrowed behind a
    // box the reader has stopped looking at. `type="search"` gives Chrome and
    // Safari a clear button that fires `input` on its own; Firefox has neither.
    this.variableSearch.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || this.variableSearch.value === "") return;
      event.stopPropagation();
      this.variableSearch.value = "";
      this.setVariableQuery("");
    });

    this.variableList.addEventListener("change", (event) => {
      const input = event.target;
      if (!input || input.type !== "radio") return;
      const datasetKey = input.dataset.dataset;
      const variable = input.dataset.variable;
      if (!datasetKey || !variable) return;
      void this.selectVariable(datasetKey, variable, { onBeforeDatasetChange, onVariableChange });
    });

    this.variableList.addEventListener("click", (event) => {
      const button = event.target.closest(".variable-option-info");
      if (!button || !this.variableList.contains(button)) return;
      event.preventDefault();
      event.stopPropagation();
      void this.openVariableInfoPopover(button.dataset.dataset, button.dataset.variable, {
        anchor: button,
        triggerButton: button,
      });
    });

    this.mobileVariableInfoBtn.addEventListener("click", () => {
      void this.openVariableInfoPopover(this.state.dataset, this.state.variable, {
        anchor: this.mobileVariableInfoBtn,
        triggerButton: this.mobileVariableInfoBtn,
      });
    });

    this.mobileVariablePickerBtn.addEventListener("click", () => {
      this.openDialog(this.mobileVariablePickerDialog);
      this.mobileVariablePickerBtn.setAttribute("aria-expanded", "true");
      this.refreshMobilePicker();
      window.setTimeout(() => this.mobileVariableSearch.focus(), 0);
    });

    this.mobileVariablePickerCloseBtn.addEventListener("click", () => {
      this.closeDialog(this.mobileVariablePickerDialog);
    });

    // One place for everything that shuts the dialog: the close button, Escape
    // (which `showModal` handles itself), and picking a variable. `<dialog>`
    // returns the focus to the opener on its own in current browsers, but not
    // in the `open` attribute fallback below it, and the opener's state has to
    // be put back either way.
    this.mobileVariablePickerDialog.addEventListener("close", () => {
      this.mobileVariablePickerBtn.setAttribute("aria-expanded", "false");
      this.mobileVariablePickerBtn.focus();
    });

    this.mobileVariableSearch.addEventListener("input", () => {
      this.mobilePickerQuery = this.mobileVariableSearch.value.trim().toLowerCase();
      this.refreshMobilePicker();
    });

    this.mobileTopicChips.addEventListener("click", (event) => {
      const chip = event.target.closest(".mobile-topic-chip");
      if (!chip || !this.mobileTopicChips.contains(chip)) return;
      const topic = chip.dataset.topic || "";
      if (!topic) {
        this.mobilePickerTopics.clear();
      } else if (this.mobilePickerTopics.has(topic)) {
        this.mobilePickerTopics.delete(topic);
      } else {
        this.mobilePickerTopics.add(topic);
      }
      this.syncMobileTopicChipState();
      this.refreshMobilePicker();
    });

    this.mobileVariablePickerList.addEventListener("click", (event) => {
      const option = event.target.closest(".mobile-picker-option");
      if (!option || !this.mobileVariablePickerList.contains(option)) return;
      const datasetKey = option.dataset.dataset;
      const variable = option.dataset.variable;
      if (!datasetKey || !variable) return;
      this.closeDialog(this.mobileVariablePickerDialog);
      void this.selectVariable(datasetKey, variable, { onBeforeDatasetChange, onVariableChange });
    });

    this.bindVariableTooltip();
  }

  openDialog(dialog) {
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
  }

  closeDialog(dialog) {
    if (typeof dialog.close === "function") {
      dialog.close();
      return;
    }
    dialog.removeAttribute("open");
    // `close` only fires for the real thing, so the fallback path has to say so
    // itself or nothing puts the opener back.
    dialog.dispatchEvent(new Event("close"));
  }

  async openVariableInfoPopover(
    datasetKey = this.state.dataset,
    variableKey = this.state.variable,
    { anchor = null, triggerButton = null } = {},
  ) {
    if (!this.hasVariableMetadataSummary(datasetKey, variableKey)) return;
    // A trigger with `aria-expanded="true"` has promised that pressing it again
    // will close what it opened, so it does.
    const alreadyOpen =
      this.tooltipPersistent &&
      !this.variableTooltip.hidden &&
      this.tooltipVariable === `${datasetKey}:${variableKey}` &&
      (!triggerButton || this.tooltipTrigger === triggerButton);
    if (alreadyOpen) {
      this.hideVariableTooltip({ restoreFocus: true });
      return;
    }

    this.hideVariableTooltip();
    const opensSelectedVariable = datasetKey === this.state.dataset && variableKey === this.state.variable;
    if (opensSelectedVariable && this.mobileVariableInfoBtn.disabled) return;

    if (triggerButton) triggerButton.disabled = true;
    if (opensSelectedVariable) this.mobileVariableInfoBtn.disabled = true;
    await this.ensureVariableFullMetadata(datasetKey, variableKey);
    if (opensSelectedVariable && (this.state.dataset !== datasetKey || this.state.variable !== variableKey)) {
      this.refreshVariableMetadataPanel();
      if (triggerButton) {
        triggerButton.disabled = false;
        if (document.activeElement === document.body) triggerButton.focus();
      }
      return;
    }

    this.refreshVariableMetadataPanel();
    const metaForVariable = this.getCachedFullVariableMetadata(datasetKey, variableKey);
    const title = this.getVariableTitle(datasetKey, variableKey);
    const hasContent = metaForVariable
      ? this.renderVariableTooltip(datasetKey, variableKey, metaForVariable, title, { persistent: true })
      : false;
    if (triggerButton) {
      triggerButton.disabled =
        !this.hasVariableMetadataSummary(datasetKey, variableKey) ||
        this.getCachedFullVariableMetadata(datasetKey, variableKey) === null;
    }
    // Disabling the trigger for the length of the fetch drops the focus onto
    // the body, so every way out of here has to put it somewhere. When the card
    // opens that is the card; when it does not, it is the button that asked.
    if (!hasContent) {
      if (triggerButton && !triggerButton.disabled && document.activeElement === document.body) {
        triggerButton.focus();
      }
      return;
    }
    this.tooltipPersistent = true;
    this.tooltipTrigger = triggerButton || null;
    this.tooltipVariable = `${datasetKey}:${variableKey}`;

    // A tooltip is a passing description of whatever the pointer is on. This
    // one stays until it is dismissed, holds several paragraphs and two links,
    // and now has a close button, so it is a dialog and says so. Not modal: the
    // page behind it stays usable, which is the point of a card you can leave
    // open while you carry on reading the list.
    this.variableTooltip.setAttribute("role", "dialog");
    this.variableTooltip.setAttribute("aria-modal", "false");
    this.variableTooltip.tabIndex = -1;
    this.variableTooltipCloseBtn.hidden = false;
    if (triggerButton) triggerButton.setAttribute("aria-expanded", "true");

    this.variableTooltip.hidden = false;
    this.positionVariableTooltip(anchor || triggerButton || this.mobileVariableInfoBtn || this.variableList);
    // Into the card rather than onto its close button: the card is what was
    // asked for, and landing on Close would read the way out before reading
    // anything to come out of. Tab from here reaches the close button and the
    // two footer links, and Escape closes from anywhere.
    this.variableTooltip.focus();
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
    this.refreshVariableMetadataPanel();
    this.refreshMobileSelectionSummary();
    this.refreshMobilePicker();
    if (typeof onDatasetChange === "function") {
      await onDatasetChange(datasetKey);
    }
  }

  // Startup arrives with a dataset and a variable key that may not match:
  // the cookie or the config default may name a variable this config no longer
  // offers — a derived one from when those were listed, or one since dropped.
  // The list used to work this out per dataset as it rendered; it spans every
  // dataset now, so it is resolved once, for the dataset the map opens on.
  applyInitialSelection() {
    const datasetKey = this.state.dataset;
    const hierarchy = this.datasetHierarchies[datasetKey];

    let variable =
      this.selectionPreference?.dataset === datasetKey
        ? this.resolveKnownMainVariable(datasetKey, this.selectionPreference.variable) || ""
        : "";

    if (!variable) {
      variable = this.getRememberedSelection(datasetKey) || "";
    }

    if (!variable) {
      const configured = this.state.variable;
      if (configured && hierarchy?.mainVariableSet.has(configured)) {
        variable = configured;
      } else if (configured && hierarchy?.mainVariableSet.has(stripVariantSuffixChain(configured))) {
        variable = stripVariantSuffixChain(configured);
      }
    }
    if (!variable) {
      variable = this.getAllVariableRows().find((row) => row.datasetKey === datasetKey)?.mainVariable || "";
    }

    this.state.variable = variable;
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

  setVariableQuery(value) {
    const next = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (next === this.variableQuery) return;
    this.variableQuery = next;
    this.refreshVariables();
  }

  clearFilters() {
    if (this.activeTopics.size === 0 && this.activeDatasets.size === 0 && this.variableQuery === "") return;
    this.activeTopics.clear();
    this.activeDatasets.clear();
    this.variableQuery = "";
    if (this.variableSearch) this.variableSearch.value = "";
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

  buildDatasetTag(datasetKey, className = "variable-option-dataset") {
    const dataset = this.meta.datasets[datasetKey];
    const tag = document.createElement("span");
    tag.className = className;
    tag.textContent = this.getDatasetLabel(dataset, datasetKey);
    tag.title = this.getDatasetTitle(dataset, datasetKey);
    return tag;
  }

  // A row is one control: a label wrapping a hidden radio. It used to be a split
  // button, with a caret opening a menu of the variable's other versions; only
  // the base version is offered now, so every row is the same shape and the
  // coverage strips line up without any of the padding gymnastics that needed.
  buildVariableOption(datasetKey, variable) {
    const option = document.createElement("div");
    option.className = "variable-option";
    // Two datasets may name a variable the same thing, so every lookup that used
    // to key on the variable alone is now qualified by its dataset.
    option.dataset.variable = variable;
    option.dataset.dataset = datasetKey;
    // Everything inside the row reads its dataset's shades from here.
    this.applyDatasetPalette(option, datasetKey);

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
    const head = document.createElement("span");
    head.className = "variable-option-head";

    const name = document.createElement("span");
    name.className = "variable-option-name";
    name.textContent = title;
    head.appendChild(name);
    head.appendChild(this.buildDatasetTag(datasetKey));
    label.appendChild(head);

    // Last line: where this variable has data, on the axis its whole dataset
    // shares, so two rows can be compared by eye without reading any numbers.
    const coverage = document.createElement("span");
    coverage.className = "variable-option-coverage";
    label.appendChild(coverage);

    option.appendChild(label);

    const infoButton = document.createElement("button");
    infoButton.type = "button";
    infoButton.className = "variable-option-info";
    infoButton.dataset.dataset = datasetKey;
    infoButton.dataset.variable = variable;
    infoButton.disabled = !this.hasVariableMetadataSummary(datasetKey, variable);
    infoButton.title = infoButton.disabled ? "No variable information available" : `Variable information: ${title}`;
    infoButton.setAttribute("aria-label", `Variable information: ${title}`);
    // The card it opens is a dialog that stays put, so the button reports
    // whether it is open — see openVariableInfoPopover.
    infoButton.setAttribute("aria-haspopup", "dialog");
    infoButton.setAttribute("aria-expanded", "false");
    infoButton.setAttribute("aria-controls", "variableTooltip");
    infoButton.innerHTML = '<i data-lucide="info" aria-hidden="true"></i>';
    option.appendChild(infoButton);

    // Outside the `<label>`, so it describes the radio instead of becoming part
    // of its name. A list read row by row should be read by variable title.
    const coverageDrawn = this.renderCoverageStrip(datasetKey, option, variable);
    if (coverageDrawn) {
      const id = `coverage-${datasetKey}-${variable}`;
      option.appendChild(this.buildCoverageText(this.describeCoverage(coverageDrawn.entry), id));
      input.setAttribute("aria-describedby", id);
    }
    return option;
  }

  // The cookie may still name a derived variable from when those were offered,
  // and the config it was saved against may have moved on since — so it counts
  // only if the dataset still has it, and a derived one resolves to its base.
  resolveKnownMainVariable(datasetKey, variable) {
    const hierarchy = this.datasetHierarchies[datasetKey];
    if (!variable || !hierarchy) return null;
    if (hierarchy.mainVariableSet.has(variable)) return variable;

    const mainVariable = stripVariantSuffixChain(variable);
    return hierarchy.mainVariableSet.has(mainVariable) ? mainVariable : null;
  }

  getRememberedSelection(datasetKey) {
    return this.resolveKnownMainVariable(datasetKey, this.variableChoices[datasetKey]);
  }

  rememberVariableChoice(datasetKey, variable) {
    if (!datasetKey || !variable || this.variableChoices[datasetKey] === variable) return;
    this.variableChoices[datasetKey] = variable;
    writeVariableChoices(this.variableChoices);
  }

  // ---- Variable coverage strip ----
  // A sparkline of where a variable has data, drawn on the axis its dataset
  // shares. Bar height folds together how often the variable is sampled and how
  // many countries it reaches, both baked into scripts/build_variable_coverage.sh
  // — the list shows every row at once, so nothing here may hit the database.

  // The variable's own entry and nothing else: since each strip is drawn on its
  // own years, the dataset's span is no longer part of reading one.
  getCoverageStripData(datasetKey, variableKey) {
    const entry = this.coverageMeta?.[datasetKey]?.variables?.[variableKey];
    if (!entry || typeof entry.levels !== "string" || entry.levels.length === 0) return null;
    return entry;
  }

  // Each strip runs between its own variable's first and last year, and says
  // which two those are underneath itself. The strips used to share one axis so
  // that a bar in the same place meant the same year on every row; that bought
  // comparison between rows at the price of every QoG row spending three
  // quarters of its width on the century before QoG begins, and of a floor year
  // that cut V-Dem's 18th-century series off at the left edge. The years written
  // under the row are what replaces it: nothing about the scale is implied any
  // more, so nothing has to be shared for it to be read correctly.
  getCoverageAxis(entry) {
    if (!Number.isFinite(entry?.yearMin) || !Number.isFinite(entry?.yearMax)) return null;
    if (entry.yearMax < entry.yearMin) return null;
    return { yearMin: entry.yearMin, yearMax: entry.yearMax };
  }

  // What the strip says in words.
  //
  // The strip itself is an `aria-hidden` SVG plus a `title`, and neither of
  // those reaches anyone who is not pointing a mouse at it: `title` is not
  // exposed to the keyboard at all and is not dependable in a screen reader
  // either. Which years, and how many countries, is the entire content of the
  // strip, so this is not a reduced version of it -- it is the same thing said
  // in words.
  describeCoverage(entry) {
    const range = entry.yearMin === entry.yearMax ? `${entry.yearMin} only` : `${entry.yearMin} to ${entry.yearMax}`;
    return `Data ${range}, up to ${this.describeCoverageCountries(entry)}`;
  }

  describeCoverageCountries(entry) {
    return entry.maxCountries === 1 ? "1 country" : `${entry.maxCountries} countries`;
  }

  // Draws the strip and hands back what it drew, so the caller can say it in
  // words wherever that text belongs. It cannot be placed from here: in the
  // sidebar the row is a `<label>` wrapping a radio, so text put inside it
  // lands in the radio's *name* and, with `aria-describedby` pointing at the
  // same span, is then read a second time as its description. The two callers
  // want it in two different places for that reason.
  renderCoverageStrip(datasetKey, option, variable) {
    const target = option.querySelector(".variable-option-coverage");
    if (!target) return;

    const entry = this.getCoverageStripData(datasetKey, variable);
    const axis = entry ? this.getCoverageAxis(entry) : null;
    const staleAxis = option.querySelector(".variable-option-coverage-axis");
    if (staleAxis) staleAxis.remove();
    if (!entry || !axis) {
      // A variable the precompute never saw gets no strip rather than an empty
      // track, which would read as "this variable has no data anywhere".
      target.innerHTML = "";
      target.hidden = true;
      return null;
    }

    target.hidden = false;
    target.innerHTML = this.buildCoverageStripSvg(entry);
    target.title = `Data ${entry.yearMin}\u2013${entry.yearMax}, up to ${entry.maxCountries} countries`;
    // The scale goes directly under the track it belongs to, whichever list the
    // row is in — putting it here rather than at the two call sites is what
    // keeps a strip from ever being drawn without the years that read it.
    target.after(this.buildCoverageAxis(axis));

    return { entry, axis };
  }

  // The two years the strip runs between, written under it. These are not
  // decoration: with a per-variable axis the width of the track says nothing
  // about which years it covers, so this is the only thing that does.
  //
  // `aria-hidden`, because both callers put the strip inside a control — a
  // `<label>` wrapping a radio in the sidebar, a `<button>` on the phone — where
  // visible text joins that control's accessible name, and the same two years
  // are already in the description text beside it.
  buildCoverageAxis(axis) {
    const el = document.createElement("span");
    el.className = "variable-option-coverage-axis";
    el.setAttribute("aria-hidden", "true");
    const single = axis.yearMin === axis.yearMax;
    el.classList.toggle("is-single", single);
    for (const year of single ? [axis.yearMin] : [axis.yearMin, axis.yearMax]) {
      const tick = document.createElement("span");
      tick.textContent = String(year);
      el.appendChild(tick);
    }
    return el;
  }

  // A run of off-screen text, for the two places a strip has to be said rather
  // than seen.
  buildCoverageText(text, id = null) {
    const el = document.createElement("span");
    el.className = "visually-hidden";
    if (id) el.id = id;
    el.textContent = text;
    return el;
  }

  // One <svg> holding one <path>, for the row strip and the hover card alike:
  // a bar per element would put tens of thousands of nodes in a V-Dem list, and
  // the list is rebuilt from scratch on every dataset switch.
  buildCoverageStripSvg(entry, className = "variable-option-coverage-svg") {
    const axis = this.getCoverageAxis(entry);
    const levels = entry?.levels ?? "";
    const buckets = levels.length;
    if (!axis || buckets === 0) return "";

    // The bucket string is spaced across the variable's own span, which is also
    // the viewBox, so the path is emitted in years and the first and last bucket
    // always reach the two ends of the track.
    const axisSpan = axis.yearMax - axis.yearMin + 1;
    const bucketYears = axisSpan / buckets;
    const barYears = bucketYears * COVERAGE_BAR_W;

    const bars = [];
    for (let i = 0; i < buckets; i += 1) {
      const level = Number(levels[i]);
      if (!Number.isFinite(level) || level <= 0) continue;
      const x = axis.yearMin + i * bucketYears;
      // Level 1 is "present but thin". Sitting it at a quarter of the track
      // keeps a 32-country sample visibly above the baseline instead of merging
      // into it, while still ranking below a 165-country one.
      const height = COVERAGE_BAR_MIN_H + ((level - 1) / 8) * (COVERAGE_TRACK_H - COVERAGE_BAR_MIN_H);
      const y = (COVERAGE_TRACK_H - height).toFixed(2);
      bars.push(`M${x.toFixed(2)} ${y}h${barYears.toFixed(2)}v${height.toFixed(2)}h-${barYears.toFixed(2)}z`);
    }
    if (bars.length === 0) return "";
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
    this.datasetTabs.addEventListener("pointerover", (event) => {
      if (event.pointerType && event.pointerType !== "mouse") return;
      const chip = event.target.closest(".chip-dataset");
      if (!chip || !this.datasetTabs.contains(chip)) return;
      this.scheduleDatasetTooltip(chip);
    });
    this.datasetTabs.addEventListener("pointerleave", () => this.scheduleHideVariableTooltip());
    this.datasetTabs.addEventListener("focusin", (event) => {
      const chip = event.target.closest(".chip-dataset");
      if (chip) this.scheduleDatasetTooltip(chip);
    });
    this.datasetTabs.addEventListener("focusout", () => this.scheduleHideVariableTooltip());

    this.variableList.addEventListener("pointerover", (event) => {
      // Touch and pen taps select a row; only a hovering mouse gets the card.
      if (event.pointerType && event.pointerType !== "mouse") return;
      const option = event.target.closest(".variable-option");
      if (!option || !this.variableList.contains(option)) return;
      this.scheduleVariableTooltip(option);
    });

    this.variableList.addEventListener("pointerleave", () => this.scheduleHideVariableTooltip());
    this.variableList.addEventListener("focusin", (event) => {
      const option = event.target.closest(".variable-option");
      if (option) this.scheduleVariableTooltip(option);
    });
    this.variableList.addEventListener("focusout", () => this.scheduleHideVariableTooltip());

    this.variableTooltip.addEventListener("pointerenter", () => {
      window.clearTimeout(this.tooltipHideTimer);
      this.tooltipHideTimer = null;
    });
    this.variableTooltip.addEventListener("pointerleave", () => this.scheduleHideVariableTooltip());

    // Any scrolling container moves the row out from under the card, so drop it.
    document.addEventListener(
      "scroll",
      (event) => {
        if (this.variableTooltip.contains(event.target)) return;
        this.hideVariableTooltip();
      },
      true,
    );
    window.addEventListener("resize", () => this.hideVariableTooltip());

    this.variableTooltipCloseBtn.addEventListener("click", () => {
      this.hideVariableTooltip({ restoreFocus: true });
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      // Escape out of the persistent card puts the focus back where it came
      // from; Escape while a hover card happens to be up is just a dismissal
      // and must not move anyone's focus.
      this.hideVariableTooltip({ restoreFocus: this.tooltipPersistent });
    });

    document.addEventListener("pointerdown", (event) => {
      if (!this.tooltipPersistent || this.variableTooltip.hidden) return;
      if (this.variableTooltip.contains(event.target)) return;
      // Every trigger that opens the persistent card has to be listed here, or
      // its own opening click is read as a click outside and shuts the card in
      // the same gesture that asked for it.
      if (event.target.closest(".variable-option-info, .timeline-variable-info, #mobileVariableInfoBtn")) return;
      this.hideVariableTooltip();
    });

    // Tab past the last thing in the card and the focus lands somewhere behind
    // it with the card still open and still claiming to be a dialog. It is not
    // modal, so the focus is not trapped -- it is simply closed instead, which
    // is what leaving it means.
    this.variableTooltip.addEventListener("focusout", (event) => {
      if (!this.tooltipPersistent) return;
      if (event.relatedTarget && this.variableTooltip.contains(event.relatedTarget)) return;
      // The button that opened it is not "somewhere behind it": it is the card's
      // own control, it says `aria-expanded="true"`, and pressing it is how the
      // card is meant to be closed. Closing here instead would beat the toggle
      // to it -- focus lands on the button before its click runs, so the card
      // would shut and the click would open it straight back up.
      if (event.relatedTarget === this.tooltipTrigger) return;
      // A focusout with no relatedTarget is the focus leaving the document
      // (another window, the URL bar); the card should still be there on the
      // way back.
      if (!event.relatedTarget) return;
      this.hideVariableTooltip();
    });
  }

  scheduleDatasetTooltip(chip) {
    const datasetKey = chip.dataset.dataset;
    if (!datasetKey || !this.meta.datasets[datasetKey]) return;
    const key = `dataset:${datasetKey}`;
    if (key === this.tooltipVariable) return;
    this.hideVariableTooltip();
    this.tooltipPersistent = false;
    this.tooltipVariable = key;
    this.tooltipTimer = window.setTimeout(() => {
      void this.showDatasetTooltip(chip, datasetKey);
    }, TOOLTIP_HOVER_DELAY_MS);
  }

  scheduleVariableTooltip(option) {
    const variable = option.dataset.variable;
    // The hovered row names its own dataset. Reading the selected one here asked
    // the backend for, say, a REPDEM variable under v_dem and 404ed.
    const datasetKey = option.dataset.dataset;
    if (!variable || !datasetKey) return;
    const key = `variable:${datasetKey}:${variable}`;
    if (key === this.tooltipVariable) return;
    this.hideVariableTooltip();
    this.tooltipPersistent = false;
    this.tooltipVariable = key;
    this.tooltipTimer = window.setTimeout(() => {
      void this.showVariableTooltip(option, datasetKey, variable);
    }, TOOLTIP_HOVER_DELAY_MS);
  }

  scheduleHideVariableTooltip() {
    if (this.tooltipPersistent) return;
    window.clearTimeout(this.tooltipHideTimer);
    this.tooltipHideTimer = window.setTimeout(() => {
      if (!this.variableTooltip.matches(":hover")) this.hideVariableTooltip();
    }, 120);
  }

  // Closing covers both cards, and the persistent one has an undo to run: it
  // was a dialog with a name and a focus inside it, and it has to go back to
  // being a tooltip with neither.
  //
  // `{ restoreFocus }` is false for the paths that close the card without the
  // reader asking -- a scroll, a resize, a dataset switch, a hover moving on.
  // Pulling the focus back to a button in those is worse than leaving it: the
  // reader may be somewhere else entirely by then. The focus is also only ever
  // taken back if it is still inside the card, for the same reason.
  hideVariableTooltip({ restoreFocus = false } = {}) {
    window.clearTimeout(this.tooltipTimer);
    window.clearTimeout(this.tooltipHideTimer);
    this.tooltipTimer = null;
    this.tooltipHideTimer = null;
    this.tooltipVariable = null;

    const wasPersistent = this.tooltipPersistent;
    const trigger = this.tooltipTrigger;
    const heldFocus = this.variableTooltip.contains(document.activeElement);

    this.tooltipPersistent = false;
    this.tooltipTrigger = null;
    this.variableTooltip.hidden = true;
    this.variableTooltip.classList.remove("is-persistent");

    if (!wasPersistent) return;
    this.variableTooltip.setAttribute("role", "tooltip");
    this.variableTooltip.removeAttribute("aria-modal");
    this.variableTooltip.removeAttribute("tabindex");
    this.variableTooltipCloseBtn.hidden = true;
    if (trigger) trigger.setAttribute("aria-expanded", "false");
    if (trigger && (restoreFocus || heldFocus) && trigger.isConnected) trigger.focus();
  }

  async showVariableTooltip(option, datasetKey, variable) {
    const key = `variable:${datasetKey}:${variable}`;
    let metaForVariable = this.getCachedFullVariableMetadata(datasetKey, variable);
    if (metaForVariable === undefined) {
      metaForVariable = await this.ensureVariableFullMetadata(datasetKey, variable);
      // The pointer may have moved on to another row while we fetched.
      if (this.tooltipVariable !== key) return;
    }
    if (!metaForVariable) return;

    const title = this.getVariableTitle(datasetKey, variable);
    if (!this.renderVariableTooltip(datasetKey, variable, metaForVariable, title)) return;
    this.variableTooltip.hidden = false;
    this.positionVariableTooltip(option);
  }

  async showDatasetTooltip(chip, datasetKey) {
    const key = `dataset:${datasetKey}`;
    if (!this.varMetaByDataset[datasetKey]) {
      await this.ensureDatasetMetadata(datasetKey);
      if (this.tooltipVariable !== key) return;
    }
    if (!this.renderDatasetTooltip(datasetKey)) return;
    this.variableTooltip.hidden = false;
    this.positionVariableTooltip(chip);
  }

  renderDatasetTooltip(datasetKey) {
    const dataset = this.meta.datasets[datasetKey];
    if (!dataset) return false;

    this.variableTooltip.style.setProperty("--tip-accent", this.getDatasetAccent(datasetKey));
    this.applyDatasetPalette(this.variableTooltip, datasetKey);
    this.variableTooltip.classList.remove("is-persistent");

    const title = this.getDatasetTitle(dataset, datasetKey);
    const label = this.getDatasetLabel(dataset, datasetKey);
    this.variableTooltipTitle.textContent = title;
    this.variableTooltipDataset.textContent = label;
    this.variableTooltipDataset.title = title;
    this.variableTooltipKey.textContent = datasetKey;
    this.variableTooltipKey.hidden = false;

    this.variableTooltipBody.innerHTML = "";
    const description = typeof dataset.description === "string" ? dataset.description.trim() : "";
    if (description) {
      const paragraph = document.createElement("p");
      paragraph.className = "variable-tooltip-desc";
      paragraph.textContent = description;
      this.variableTooltipBody.appendChild(paragraph);
    }

    const mainVariableCount = this.datasetHierarchies[datasetKey]?.mainVariables?.length;
    const rawVariableCount = Array.isArray(dataset.variables) ? dataset.variables.length : null;
    const variableCount = Number.isInteger(mainVariableCount) ? mainVariableCount : rawVariableCount;
    if (Number.isInteger(variableCount)) {
      const variantNote =
        Number.isInteger(rawVariableCount) && rawVariableCount > variableCount
          ? ` (${rawVariableCount} total columns including derived versions)`
          : "";
      this.appendVariableTooltipItem(
        "Variables",
        `${variableCount} listed ${variableCount === 1 ? "variable" : "variables"}${variantNote}`,
      );
    }

    if (Number.isInteger(dataset.yearMin) && Number.isInteger(dataset.yearMax)) {
      const years = dataset.yearMin === dataset.yearMax ? String(dataset.yearMin) : `${dataset.yearMin}-${dataset.yearMax}`;
      this.appendVariableTooltipItem("Years", years);
    }

    const defaultVariable = typeof dataset.defaultVariable === "string" ? dataset.defaultVariable : "";
    if (defaultVariable) {
      this.appendVariableTooltipItem("Default", this.getVariableTitle(datasetKey, defaultVariable));
    }

    this.appendVariableTooltipItem("Source", this.varMetaByDataset[datasetKey]?.citation);
    this.appendVariableMetaLinks(this.variableTooltipBody, datasetKey);

    return this.variableTooltipBody.children.length > 0;
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

  renderVariableTooltip(datasetKey, variable, metaForVariable, title, { persistent = false } = {}) {
    this.variableTooltip.style.setProperty("--tip-accent", this.getDatasetAccent(datasetKey));
    // The card's dataset tag draws its edge from `--ds-1`, the same custom
    // property the variable rows draw theirs from, so the two marks cannot drift
    // apart for a dataset whose configured `color` is not its palette's first
    // shade -- they now read one value, not two that happen to agree.
    this.applyDatasetPalette(this.variableTooltip, datasetKey);
    this.variableTooltip.classList.toggle("is-persistent", persistent);
    this.variableTooltipTitle.textContent = title;
    // The list mixes every dataset's rows together, so the card says which one
    // this variable came from. The short label is what fits a corner tag; the
    // full name rides along as its tooltip, the way the dataset chips do it.
    const dataset = this.meta.datasets[datasetKey];
    this.variableTooltipDataset.textContent = this.getDatasetLabel(dataset, datasetKey);
    this.variableTooltipDataset.title = this.getDatasetTitle(dataset, datasetKey);
    this.variableTooltipKey.textContent = variable;
    // Untitled variables already show their key as the name, so skip the echo.
    this.variableTooltipKey.hidden = title === variable;

    this.variableTooltipBody.innerHTML = "";
    return this.appendVariableInfoBody(this.variableTooltipBody, datasetKey, variable, metaForVariable, title, {
      includeOverview: true,
      includeCodebook: true,
    });
  }

  appendVariableInfoBody(
    container,
    datasetKey,
    variable,
    metaForVariable,
    title,
    { includeOverview = false, includeCodebook = false, includeKey = false } = {},
  ) {
    const initialCount = container.children.length;
    const paragraph = document.createElement("p");
    paragraph.className = "variable-tooltip-desc";
    const summary = this.getVariableSummary(metaForVariable, title);
    if (summary.label) {
      const label = document.createElement("span");
      label.className = "variable-tooltip-item-label";
      label.textContent = summary.label;
      paragraph.appendChild(label);
    }
    if (summary.text) {
      paragraph.appendChild(document.createTextNode(summary.text));
      container.appendChild(paragraph);
    }

    if (includeOverview) {
      const clarification = this.getVariableMetaText(metaForVariable.clarification);
      if (clarification && clarification !== summary.text) {
        this.appendVariableTooltipItem("Overview", clarification, container);
      }
    }

    this.appendVariableTooltipItem("Scale", metaForVariable.scale, container);
    this.appendVariableTooltipCoverage(datasetKey, variable, container);

    if (includeKey && title !== variable) {
      this.appendVariableTooltipItem("Variable key", variable, container);
    }
    // How to cite the data this variable came from. It is the dataset's line,
    // not the variable's -- the card's dataset tag says which one -- and it
    // lives here because the card is now the only place it is written out.
    this.appendVariableTooltipItem("Source", this.varMetaByDataset[datasetKey]?.citation, container);
    const hasBodyContent = container.children.length > initialCount;
    if (includeCodebook) {
      this.appendVariableMetaLinks(container, datasetKey);
    }

    return hasBodyContent;
  }

  // The same strip the row carries, but with room to say what it means: the row
  // has the years underneath it and nothing else, so the reason one bar is
  // taller than the next can only be spelled out here.
  appendVariableTooltipCoverage(datasetKey, variable, container = this.variableTooltipBody) {
    const entry = this.getCoverageStripData(datasetKey, variable);
    const axisRange = entry ? this.getCoverageAxis(entry) : null;
    if (!entry || !axisRange) return;

    const section = document.createElement("div");
    section.className = "variable-tooltip-coverage";

    const label = document.createElement("span");
    label.className = "variable-tooltip-item-label";
    label.textContent = "Coverage";
    section.appendChild(label);

    const track = document.createElement("span");
    track.className = "variable-tooltip-coverage-track";
    track.innerHTML = this.buildCoverageStripSvg(entry, "variable-tooltip-coverage-svg");
    section.appendChild(track);

    // The strip runs between the variable's own first and last year, so these
    // two are the whole scale: without them a 19-year QoG span and a 237-year
    // V-Dem one are the same picture.
    const axis = document.createElement("span");
    axis.className = "variable-tooltip-coverage-axis";
    const single = axisRange.yearMin === axisRange.yearMax;
    axis.classList.toggle("is-single", single);
    for (const year of single ? [axisRange.yearMin] : [axisRange.yearMin, axisRange.yearMax]) {
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
    note.textContent =
      `Data ${range}, up to ${entry.maxCountries} ${entry.maxCountries === 1 ? "country" : "countries"}. ` +
      `The strip spans those years only. Bar height combines how many countries reported and how many ` +
      `of the years in that step carry data, against the busiest year in ${this.getDatasetLabel(this.meta.datasets[datasetKey], datasetKey)}.`;
    section.appendChild(note);

    container.appendChild(section);
  }

  appendVariableTooltipItem(label, value, container = this.variableTooltipBody) {
    if (typeof value !== "string" || value.trim().length === 0) return;
    const item = document.createElement("p");
    item.className = "variable-tooltip-item";

    const name = document.createElement("span");
    name.className = "variable-tooltip-item-label";
    name.textContent = label;
    item.appendChild(name);
    item.appendChild(document.createTextNode(value.trim()));

    container.appendChild(item);
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
  // them, so the row tag says which one it belongs to and the panel follows it.
  async selectVariable(datasetKey, variable, { onBeforeDatasetChange, onVariableChange } = {}) {
    const datasetChanged = datasetKey !== this.state.dataset;
    if (datasetChanged) {
      if (typeof onBeforeDatasetChange === "function") onBeforeDatasetChange(datasetKey);
      this.state.dataset = datasetKey;
      this.applyDatasetChrome(datasetKey);
      await this.ensureDatasetMetadata(datasetKey);
      if (this.state.dataset !== datasetKey) return;
    }

    this.state.variable = variable;
    this.rememberVariableChoice(datasetKey, variable);
    this.markSelectedVariableOption(datasetKey, variable);
    this.refreshVariableMetadataPanel();
    this.refreshMobileSelectionSummary();
    this.refreshMobilePicker();
    if (typeof onVariableChange === "function") {
      onVariableChange();
    }
  }

  markSelectedVariableOption(datasetKey, variable) {
    for (const option of this.variableList.querySelectorAll(".variable-option")) {
      const isSelected = option.dataset.variable === variable && option.dataset.dataset === datasetKey;
      option.classList.toggle("is-selected", isSelected);
      const input = option.querySelector("input");
      input.checked = isSelected;
      // Roving tabindex: one stop for the whole group, as radio groups behave.
      input.tabIndex = isSelected ? 0 : -1;
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
    const rows = this.getFilteredRows();

    this.variableList.innerHTML = "";
    this.variableList.removeAttribute("aria-busy");
    for (const row of rows) {
      this.variableList.appendChild(this.buildVariableOption(row.datasetKey, row.mainVariable));
    }

    // Filtering never changes what the map is showing — the selected variable
    // may simply not be on screen. Hiding it would otherwise silently disagree
    // with the legend and the map.
    this.renderFilterSummary(rows.length);
    this.markSelectedVariableOption(this.state.dataset, this.state.variable);
    this.scrollSelectedVariableIntoView();
    this.refreshMobileSelectionSummary();
    this.refreshLucideIcons();
  }

  refreshLucideIcons() {
    refreshIcons();
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

  // What a free-text search looks at, for the sidebar box and the phone picker
  // alike. Everything a row shows or stands for, so the key a reader copied out
  // of a codebook finds its row even though the row is titled in prose, and a
  // dataset or topic name finds the rows under it even with no chip lit.
  rowMatchesQuery(row, query) {
    if (!query) return true;
    const dataset = this.meta.datasets[row.datasetKey];
    const topicText = row.topics
      .map((id) => this.topicsConfig.topics.get(id)?.label || "")
      .filter(Boolean)
      .join(" ");
    return [
      row.title,
      row.mainVariable,
      row.datasetKey,
      this.getDatasetLabel(dataset, row.datasetKey),
      this.getDatasetTitle(dataset, row.datasetKey),
      topicText,
    ]
      .join(" ")
      .toLowerCase()
      .includes(query);
  }

  getFilteredRows() {
    const rows = this.getAllVariableRows();
    if (this.activeTopics.size === 0 && this.activeDatasets.size === 0 && !this.variableQuery) return rows;
    return rows.filter((row) => {
      if (this.activeDatasets.size > 0 && !this.activeDatasets.has(row.datasetKey)) return false;
      if (this.activeTopics.size > 0 && !row.topics.some((id) => this.activeTopics.has(id))) return false;
      return this.rowMatchesQuery(row, this.variableQuery);
    });
  }

  getMobilePickerRows() {
    return this.getAllVariableRows().filter((row) => {
      if (this.mobilePickerTopics.size > 0 && !row.topics.some((id) => this.mobilePickerTopics.has(id))) {
        return false;
      }
      return this.rowMatchesQuery(row, this.mobilePickerQuery);
    });
  }

  getPrimaryTopic(row) {
    const topicId = row.topics.find((id) => this.topicsConfig.topics.has(id));
    if (!topicId) return { id: "", label: "Other variables", sort: Number.MAX_SAFE_INTEGER };
    const orderIndex = this.topicsConfig.order.indexOf(topicId);
    return {
      id: topicId,
      label: this.topicsConfig.topics.get(topicId)?.label || topicId,
      sort: orderIndex === -1 ? Number.MAX_SAFE_INTEGER - 1 : orderIndex,
    };
  }

  getVariableCoverageRange(datasetKey, variable) {
    const entry = this.getCoverageStripData(datasetKey, variable);
    if (!entry) return "";
    if (!Number.isFinite(entry.yearMin) || !Number.isFinite(entry.yearMax)) return "";
    return entry.yearMin === entry.yearMax ? String(entry.yearMin) : `${entry.yearMin}-${entry.yearMax}`;
  }

  buildMobilePickerOption(row) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "mobile-picker-option";
    option.dataset.dataset = row.datasetKey;
    option.dataset.variable = row.mainVariable;
    this.applyDatasetPalette(option, row.datasetKey);

    // A plain button, not an `option`: see the note on #mobileVariablePickerList
    // in index.html. `aria-current` is what marks the one already on the map —
    // `aria-selected` belongs to a listbox and says nothing on a button.
    const selected = row.datasetKey === this.state.dataset && row.mainVariable === this.state.variable;
    option.classList.toggle("is-selected", selected);
    if (selected) option.setAttribute("aria-current", "true");
    else option.removeAttribute("aria-current");

    const head = document.createElement("span");
    head.className = "mobile-picker-option-head";

    const title = document.createElement("span");
    title.className = "mobile-picker-option-title";
    title.textContent = row.title;
    head.appendChild(title);
    head.appendChild(this.buildDatasetTag(row.datasetKey, "mobile-picker-option-dataset"));
    option.appendChild(head);

    // The year range used to be written here as well. It is now under the strip
    // below, where it is the strip's scale rather than a repeat of it.
    const meta = document.createElement("span");
    meta.className = "mobile-picker-option-meta";
    meta.textContent = row.mainVariable;
    option.appendChild(meta);

    const coverage = document.createElement("span");
    coverage.className = "variable-option-coverage mobile-picker-option-coverage";
    option.appendChild(coverage);
    // The option is the button, so anything put inside it joins the button's
    // name -- there is nowhere here to hang a separate description without
    // breaking the `.mobile-picker-option + .mobile-picker-option` spacing. The
    // years under the strip are `aria-hidden`, so this is where they are said.
    const coverageDrawn = this.renderCoverageStrip(row.datasetKey, option, row.mainVariable);
    if (coverageDrawn) {
      option.appendChild(this.buildCoverageText(`, ${this.describeCoverage(coverageDrawn.entry).toLowerCase()}`));
    }

    return option;
  }

  refreshMobilePicker() {
    const rows = this.getMobilePickerRows();
    this.mobileVariablePickerList.innerHTML = "";

    if (rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "mobile-picker-empty";
      empty.textContent = "No variables match this search.";
      this.mobileVariablePickerList.appendChild(empty);
      return;
    }

    const groups = new Map();
    for (const row of rows) {
      const topic = this.getPrimaryTopic(row);
      if (!groups.has(topic.id)) {
        groups.set(topic.id, { ...topic, rows: [] });
      }
      groups.get(topic.id).rows.push(row);
    }

    const sortedGroups = [...groups.values()].sort(
      (a, b) => a.sort - b.sort || VARIABLE_COLLATOR.compare(a.label, b.label),
    );

    for (const group of sortedGroups) {
      const section = document.createElement("section");
      section.className = "mobile-picker-group";

      const heading = document.createElement("h3");
      heading.className = "mobile-picker-group-title";
      // The heading is visible, so the group takes its name from it rather than
      // repeating it in an aria-label that could drift from what is on screen.
      heading.id = `mobilePickerGroup-${group.id || "other"}`;
      heading.textContent = group.label;
      section.setAttribute("aria-labelledby", heading.id);
      section.appendChild(heading);

      for (const row of group.rows) {
        section.appendChild(this.buildMobilePickerOption(row));
      }
      this.mobileVariablePickerList.appendChild(section);
    }
  }

  getTopicsFor(datasetKey, mainVariable) {
    return this.topicsConfig.byVariable.get(`${datasetKey}:${mainVariable}`) || [];
  }

  renderFilterSummary(shownCount) {
    if (!this.filterSummary) return;
    const total = this.getAllVariableRows().length;
    const searching = this.variableQuery !== "";
    const filtered = this.activeTopics.size > 0 || this.activeDatasets.size > 0 || searching;

    if (!filtered) {
      this.filterSummary.textContent = `${total} variables`;
      this.filterSummary.hidden = false;
      return;
    }
    if (shownCount === 0) {
      // What to go and change is what the empty state has to say. With a chip
      // lit as well there is no telling which of the two emptied the list, so
      // only a search on its own gets to quote itself.
      const chipsOn = this.activeTopics.size > 0 || this.activeDatasets.size > 0;
      this.filterSummary.textContent = searching && !chipsOn
        ? `No variables match “${this.variableQuery}”`
        : "No variables match these filters";
    } else {
      this.filterSummary.textContent = `${shownCount} of ${total} variables`;
    }
    this.filterSummary.hidden = false;
  }

  refreshMobileSelectionSummary() {
    const datasetKey = this.state.dataset;
    const variable = this.state.variable;
    const dataset = this.meta.datasets[datasetKey];
    const title = this.getVariableTitle(datasetKey, variable);
    const topics = this.getTopicsFor(datasetKey, variable);
    const topicLabel = this.topicsConfig.topics.get(topics[0])?.label || "";
    const range = this.getVariableCoverageRange(datasetKey, variable);

    this.applyDatasetPalette(this.mobileSelectedDataset, datasetKey);
    this.mobileSelectedDataset.textContent = this.getDatasetLabel(dataset, datasetKey);
    this.mobileSelectedTitle.textContent = title;
    this.mobileSelectedMeta.textContent = [topicLabel, range].filter(Boolean).join(" / ") || variable;
  }

  // The card's footer: where a reader goes once the summary has told them what
  // the variable is. Both links are the dataset's, not the variable's -- the
  // codebook is one PDF per module, and Demscore's downloader has no address
  // that names a variable (see `DATASET_META` in web-backend/server.js) -- so a
  // variable's card offers the module it belongs to, which is the nearest thing
  // to a download link for the variable that exists.
  appendVariableMetaLinks(container, datasetKey) {
    const dataset = this.meta.datasets?.[datasetKey];
    const links = [
      { url: dataset?.codebook, text: "Open codebook PDF" },
      { url: dataset?.download, text: "Download data from Demscore" },
    ].filter(({ url }) => typeof url === "string" && url.length > 0);
    if (links.length === 0) return;

    const item = document.createElement("p");
    item.className = "variable-meta-links";

    for (const { url, text } of links) {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = text;
      item.appendChild(link);
    }

    container.appendChild(item);
  }

  getVariableMetaText(value) {
    if (typeof value !== "string") return "";
    return value.trim();
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
    const hasSummary = this.hasVariableMetadataSummary(this.state.dataset, this.state.variable);

    if (!hasSummary) {
      this.mobileVariableInfoBtn.disabled = true;
      return;
    }

    const metaForVariable = this.getCachedFullVariableMetadata(this.state.dataset, this.state.variable);
    if (metaForVariable === null) {
      this.mobileVariableInfoBtn.disabled = true;
      return;
    }

    if (metaForVariable === undefined) {
      this.mobileVariableInfoBtn.disabled = false;
      return;
    }

    this.mobileVariableInfoBtn.disabled = false;
  }
}

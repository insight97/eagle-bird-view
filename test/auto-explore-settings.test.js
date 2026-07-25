"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createElementStub } = require("../test-support/plugin-harness.js");
const {
  DEFAULT_UNRATED_FILTER,
  normalizeUnratedFilter,
  unratedFiltersEqual,
} = require("../exploration-source.js");
const { normalizeTags } = require("../bird-view-core.js");
const { createAutoExploreSettings } = require("../auto-explore-settings.js");

function createHarness() {
  const elements = {
    autoExploreSettingsButton: createElementStub("button"),
    autoExploreSettingsPanel: createElementStub("div"),
    autoExploreSettingsClose: createElementStub("button"),
    autoExploreSettingsTabs: [createElementStub("button"), createElementStub("button")],
    autoExploreSettingsPanels: [createElementStub("div"), createElementStub("div")],
    autoExploreFileTypeImage: createElementStub("input"),
    autoExploreFileTypeVideo: createElementStub("input"),
    autoExploreRating: createElementStub("select"),
    autoExploreTagMatch: createElementStub("select"),
    autoExploreMaxTagCount: createElementStub("input"),
    autoExploreTagSearch: createElementStub("input"),
    autoExploreTagOptions: createElementStub("div"),
    autoExploreSelectedTags: createElementStub("div"),
    autoExploreExcludedTagSearch: createElementStub("input"),
    autoExploreExcludedTagOptions: createElementStub("div"),
    autoExploreSelectedExcludedTags: createElementStub("div"),
    autoExploreSettingsReset: createElementStub("button"),
    autoExploreControls: createElementStub("div"),
  };
  elements.autoExploreSettingsPanel.hidden = true;
  elements.autoExploreSettingsTabs[0].dataset.settingsTab = "exploration";
  elements.autoExploreSettingsTabs[1].dataset.settingsTab = "display";
  elements.autoExploreSettingsPanels[0].dataset.settingsPanel = "exploration";
  elements.autoExploreSettingsPanels[1].dataset.settingsPanel = "display";
  elements.autoExploreFileTypeImage.checked = true;
  elements.autoExploreFileTypeVideo.checked = true;

  const document = {
    addEventListener() {},
    createElement(tag) {
      return createElementStub(tag);
    },
  };
  const changes = [];
  const settings = createAutoExploreSettings({
    document,
    elements,
    defaultFilter: DEFAULT_UNRATED_FILTER,
    normalizeFilter: normalizeUnratedFilter,
    filtersEqual: unratedFiltersEqual,
    normalizeTags,
    getKnownTags: () => ["UI", "Draft"],
    createTagChip: (tag) => {
      const chip = createElementStub("span");
      chip.textContent = tag;
      return chip;
    },
    onFilterChange(next, details) {
      changes.push({ next, details });
    },
  });
  return { changes, elements, settings };
}

test("auto explore settings apply normalized draft filters through one callback", () => {
  const harness = createHarness();
  harness.settings.setFilter({ rating: "unrated" });
  harness.elements.autoExploreSettingsButton.click();

  harness.elements.autoExploreRating.value = "3";
  harness.elements.autoExploreRating.emit("change");

  assert.equal(harness.settings.getFilter().rating, 3);
  assert.equal(harness.changes.length, 1);
  assert.equal(harness.changes[0].details.changed, true);
  assert.equal(harness.elements.autoExploreSettingsPanel.hidden, false);
});

test("auto explore settings resolve tag conflicts and reset to defaults", () => {
  const harness = createHarness();
  harness.elements.autoExploreSettingsButton.click();
  harness.elements.autoExploreTagSearch.value = "D";
  harness.elements.autoExploreTagSearch.emit("input");
  harness.elements.autoExploreTagOptions.children[0].click();

  assert.deepEqual(harness.settings.getFilter().tags, ["Draft"]);
  assert.deepEqual(harness.settings.getFilter().excludedTags, []);

  harness.elements.autoExploreSettingsReset.click();
  assert.deepEqual(harness.settings.getFilter(), normalizeUnratedFilter(DEFAULT_UNRATED_FILTER));
});

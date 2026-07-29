"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPluginHarness } = require("../../test-support/plugin-harness.js");

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("saves a preset, applies it, and updates the selected preset", async () => {
  const storage = createStorage();
  const plugin = createPluginHarness({
    selectedItems: [],
    storage,
    folderTree: [
      {
        id: "root",
        name: "Design",
        children: [{ id: "child", name: "References", parent: "root" }],
      },
    ],
  });
  plugin.start();
  await flush();

  const name = plugin.elements.get("#settings-preset-name");
  const save = plugin.elements.get("#settings-preset-save");
  const select = plugin.elements.get("#settings-preset-select");
  const toolbarSelect = plugin.elements.get("#toolbar-preset-select");
  const update = plugin.elements.get("#settings-preset-update");
  const deleteButton = plugin.elements.get("#settings-preset-delete");
  const layoutWidth = plugin.elements.get("#board-layout-width");
  const autoExploreToggle = plugin.elements.get("#auto-explore-toggle");
  const autoExploreStatus = plugin.elements.get("#auto-explore-status");

  name.value = "Focus view";
  save.click();
  assert.equal(select.value, "Focus view");
  assert.equal(toolbarSelect.value, "Focus view");
  assert.equal(toolbarSelect.disabled, false);
  assert.equal(update.disabled, false);

  layoutWidth.value = "1600";
  layoutWidth.emit("input");
  toolbarSelect.value = "Focus view";
  toolbarSelect.emit("change");
  assert.equal(layoutWidth.value, "1200");
  assert.equal(select.value, "Focus view");

  layoutWidth.value = "1600";
  layoutWidth.emit("input");
  update.click();

  const stored = JSON.parse(storage.getItem("bird-view-presets"));
  assert.equal(stored.presets[0].name, "Focus view");
  assert.equal(stored.presets[0].settings.board.layoutWidth, 1600);

  name.value = "Auto view";
  save.click();
  autoExploreToggle.click();
  await flush();
  update.click();
  autoExploreToggle.click();
  assert.equal(autoExploreStatus.textContent, "關");

  select.value = "Auto view";
  select.emit("change");
  await flush();
  assert.equal(autoExploreStatus.textContent, "開");
  assert.equal(plugin.unratedRequests, 2);
  assert.equal(
    JSON.parse(storage.getItem("bird-view-settings")).activePresetName,
    "Auto view",
  );

  assert.equal(deleteButton.disabled, false);
  deleteButton.click();
  assert.equal(select.value, "");
  assert.equal(toolbarSelect.value, "");
  assert.equal(toolbarSelect.disabled, false);
  assert.equal(deleteButton.disabled, true);
  assert.deepEqual(
    JSON.parse(storage.getItem("bird-view-presets")).presets.map(({ name }) => name),
    ["Focus view"],
  );

  const folderSearch = plugin.elements.get("#auto-explore-folder-search");
  const folderOptions = plugin.elements.get("#auto-explore-folder-options");
  folderSearch.value = "design";
  folderSearch.emit("input");
  folderOptions.children[0].click();
  name.value = "Folder view";
  save.click();

  const folderPreset = JSON.parse(storage.getItem("bird-view-presets")).presets.find(
    ({ name: presetName }) => presetName === "Folder view",
  );
  assert.deepEqual(folderPreset.settings.autoExploreFilter.folders, ["root"]);
  assert.equal(folderPreset.settings.autoExploreFilter.includeSubfolders, true);
});

test("restores the last active preset when the plugin starts", async () => {
  const storage = createStorage();
  storage.setItem(
    "bird-view-presets",
    JSON.stringify({
      version: 1,
      presets: [
        {
          name: "Focus view",
          settings: { board: { layoutWidth: 1600 } },
        },
      ],
    }),
  );
  storage.setItem(
    "bird-view-settings",
    JSON.stringify({
      version: 1,
      activePresetName: "Focus view",
      board: { layoutWidth: 900 },
    }),
  );

  const plugin = createPluginHarness({ selectedItems: [], storage });
  plugin.start();
  await flush();

  assert.equal(plugin.elements.get("#board-layout-width").value, "1600");
  assert.equal(plugin.elements.get("#settings-preset-select").value, "Focus view");
  assert.equal(plugin.elements.get("#toolbar-preset-select").value, "Focus view");
});

test("falls back to general settings when the last preset no longer exists", async () => {
  const storage = createStorage();
  storage.setItem("bird-view-presets", JSON.stringify({ version: 1, presets: [] }));
  storage.setItem(
    "bird-view-settings",
    JSON.stringify({
      version: 1,
      activePresetName: "Deleted view",
      board: { layoutWidth: 1400 },
    }),
  );

  const plugin = createPluginHarness({ selectedItems: [], storage });
  plugin.start();
  await flush();

  assert.equal(plugin.elements.get("#board-layout-width").value, "1400");
  assert.equal(plugin.elements.get("#settings-preset-select").value, "");
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPluginHarness } = require("../../test-support/plugin-harness.js");

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Starts the plugin with an empty Eagle selection, which is the state the board
// lands in when nothing is selected.
async function startEmptyPlugin() {
  const plugin = createPluginHarness({ selectedItems: [] });
  plugin.start();
  await flush();
  return plugin;
}

function pressKey(plugin, key, { repeat = false } = {}) {
  let prevented = false;
  plugin.keyDown({
    key,
    repeat,
    target: null,
    preventDefault() {
      prevented = true;
    },
  });
  return prevented;
}

function statusOf(plugin, selector) {
  return plugin.elements.get(selector).textContent;
}

test("the board asks Eagle for the selection and leaves auto exploration off", async () => {
  const plugin = await startEmptyPlugin();

  assert.equal(plugin.selectedRequests, 1);
  assert.equal(plugin.unratedRequests, 0);
  assert.equal(statusOf(plugin, "#auto-explore-status"), "關");
});

test("F11 toggles Eagle fullscreen and ignores auto-repeat", async () => {
  const plugin = await startEmptyPlugin();

  assert.equal(pressKey(plugin, "F11"), true);
  await flush();
  assert.equal(plugin.fullScreen, true);
  assert.equal(plugin.fullScreenCalls, 1);

  pressKey(plugin, "F11", { repeat: true });
  await flush();
  assert.equal(plugin.fullScreen, true);
  assert.equal(plugin.fullScreenCalls, 1);

  pressKey(plugin, "F11");
  await flush();
  assert.equal(plugin.fullScreen, false);
  assert.equal(plugin.fullScreenCalls, 2);
});

test("Insert toggles auto exploration and ignores auto-repeat", async () => {
  const plugin = await startEmptyPlugin();

  assert.equal(pressKey(plugin, "Insert"), true);
  await flush();
  assert.equal(statusOf(plugin, "#auto-explore-status"), "開");
  assert.equal(plugin.unratedRequests, 1);

  pressKey(plugin, "Insert", { repeat: true });
  await flush();
  assert.equal(statusOf(plugin, "#auto-explore-status"), "開");
  assert.equal(plugin.unratedRequests, 1);

  pressKey(plugin, "Insert");
  assert.equal(statusOf(plugin, "#auto-explore-status"), "關");
});

test("Delete toggles seamless mode and ignores auto-repeat", async () => {
  const plugin = await startEmptyPlugin();

  assert.equal(pressKey(plugin, "Delete"), true);
  assert.equal(statusOf(plugin, "#seamless-mode-status"), "開");

  pressKey(plugin, "Delete", { repeat: true });
  assert.equal(statusOf(plugin, "#seamless-mode-status"), "開");

  pressKey(plugin, "Delete");
  assert.equal(statusOf(plugin, "#seamless-mode-status"), "關");
});

test("the auto explore toggle button loads a row when switched on", async () => {
  const plugin = await startEmptyPlugin();

  plugin.elements.get("#auto-explore-toggle").click();
  await flush();

  assert.equal(statusOf(plugin, "#auto-explore-status"), "開");
  assert.equal(plugin.unratedRequests, 1);
});

test("reopening with a selection appends items instead of loading the selected folder", async () => {
  const plugin = createPluginHarness();
  plugin.start();
  plugin.resolveSelected(0, []);
  await flush();
  // The empty selection already consulted the folder source once.
  assert.equal(plugin.folderLoadRequests, 1);

  plugin.setFolderSourceResult({
    folders: [{ id: "selected-folder", name: "Folder" }],
    items: [{ id: "folder-item" }],
  });
  plugin.pluginRun();
  assert.equal(plugin.selectedRequests, 2);

  plugin.resolveSelected(1, [
    {
      id: "selected-item",
      name: "selected.jpg",
      ext: "jpg",
      width: 100,
      height: 100,
      fileURL: "file:///selected.jpg",
      thumbnailURL: "file:///selected-thumb.jpg",
    },
  ]);
  await flush();

  assert.equal(plugin.folderLoadRequests, 1, "selected items win over a selected folder");
  assert.equal(plugin.elements.get("#item-count").textContent, "1 個素材");
});

test("switching Eagle library reloads the selection", async () => {
  const plugin = await startEmptyPlugin();

  plugin.changeLibrary();

  assert.equal(plugin.selectedRequests, 2);
});

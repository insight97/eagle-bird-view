"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPluginHarness } = require("../test-support/plugin-harness.js");

test("auto exploration defaults off and a library change restarts selected item loading", async () => {
  const plugin = createPluginHarness();
  plugin.start();
  assert.equal(plugin.selectedRequests, 1);
  plugin.resolveSelected(0, []);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(plugin.unratedRequests, 0);
  assert.equal(plugin.elements.get("#auto-explore-status").textContent, "關");

  let prevented = false;
  plugin.keyDown({
    key: "F11",
    repeat: false,
    target: null,
    preventDefault() {
      prevented = true;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.equal(plugin.fullScreen, true);
  assert.equal(plugin.fullScreenCalls, 1);

  plugin.keyDown({ key: "F11", repeat: true, target: null, preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(plugin.fullScreen, true);
  assert.equal(plugin.fullScreenCalls, 1);

  plugin.keyDown({ key: "F11", repeat: false, target: null, preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(plugin.fullScreen, false);
  assert.equal(plugin.fullScreenCalls, 2);

  let insertPrevented = false;
  plugin.keyDown({
    key: "Insert",
    repeat: false,
    target: null,
    preventDefault() {
      insertPrevented = true;
    },
  });
  await Promise.resolve();
  assert.equal(insertPrevented, true);
  assert.equal(plugin.unratedRequests, 1);
  assert.equal(plugin.elements.get("#auto-explore-status").textContent, "開");

  plugin.keyDown({ key: "Insert", repeat: true, target: null, preventDefault() {} });
  await Promise.resolve();
  assert.equal(plugin.elements.get("#auto-explore-status").textContent, "開");

  plugin.keyDown({ key: "Insert", repeat: false, target: null, preventDefault() {} });
  assert.equal(plugin.elements.get("#auto-explore-status").textContent, "關");

  let deletePrevented = false;
  plugin.keyDown({
    key: "Delete",
    repeat: false,
    target: null,
    preventDefault() {
      deletePrevented = true;
    },
  });
  assert.equal(deletePrevented, true);
  assert.equal(plugin.elements.get("#seamless-mode-status").textContent, "開");

  plugin.keyDown({ key: "Delete", repeat: true, target: null, preventDefault() {} });
  assert.equal(plugin.elements.get("#seamless-mode-status").textContent, "開");

  plugin.keyDown({ key: "Delete", repeat: false, target: null, preventDefault() {} });
  assert.equal(plugin.elements.get("#seamless-mode-status").textContent, "關");

  plugin.elements.get("#auto-explore-toggle").click();
  await Promise.resolve();
  assert.equal(plugin.unratedRequests, 2);
  assert.equal(plugin.elements.get("#auto-explore-status").textContent, "開");

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
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(plugin.folderLoadRequests, 1);

  plugin.changeLibrary();
  assert.equal(plugin.selectedRequests, 3);
});

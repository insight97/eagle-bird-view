"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPluginHarness } = require("../../test-support/plugin-harness.js");

function flushPromises() {
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
}

function imageItem(id) {
  return {
    id,
    name: `${id}.jpg`,
    ext: "jpg",
    width: 1600,
    height: 1000,
    folders: ["shared-folder"],
    tags: [],
    fileURL: `file:///${id}.jpg`,
    thumbnailURL: `file:///${id}-thumb.jpg`,
  };
}

test("ignores folder names returned from a previous library", async () => {
  const plugin = createPluginHarness();
  plugin.start();

  plugin.resolveSelected(0, [imageItem("old-item")]);
  await flushPromises();
  assert.equal(plugin.folderRequests.length, 1);

  plugin.changeLibrary();
  plugin.resolveFolder(0, [{ id: "shared-folder", name: "Old library folder" }]);
  await flushPromises();

  plugin.resolveSelected(1, [imageItem("new-item")]);
  await flushPromises();

  assert.equal(plugin.folderRequests.length, 2);
  assert.equal(plugin.folderRequests[0][0], "shared-folder");
  assert.equal(plugin.folderRequests[1][0], "shared-folder");
});

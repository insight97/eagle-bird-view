"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPluginHarness } = require("../../test-support/plugin-harness.js");

const CAMERA_MOTION_IDLE = 180;

function labelledItem(overrides = {}) {
  const item = {
    id: "item-1",
    name: "photo.jpg",
    ext: "jpg",
    width: 1600,
    height: 1000,
    size: 5_000_000,
    star: 2,
    tags: ["UI", "Web"],
    folders: [],
    fileURL: "file:///fake/original.jpg",
    thumbnailURL: "file:///fake/thumb.jpg",
    saveCalls: 0,
    async save() {
      item.saveCalls += 1;
      return true;
    },
    ...overrides,
  };
  return item;
}

async function startWithItem(
  item,
  { quiet = false, navigationProbe = false, folderTree = [], tagSourceResult = [] } = {},
) {
  const plugin = createPluginHarness({
    selectedItems: [item],
    folderTree,
    tagSourceResult,
    runAnimationFrames: true,
    navigationProbe,
    quiet,
  });
  plugin.start();
  await new Promise((resolve) => setImmediate(resolve));
  plugin.advanceClock(CAMERA_MOTION_IDLE);
  plugin.flushTimers();
  return plugin;
}

function findLabel(plugin) {
  return plugin.createdElements.find((element) => element.classList.contains("media-label"));
}

test("a mounted media label renders the current rating and tags", async () => {
  const plugin = await startWithItem(labelledItem());
  const label = findLabel(plugin);
  assert.ok(label, "a media label should be mounted for the visible item");

  const stars = label.querySelectorAll(".media-rating-star");
  assert.equal(stars.length, 5);
  assert.deepEqual(
    stars.map((star) => star.classList.contains("is-filled")),
    [true, true, false, false, false],
  );

  const tags = label.querySelector(".media-tags");
  assert.equal(tags.hidden, false);
  assert.deepEqual(
    tags.querySelectorAll(".media-tag").map(({ textContent }) => textContent),
    ["UI", "Web"],
  );
});

test("the toolbar and media label expose tag and folder add controls", async () => {
  const plugin = await startWithItem(labelledItem(), { navigationProbe: true });
  const label = findLabel(plugin);

  assert.equal(plugin.elements.get("#selection-add-tag").hidden, false);
  assert.equal(plugin.elements.get("#selection-add-folder").hidden, false);
  assert.ok(label.querySelector(".media-metadata-add-tag"));
  assert.ok(label.querySelector(".media-metadata-add-folder"));

  plugin.elements.get("#selection-add-tag").click();
  plugin.elements.get("#selection-add-folder").click();
  label.querySelector(".media-metadata-add-folder").click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(plugin.tagEditorOpenCalls, 1);
  assert.equal(plugin.folderPickerOpenCalls, 2);
});

test("right-clicking a media label tag loads all matching contents", async () => {
  const item = labelledItem();
  const plugin = await startWithItem(item, {
    navigationProbe: true,
    tagSourceResult: [
      { id: "tag-item", name: "ui-reference.jpg", ext: "jpg", width: 100, height: 100 },
    ],
  });
  const label = findLabel(plugin);

  label.querySelector(".media-metadata-tag-target").emit("contextmenu");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(item.tags, ["UI", "Web"]);
  assert.equal(item.saveCalls, 0);
  assert.equal(plugin.tagLoadRequests, 1);
  assert.equal(plugin.elements.get("#item-count").textContent, "1 個素材");
});

test("restoring a board invalidates a pending metadata replacement", async () => {
  let resolveTag;
  const pendingTag = new Promise((resolve) => {
    resolveTag = resolve;
  });
  const plugin = await startWithItem(labelledItem(), {
    navigationProbe: true,
    tagSourceResult: pendingTag,
  });
  const label = findLabel(plugin);

  label.querySelector(".media-metadata-tag-target").emit("contextmenu");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(plugin.elements.get("#board-history-back-button").disabled, false);

  plugin.keyDown({
    key: "z",
    ctrlKey: true,
    target: null,
    preventDefault() {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(plugin.selectedNodeId, "item-1");

  resolveTag([{ id: "stale-tag-item", name: "stale.jpg", ext: "jpg", width: 100, height: 100 }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(plugin.selectedNodeId, "item-1");
  assert.equal(plugin.elements.get("#item-count").textContent, "1 個素材");
});

test("a media label right-click loads the folder contents without removing the folder", async () => {
  const item = labelledItem({ folders: ["folder-1"] });
  const plugin = await startWithItem(item, {
    navigationProbe: true,
    folderTree: [{ id: "folder-1", name: "Reference" }],
  });
  plugin.resolveFolder(0, [{ id: "folder-1", name: "Reference" }]);
  await new Promise((resolve) => setImmediate(resolve));
  plugin.setFolderSourceResult({
    folders: [{ id: "folder-1", name: "Reference" }],
    items: [{ id: "folder-item", name: "reference.jpg", ext: "jpg", width: 100, height: 100 }],
  });

  const label = findLabel(plugin);
  const folder = label.querySelector(".media-metadata-folder-target");
  assert.ok(folder);
  folder.emit("contextmenu");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(item.folders, ["folder-1"]);
  assert.equal(item.saveCalls, 0);
  assert.equal(plugin.folderSelectionRequests, 1);
  assert.equal(plugin.folderSelectionOptions[0].options.includeSubfolders, true);
  assert.equal(plugin.elements.get("#item-count").textContent, "1 個素材");
});

test("a folder route invalidates a pending Tag target", async () => {
  let resolveTag;
  const pendingTag = new Promise((resolve) => {
    resolveTag = resolve;
  });
  const plugin = await startWithItem(labelledItem(), {
    navigationProbe: true,
    folderTree: [{ id: "folder-1", name: "Reference" }],
    tagSourceResult: pendingTag,
  });
  plugin.setFolderSourceResult({
    folders: [{ id: "folder-1", name: "Reference" }],
    items: [{ id: "folder-item", name: "reference.jpg", ext: "jpg", width: 100, height: 100 }],
  });

  const label = findLabel(plugin);
  label.querySelector(".media-metadata-tag-target").emit("contextmenu");
  await new Promise((resolve) => setImmediate(resolve));

  plugin.elements.get("#folder-browser-tree").querySelectorAll(".folder-browser-item")[0].click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(plugin.state.folderContentIntake.snapshot().folders[0].id, "folder-1");

  resolveTag([{ id: "stale-tag-item", name: "stale.jpg", ext: "jpg", width: 100, height: 100 }]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(plugin.state.folderContentIntake.snapshot().folders[0].id, "folder-1");
});

test("clicking a rating star saves the item and repaints the label", async () => {
  const item = labelledItem();
  const plugin = await startWithItem(item);
  const label = findLabel(plugin);

  label.querySelectorAll(".media-rating-star")[3].click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(item.star, 4);
  assert.equal(item.saveCalls, 1);
  assert.deepEqual(
    label.querySelectorAll(".media-rating-star").map((star) => star.classList.contains("is-filled")),
    [true, true, true, true, false],
  );
  assert.equal(label.querySelector(".media-rating").getAttribute("aria-label"), "評分 4 顆星");
});

test("clicking a toolbar rating star saves the selected item", async () => {
  const item = labelledItem();
  const plugin = await startWithItem(item, { navigationProbe: true });
  const stars = plugin.elements.get("#selection-rating").querySelectorAll(".media-rating-star");

  stars[4].click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(item.star, 5);
  assert.equal(item.saveCalls, 1);
  assert.deepEqual(
    plugin.elements.get("#selection-rating").querySelectorAll(".media-rating-star")
      .map((star) => star.classList.contains("is-filled")),
    [true, true, true, true, true],
  );
  assert.equal(plugin.elements.get("#selection-rating").getAttribute("aria-label"), "評分 5 顆星");
});

test("right-clicking a toolbar tag loads all matching contents", async () => {
  const item = labelledItem();
  const plugin = await startWithItem(item, {
    navigationProbe: true,
    tagSourceResult: [
      { id: "tag-item", name: "ui-reference.jpg", ext: "jpg", width: 100, height: 100 },
    ],
  });
  const tag = plugin.state.selectionTagButtons[0];

  tag.emit("contextmenu");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(item.tags, ["UI", "Web"]);
  assert.equal(item.saveCalls, 0);
  assert.equal(plugin.tagLoadRequests, 1);
  assert.equal(plugin.elements.get("#item-count").textContent, "1 個素材");
});

test("right-clicking a toolbar folder loads its contents", async () => {
  const item = labelledItem({ folders: ["folder-1"] });
  const plugin = await startWithItem(item, {
    navigationProbe: true,
    folderTree: [{ id: "folder-1", name: "Reference" }],
  });
  plugin.resolveFolder(0, [{ id: "folder-1", name: "Reference" }]);
  await new Promise((resolve) => setImmediate(resolve));
  plugin.setFolderSourceResult({
    folders: [{ id: "folder-1", name: "Reference" }],
    items: [{ id: "folder-item", name: "reference.jpg", ext: "jpg", width: 100, height: 100 }],
  });

  const folder = plugin.elements.get("#selection-folders").querySelector(".selection-folder-target");
  folder.emit("contextmenu");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(item.folders, ["folder-1"]);
  assert.equal(item.saveCalls, 0);
  assert.equal(plugin.folderSelectionRequests, 1);
  assert.equal(plugin.elements.get("#item-count").textContent, "1 個素材");
});

test("a rejected save rolls the rating back on the label", async () => {
  const item = labelledItem({
    async save() {
      item.saveCalls += 1;
      return false;
    },
  });
  const plugin = await startWithItem(item, { quiet: true });
  const label = findLabel(plugin);

  label.querySelectorAll(".media-rating-star")[4].click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(item.saveCalls, 1);
  assert.equal(item.star, 2);
  assert.deepEqual(
    label.querySelectorAll(".media-rating-star").map((star) => star.classList.contains("is-filled")),
    [true, true, false, false, false],
  );
});

test("editing controls are disabled while a save is in flight", async () => {
  let releaseSave;
  const item = labelledItem({
    save() {
      item.saveCalls += 1;
      return new Promise((resolve) => {
        releaseSave = () => resolve(true);
      });
    },
  });
  const plugin = await startWithItem(item);
  const label = findLabel(plugin);

  label.querySelectorAll(".media-rating-star")[0].click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(label.classList.contains("is-saving"), true);
  assert.ok(
    label.querySelectorAll("[data-edit-control]").every(({ disabled }) => disabled),
    "rating stars and the tag button should be disabled while saving",
  );

  releaseSave();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(label.classList.contains("is-saving"), false);
  assert.ok(label.querySelectorAll("[data-edit-control]").every(({ disabled }) => !disabled));
});

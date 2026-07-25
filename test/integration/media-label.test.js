"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPluginHarness } = require("../../test-support/plugin-harness.js");

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

async function startWithItem(item, { quiet = false } = {}) {
  const plugin = createPluginHarness({
    selectedItems: [item],
    runAnimationFrames: true,
    quiet,
  });
  plugin.start();
  await new Promise((resolve) => setImmediate(resolve));
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
  assert.deepEqual(tags.children.map(({ textContent }) => textContent), ["UI", "Web"]);
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

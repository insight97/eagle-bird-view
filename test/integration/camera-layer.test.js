"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPluginHarness } = require("../../test-support/plugin-harness.js");

const CAMERA_SETTLE_DELAY = 200;

function jpgItem() {
  return {
    id: "item-1",
    name: "photo.jpg",
    ext: "jpg",
    width: 1600,
    height: 1000,
    size: 5_000_000,
    star: 0,
    tags: [],
    fileURL: "file:///fake/original.jpg",
    thumbnailURL: "file:///fake/thumb.jpg",
  };
}

// The compositor pins its raster scale while a will-change hint stands, so a
// board that keeps the hint after zooming in stays blurry however good the
// loaded image is. The hint has to be released once the camera stops.
test("the board layer drops its compositing hint once the camera settles", async () => {
  const plugin = createPluginHarness({
    selectedItems: [jpgItem()],
    runAnimationFrames: true,
  });
  plugin.start();
  await new Promise((resolve) => setImmediate(resolve));

  const world = plugin.elements.get("#world");
  assert.match(world.style.transform, /scale\(/, "the camera should have rendered");
  assert.equal(world.classList.contains("is-moving"), true);

  plugin.fireTimer(CAMERA_SETTLE_DELAY);

  assert.equal(world.classList.contains("is-moving"), false);
});

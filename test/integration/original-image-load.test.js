"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPluginHarness } = require("../../test-support/plugin-harness.js");

const ORIGINAL_IMAGE_LOAD_TIMEOUT = 8000;

function jpgItem(overrides = {}) {
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
    ...overrides,
  };
}

async function startWithItems(items, { viewportHeight } = {}) {
  const plugin = createPluginHarness({
    selectedItems: items,
    runAnimationFrames: true,
  });
  // Read while laying the board out, so it has to be set before the plugin starts.
  if (viewportHeight !== undefined) {
    plugin.elements.get("#viewport").clientHeight = viewportHeight;
  }
  plugin.start();
  await new Promise((resolve) => setImmediate(resolve));
  return plugin;
}

function startWithItem(item) {
  return startWithItems([item]);
}

test("a stalled original image load times out, offers retry, and recovers", async () => {
  const plugin = await startWithItem(jpgItem());

  const thumbnailImage = plugin.createdElementsOfTag("img")[0];
  assert.ok(thumbnailImage, "thumbnail <img> should have been created");
  const card = thumbnailImage.parentNode.parentNode;
  assert.equal(card.tagName, "ARTICLE");

  thumbnailImage.emit("load");

  const originalImage = plugin.createdElementsOfTag("img")[1];
  assert.ok(originalImage, "original <img> should start loading right after the thumbnail");
  assert.equal(originalImage.src, "file:///fake/original.jpg");
  assert.equal(card.dataset.mediaQuality, "loading-original");

  // The original never fires "load" or "error" (a stalled file:// request).
  // Only the watchdog timer can recover from this.
  plugin.fireTimer(ORIGINAL_IMAGE_LOAD_TIMEOUT);

  assert.equal(card.dataset.mediaQuality, "original-failed");
  const retryButton = card.querySelector(".original-retry-button");
  assert.ok(retryButton, "retry button should exist");
  assert.equal(retryButton.textContent, "原圖載入逾時，重試");

  retryButton.click();
  assert.equal(card.dataset.mediaQuality, "loading-original");

  const retriedImage = plugin.createdElementsOfTag("img").at(-1);
  assert.notEqual(retriedImage, originalImage);
  retriedImage.emit("load");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(card.dataset.mediaQuality, "original");
});

// The bounded raster is small enough to keep painting through a gesture, so the
// card no longer downgrades to the 320px thumbnail while the camera moves. That
// downgrade existed only to hide the cost of rastering a full-resolution master.
test("camera motion keeps painting the original at full quality", async () => {
  const plugin = await startWithItem(jpgItem());
  const viewport = plugin.elements.get("#viewport");
  viewport.emit("pointerdown", { button: 1, clientX: 0, clientY: 0 });
  plugin.windowEmit("pointerup");
  const thumbnailImage = plugin.createdElementsOfTag("img")[0];
  const card = thumbnailImage.parentNode.parentNode;

  thumbnailImage.emit("load");
  const originalImage = plugin.createdElementsOfTag("img")[1];
  originalImage.emit("load");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(card.dataset.mediaQuality, "original");
  assert.equal(thumbnailImage.style.visibility, "hidden");
  assert.equal(originalImage.style.visibility, "visible");

  viewport.emit("pointerdown", { button: 1, clientX: 0, clientY: 0 });
  assert.equal(originalImage.style.visibility, "visible");
  assert.equal(thumbnailImage.style.visibility, "hidden");
  assert.equal(card.dataset.mediaQuality, "original");

  plugin.windowEmit("pointerup");
  assert.equal(originalImage.style.visibility, "visible");
  assert.equal(thumbnailImage.style.visibility, "hidden");
  assert.equal(plugin.createdElementsOfTag("img").length, 2);
});

// A lone selection sits on an unjustified row at TARGET_ROW_HEIGHT while a
// filled row is shorter, so both boards are at 100% zoom here yet paint their
// first card at the same 72px. The quality tier has to follow the painted
// height, not the zoom ratio, or the selection count would decide it.
for (const count of [1, 8]) {
  test(`a card painting below the original threshold stays on the thumbnail (${count} selected)`, async () => {
    const items = Array.from({ length: count }, (_, index) =>
      jpgItem({ id: `item-${index}` }),
    );
    const plugin = await startWithItems(items, { viewportHeight: 200 });

    const thumbnailImage = plugin.createdElementsOfTag("img")[0];
    const card = thumbnailImage.parentNode.parentNode;
    assert.equal(thumbnailImage.src, "file:///fake/thumb.jpg");

    thumbnailImage.emit("load");

    assert.equal(card.dataset.mediaQuality, "thumbnail");
    assert.equal(
      plugin.createdElementsOfTag("img").filter(({ src }) => src === "file:///fake/original.jpg")
        .length,
      0,
      "no original should be requested for a card this small on screen",
    );
  });
}

test("a thumbnail that never loads still times out the pending original request", async () => {
  const plugin = await startWithItem(jpgItem({ id: "item-2" }));

  const thumbnailImage = plugin.createdElementsOfTag("img")[0];
  const card = thumbnailImage.parentNode.parentNode;

  // Simulate the thumbnail itself hanging: no "load" and no "error" ever fires.
  // The original quality request is still only "pending" at this point.
  assert.equal(card.dataset.mediaQuality, "loading-thumbnail");

  plugin.fireTimer(ORIGINAL_IMAGE_LOAD_TIMEOUT);

  assert.equal(card.dataset.mediaQuality, "original-failed");
  assert.equal(
    card.querySelector(".original-retry-button").textContent,
    "原圖載入逾時，重試",
  );
});

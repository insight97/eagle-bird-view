"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createPluginHarness } = require("../../test-support/plugin-harness.js");

const ROOT = path.resolve(__dirname, "..", "..");

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

// The board used to promote itself to its own compositor layer while the camera
// scaled, then release the hint once the camera settled. A will-change hint pins
// the compositor's raster scale, so for as long as it stood the board painted a
// stretched bitmap of the pre-zoom raster — zooming looked blurry however good
// the loaded image was. The hint was there to avoid re-rastering full-resolution
// masters every zoom frame, and bounding the rasters removed that cost: a trace
// of the bounded build measured RasterTask at 253ms across 7981 tasks. With
// nothing left to protect, the hint is pure blur, so the board no longer
// promotes at all and the compositor is free to re-raster at the live scale.
test("the board never takes a compositing hint while the camera scales", async () => {
  const plugin = createPluginHarness({
    selectedItems: [jpgItem()],
    runAnimationFrames: true,
  });
  plugin.start();
  await new Promise((resolve) => setImmediate(resolve));

  const world = plugin.elements.get("#world");
  assert.match(world.style.transform, /scale\(/, "the camera should have rendered");
  assert.equal(world.className, "", "nothing should be promoting the board at rest");

  // A scale change is what used to trigger the promotion, so drive one straight
  // through the render pass. The harness leaves a simulated frame pending;
  // clear it or updateCamera() treats the change as already scheduled.
  const zoomed = plugin.state.camera.scale * 2;
  plugin.state.camera = { ...plugin.state.camera, scale: zoomed };
  plugin.state.cameraFrame = null;
  plugin.updateCamera();

  assert.match(world.style.transform, new RegExp(`scale\\(${zoomed}\\)`));
  assert.equal(world.className, "", "a scale change must not promote the board");
});

test("smooth zoom leaves the board unpromoted too", async () => {
  const plugin = createPluginHarness({
    selectedItems: [],
    runAnimationFrames: true,
    smoothZoomProbe: true,
  });
  plugin.start();
  await new Promise((resolve) => setImmediate(resolve));

  plugin.state.smoothZoomEnabled = true;
  plugin.keyDown({
    key: "PageUp",
    ctrlKey: true,
    target: null,
    preventDefault() {},
  });

  const world = plugin.elements.get("#world");
  assert.equal(world.className, "");

  plugin.state.smoothZoomKeys.clear();
  plugin.state.cameraFrame = null;
  plugin.updateCamera();

  assert.equal(world.className, "");
});

// A standing hint in the stylesheet would pin the raster scale permanently,
// which is the same blur with no way to observe it from the plugin state.
test("no stylesheet rule leaves a standing hint on the board layer", () => {
  const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
  const worldRules = [...css.matchAll(/^\.world[^{]*\{([^}]*)\}/gm)].map(([, body]) => body);

  assert.ok(worldRules.length > 0, "styles.css should still define .world");
  for (const body of worldRules) {
    assert.doesNotMatch(body, /will-change/, "the board layer must not be promoted");
  }
});

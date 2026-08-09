"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_RASTER_DIMENSION,
  MIN_RASTER_DIMENSION,
  getNodeScreenLongEdge,
  getPreloadMargins,
  getRasterDimensionBudget,
  getRasterTargetSize,
} = require("../bird-view-core.js");

test("the raster budget climbs a ladder with a step inside each octave", () => {
  assert.equal(getRasterDimensionBudget(120), MIN_RASTER_DIMENSION);
  assert.deepEqual(
    [512, 513, 768, 769, 1024, 1025, 1536, 1537, 2048, 2049, 3072, 3073].map((needed) =>
      getRasterDimensionBudget(needed),
    ),
    [512, 768, 768, 1024, 1024, 1536, 1536, 2048, 2048, 3072, 3072, 4096],
  );

  // Every size within a step maps to the same budget, so nudging the camera
  // never re-rasters a card.
  for (const screenLongEdge of [1025, 1200, 1400, 1536]) {
    assert.equal(getRasterDimensionBudget(screenLongEdge), 1536);
  }
});

// The overshoot is pixels the card can never display, and they still cost
// memory and decode time. Every doubling point stays on the ladder, so this can
// only ever pick a smaller budget than doubling alone would have.
test("the ladder never overshoots by more than half, and never more than doubling", () => {
  for (let needed = 400; needed <= 4200; needed += 7) {
    const budget = getRasterDimensionBudget(needed);
    assert.ok(budget >= Math.min(needed, MAX_RASTER_DIMENSION), `undersampled at ${needed}`);

    let doubling = MIN_RASTER_DIMENSION;
    while (doubling < needed && doubling < MAX_RASTER_DIMENSION) doubling *= 2;
    doubling = Math.min(doubling, MAX_RASTER_DIMENSION);
    assert.ok(budget <= doubling, `${needed}: ${budget} is worse than doubling's ${doubling}`);

    if (needed >= MIN_RASTER_DIMENSION && budget < MAX_RASTER_DIMENSION) {
      assert.ok(budget / needed <= 1.5 + 1e-9, `${needed}: overshot to ${budget}`);
    }
  }
});

test("raster budget clamps rather than following an extreme zoom", () => {
  assert.equal(getRasterDimensionBudget(50_000), MAX_RASTER_DIMENSION);
  assert.equal(getRasterDimensionBudget(0), MIN_RASTER_DIMENSION);
  assert.equal(getRasterDimensionBudget(-10), MIN_RASTER_DIMENSION);
  assert.equal(getRasterDimensionBudget(Number.NaN), MIN_RASTER_DIMENSION);
  assert.equal(getRasterDimensionBudget(undefined), MIN_RASTER_DIMENSION);
});

test("an oversized master is bounded to the budget on its longest edge", () => {
  // The 5374x7589 painting from the profiled board: 40 MP, 156 MiB decoded.
  const target = getRasterTargetSize(5374, 7589, 400);

  assert.equal(target.budget, 512);
  assert.equal(target.height, 512);
  assert.equal(target.width, 363);
  assert.ok(
    target.width * target.height < (5374 * 7589) / 200,
    "the bounded raster should be orders of magnitude smaller than the master",
  );
});

test("a landscape master is bounded on its width", () => {
  const target = getRasterTargetSize(4000, 3000, 900);

  assert.equal(target.budget, 1024);
  assert.equal(target.width, 1024);
  assert.equal(target.height, 768);
});

test("a master already within budget is painted untouched", () => {
  assert.equal(getRasterTargetSize(320, 451, 400), null);
  assert.equal(getRasterTargetSize(512, 512, 400), null);
  // One pixel over the budget is still worth bounding.
  assert.ok(getRasterTargetSize(513, 400, 400));
});

test("unusable source dimensions do not produce a raster target", () => {
  assert.equal(getRasterTargetSize(0, 100, 400), null);
  assert.equal(getRasterTargetSize(100, 0, 400), null);
  assert.equal(getRasterTargetSize(undefined, undefined, 400), null);
  assert.equal(getRasterTargetSize(Number.NaN, 100, 400), null);
});

test("aspect ratio survives bounding", () => {
  const target = getRasterTargetSize(5374, 7589, 9000);
  const sourceRatio = 5374 / 7589;
  const targetRatio = target.width / target.height;

  assert.equal(target.budget, MAX_RASTER_DIMENSION);
  assert.ok(Math.abs(sourceRatio - targetRatio) < 0.001);
});

test("a still camera preloads an even band around the viewport", () => {
  const margins = getPreloadMargins(null, 120, 1400);
  assert.deepEqual(margins, { left: 120, right: 120, top: 120, bottom: 120 });

  const settled = getPreloadMargins({ x: 0, y: 0 }, 120, 1400);
  assert.deepEqual(settled, { left: 120, right: 120, top: 120, bottom: 120 });
});

test("the preload lead follows the direction the camera reveals content", () => {
  // A node sits at `camera.x + node.x * scale`, so a falling camera.x slides
  // nodes left and reveals content off the right edge.
  const revealingRight = getPreloadMargins({ x: -200, y: 0 }, 120, 1400);
  assert.equal(revealingRight.right, 520);
  assert.equal(revealingRight.left, 120);
  assert.equal(revealingRight.top, 120);
  assert.equal(revealingRight.bottom, 120);

  const revealingLeft = getPreloadMargins({ x: 200, y: 0 }, 120, 1400);
  assert.equal(revealingLeft.left, 520);
  assert.equal(revealingLeft.right, 120);

  const revealingBottom = getPreloadMargins({ x: 0, y: -150 }, 120, 1400);
  assert.equal(revealingBottom.bottom, 420);
  assert.equal(revealingBottom.top, 120);

  const revealingTop = getPreloadMargins({ x: 0, y: 150 }, 120, 1400);
  assert.equal(revealingTop.top, 420);
  assert.equal(revealingTop.bottom, 120);
});

test("a diagonal pan leads on both axes at once", () => {
  const margins = getPreloadMargins({ x: -100, y: -100 }, 120, 1400);
  assert.equal(margins.right, 320);
  assert.equal(margins.bottom, 320);
  assert.equal(margins.left, 120);
  assert.equal(margins.top, 120);
});

test("the lead is capped so it cannot reach past what is mounted", () => {
  const margins = getPreloadMargins({ x: -100_000, y: 100_000 }, 120, 1400);
  assert.equal(margins.right, 1520);
  assert.equal(margins.top, 1520);
});

test("unusable travel falls back to the standing band", () => {
  assert.deepEqual(getPreloadMargins({ x: Number.NaN, y: undefined }, 120, 1400), {
    left: 120,
    right: 120,
    top: 120,
    bottom: 120,
  });
  assert.deepEqual(getPreloadMargins({ x: -50, y: 0 }, 0, 0), {
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  });
});

// devicePixelRatio had no coverage at all: the only reader sat in plugin.js and
// every observation of this feature was made on a dpr 1 display, so the
// multiplication had never run with any other value.
test("the screen long edge is measured in device pixels", () => {
  const node = { width: 121, mediaHeight: 171 };

  assert.equal(getNodeScreenLongEdge(node, 2, 1), 342);
  assert.equal(getNodeScreenLongEdge(node, 2, 2), 684);
  assert.equal(getNodeScreenLongEdge(node, 2, 3), 1026);
  // The longest edge wins whichever way the card is oriented.
  assert.equal(getNodeScreenLongEdge({ width: 400, mediaHeight: 100 }, 1, 1), 400);
});

test("a HiDPI screen lands a card one budget step higher", () => {
  const node = { width: 121, mediaHeight: 171 };
  const scale = 2; // 342 CSS px along the long edge

  assert.equal(getRasterDimensionBudget(getNodeScreenLongEdge(node, scale, 1)), 512);
  assert.equal(getRasterDimensionBudget(getNodeScreenLongEdge(node, scale, 2)), 768);

  // Which is correct — the card really does paint twice as many pixels — but it
  // is also why the same board costs more raster memory there.
  const standard = getRasterTargetSize(5374, 7589, getNodeScreenLongEdge(node, scale, 1));
  const hiDpi = getRasterTargetSize(5374, 7589, getNodeScreenLongEdge(node, scale, 2));
  const growth = (hiDpi.width * hiDpi.height) / (standard.width * standard.height);
  assert.ok(Math.abs(growth - 2.25) < 0.01, `expected ~2.25x the pixels, got ${growth}`);
});

test("the ceiling is reached at half the CSS size on a HiDPI screen", () => {
  const node = { width: 1, mediaHeight: 2200 };

  assert.equal(getRasterDimensionBudget(getNodeScreenLongEdge(node, 1, 1)), 3072);
  assert.equal(getRasterDimensionBudget(getNodeScreenLongEdge(node, 1, 2)), MAX_RASTER_DIMENSION);
  // Past the ceiling the master is used untouched rather than rastered larger.
  assert.equal(getRasterTargetSize(3000, 4000, getNodeScreenLongEdge(node, 4, 2)), null);
});

test("an unusable pixel ratio falls back to one rather than zeroing the card", () => {
  const node = { width: 121, mediaHeight: 171 };

  assert.equal(getNodeScreenLongEdge(node, 2, 0), 342);
  assert.equal(getNodeScreenLongEdge(node, 2, -1), 342);
  assert.equal(getNodeScreenLongEdge(node, 2, Number.NaN), 342);
  assert.equal(getNodeScreenLongEdge(node, 2, undefined), 342);
});

test("a missing node or stopped camera reports no screen size", () => {
  assert.equal(getNodeScreenLongEdge(null, 2, 1), 0);
  assert.equal(getNodeScreenLongEdge({}, 2, 1), 0);
  assert.equal(getNodeScreenLongEdge({ width: 121, mediaHeight: 171 }, 0, 1), 0);
  assert.equal(getNodeScreenLongEdge({ width: 121, mediaHeight: 171 }, Number.NaN, 1), 0);
});

// When no bounded raster can be built the card has to choose between painting
// the master and staying on its thumbnail. Painting unconditionally is what put
// 40 MP masters into 130px cards at over 1000x oversample.

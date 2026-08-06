"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_RASTER_DIMENSION,
  MIN_RASTER_DIMENSION,
  getRasterDimensionBudget,
  getRasterTargetSize,
} = require("../bird-view-core.js");

test("raster budget grows in power-of-two steps so panning keeps one size", () => {
  assert.equal(getRasterDimensionBudget(120), MIN_RASTER_DIMENSION);
  assert.equal(getRasterDimensionBudget(512), 512);
  assert.equal(getRasterDimensionBudget(513), 1024);
  assert.equal(getRasterDimensionBudget(1024), 1024);
  assert.equal(getRasterDimensionBudget(1500), 2048);
  assert.equal(getRasterDimensionBudget(2049), 4096);

  // Every size within a step maps to the same budget, so nudging the camera
  // never re-rasters a card.
  for (const screenLongEdge of [520, 700, 900, 1024]) {
    assert.equal(getRasterDimensionBudget(screenLongEdge), 1024);
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

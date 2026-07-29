"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getVisibleTagCount } = require("../selection-tag-overflow.js");

test("visible tag count uses available width and leaves room for overflow button", () => {
  assert.equal(
    getVisibleTagCount([32, 40, 36], 122, { 1: 28, 2: 28, 3: 28 }),
    3,
  );
  assert.equal(
    getVisibleTagCount([32, 40, 36], 92, { 1: 28, 2: 28, 3: 28 }),
    1,
  );
  assert.equal(
    getVisibleTagCount([32, 40, 36], 36, { 1: 28, 2: 28, 3: 28 }),
    0,
  );
});

test("visible tag count is capped even when the toolbar has room", () => {
  assert.equal(
    getVisibleTagCount([24, 24, 24, 24], 200, { 1: 28, 2: 28, 3: 28, 4: 28 }),
    3,
  );
});

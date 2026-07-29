"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
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

test("visible tag count uses all available room when tags fit", () => {
  assert.equal(
    getVisibleTagCount([24, 24, 24, 24, 24, 24], 200, {
      1: 28,
      2: 28,
      3: 28,
      4: 28,
      5: 28,
      6: 28,
    }),
    6,
  );
});

test("selection tag targets keep their intrinsic width in a narrow toolbar", () => {
  const styles = fs.readFileSync(path.resolve(__dirname, "../styles.css"), "utf8");
  assert.match(
    styles,
    /\.selection-explore-target\s*\{[^}]*\bflex:\s*none\s*;/s,
    "selection tag buttons must not shrink into overlapping chips",
  );
});

test("selection filename is not capped while tags are present", () => {
  const styles = fs.readFileSync(path.resolve(__dirname, "../styles.css"), "utf8");
  const rule = styles.match(
    /\.selection-details\.has-selection-tags \.selection-name\s*\{([^}]*)\}/s,
  );
  assert.ok(rule, "the tag-aware filename rule should exist");
  assert.doesNotMatch(
    rule[1],
    /\bmax-width\s*:/,
    "filename should be allowed to use remaining toolbar space",
  );
});

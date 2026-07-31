"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_MAX_EXPLORATION_ITEMS,
  getAiExplorationItemLimit,
  MAX_EXPLORATION_ITEMS,
  MIN_EXPLORATION_ITEMS,
  MIN_LAYOUT_WIDTH,
  selectDiverseExplorationRow,
  selectAiExplorationItems,
  selectRandomExplorationRow,
  shouldLoadUnratedRow,
} = require("../bird-view-core.js");

function item(id, folders, tags, width = 200, height = 100) {
  return { id, folders, tags, width, height, ext: "jpg" };
}

test("AI exploration ratio converts the row limit into staged AI counts", () => {
  assert.equal(getAiExplorationItemLimit(12, 0), 0);
  assert.equal(getAiExplorationItemLimit(12, 25), 3);
  assert.equal(getAiExplorationItemLimit(12, 50), 6);
  assert.equal(getAiExplorationItemLimit(12, 75), 9);
  assert.equal(getAiExplorationItemLimit(12, 100), 12);
  assert.equal(getAiExplorationItemLimit(5, 25), 1);
});

test("AI exploration preserves the returned order without diversity scoring", () => {
  const candidates = [
    { item: item("first", [], []), aiScore: 0.72 },
    { item: item("second", ["unrelated"], ["unrelated"]), aiScore: 0.91 },
    { item: item("first", [], []), aiScore: 0.99 },
  ];

  assert.deepEqual(
    selectAiExplorationItems(candidates, 2).map(({ id }) => id),
    ["first", "second"],
  );
});

test("exploration prefers bridge items and excludes unrelated items", () => {
  const pivot = item("pivot", ["ui"], ["dark", "dashboard"]);
  const clone = item("clone", ["ui"], ["dark", "dashboard"]);
  const bridgeFolder = item("bridge-folder", ["ui", "web"], ["typography"]);
  const bridgeTag = item("bridge-tag", ["branding"], ["dashboard", "illustration"]);
  const unrelated = item("unrelated", ["photo"], ["portrait"]);
  const extras = [
    item("extra-1", ["ui", "motion"], ["animation"]),
    item("extra-2", ["editorial"], ["dark", "print"]),
    item("extra-3", ["ui", "desktop"], ["light"]),
  ];

  const selected = selectDiverseExplorationRow(
    [clone, bridgeFolder, bridgeTag, unrelated, ...extras],
    pivot,
    () => 0,
  );
  const ids = selected.map(({ id }) => id);

  assert.equal(ids.includes("unrelated"), false);
  assert.ok(ids.indexOf("bridge-folder") < ids.indexOf("clone") || !ids.includes("clone"));
  assert.ok(ids.indexOf("bridge-tag") < ids.indexOf("clone") || !ids.includes("clone"));
});

test("exploration balances different shared connections within one row", () => {
  const pivot = item("pivot", ["ui"], ["dark"]);
  const candidates = [
    item("tag-1", ["branding"], ["dark", "bold"]),
    item("tag-2", ["photo"], ["dark", "portrait"]),
    item("folder-1", ["ui"], ["light"]),
    item("folder-2", ["ui"], ["motion"]),
  ];

  const selected = selectDiverseExplorationRow(candidates, pivot, () => 0);
  assert.equal(selected.length, 4);
  assert.equal(selected.filter(({ folders }) => folders.includes("ui")).length, 2);
  assert.equal(selected.filter(({ tags }) => tags.includes("dark")).length, 2);
});

test("exploration caps novelty gain by folder and tag category", () => {
  const pivot = item("pivot", ["ui"], []);
  const manyTags = item(
    "many-tags",
    ["ui"],
    ["one", "two", "three", "four", "five"],
    1200,
    100,
  );
  const folderAndTag = item(
    "folder-and-tag",
    ["ui", "branding"],
    ["one"],
    1200,
    100,
  );

  const selected = selectDiverseExplorationRow([manyTags, folderAndTag], pivot, () => 0);

  assert.equal(selected[0], folderAndTag);
});

test("exploration stops as soon as candidates fill one justified row", () => {
  const pivot = item("pivot", ["ui"], []);
  const candidates = Array.from({ length: 10 }, (_, index) =>
    item(`item-${index}`, ["ui", `folder-${index}`], [`tag-${index}`]),
  );

  const selected = selectDiverseExplorationRow(candidates, pivot, () => 0);
  assert.equal(selected.length, 4);
});

test("exploration randomizes among the highest-ranked candidates", () => {
  const pivot = item("pivot", ["ui"], []);
  const candidates = ["a", "b", "c", "d"].map((id) =>
    item(id, ["ui", `folder-${id}`], [`tag-${id}`], 400, 100),
  );

  const fromStart = selectDiverseExplorationRow(candidates, pivot, () => 0);
  const fromEnd = selectDiverseExplorationRow(candidates, pivot, () => 0.999999);

  assert.deepEqual(fromStart.map(({ id }) => id), ["a", "b", "c"]);
  assert.deepEqual(fromEnd.map(({ id }) => id), ["d", "c", "b"]);
});

test("exploration randomizes candidates with equal relevance scores", () => {
  const pivot = item("pivot", ["ui"], []);
  const candidates = [
    item("new", ["ui"], []),
    item("old", ["ui"], []),
  ];
  const randomValues = [0.1, 0.9, 0];

  const selected = selectDiverseExplorationRow(
    candidates,
    pivot,
    () => randomValues.shift() ?? 0,
    1200,
    3,
  );

  assert.equal(selected[0].id, "old");
});

test("exploration respects the maximum number of AI candidates", () => {
  const pivot = item("pivot", ["ui"], []);
  const candidates = [
    item("related", ["ui", "web"], []),
    { item: item("ai-1", [], []), aiScore: 0.9 },
    { item: item("ai-2", [], []), aiScore: 0.8 },
  ];

  const selected = selectDiverseExplorationRow(
    candidates,
    pivot,
    () => 0,
    1200,
    3,
    { maxAiItems: 1 },
  );

  assert.equal(selected.filter(({ id }) => id.startsWith("ai-")).length, 1);
});

test("exploration can select a lower-ranked candidate from the weighted shortlist", () => {
  const pivot = item("pivot", ["ui"], []);
  const stronger = item("stronger", ["ui", "web"], ["bold", "dark"], 400, 100);
  const weaker = item("weaker", ["ui", "web"], [], 400, 100);

  const selected = selectDiverseExplorationRow([stronger, weaker], pivot, () => 0.999999);
  assert.equal(selected[0], weaker);
});

test("exploration weights the top five ranks and excludes the sixth", () => {
  const pivot = item("pivot", ["ui"], []);
  const candidates = Array.from({ length: 6 }, (_, index) =>
    item(
      `rank-${index + 1}`,
      ["ui", ...Array.from({ length: 6 - index }, (__, extra) => `folder-${index}-${extra}`)],
      [],
      1200,
      100,
    ),
  );

  const first = selectDiverseExplorationRow(candidates, pivot, () => 0.399999);
  const second = selectDiverseExplorationRow(candidates, pivot, () => 0.4);
  const fifth = selectDiverseExplorationRow(candidates, pivot, () => 0.999999);

  assert.equal(first[0].id, "rank-1");
  assert.equal(second[0].id, "rank-2");
  assert.equal(fifth[0].id, "rank-5");
  assert.notEqual(fifth[0].id, "rank-6");
});

test("random exploration selects enough items to fill one row", () => {
  const candidates = Array.from({ length: 10 }, (_, index) =>
    item(`item-${index}`, [], [], 200, 100),
  );

  const selected = selectRandomExplorationRow(candidates, () => 0);

  assert.equal(selected.length, 4);
  assert.deepEqual(selected.map(({ id }) => id), ["item-0", "item-1", "item-2", "item-3"]);
});

test("exploration row selection respects minimum and unlimited layout widths", () => {
  const candidates = Array.from({ length: 5 }, (_, index) =>
    item(`item-${index}`, [], [], 1600, 1000),
  );

  assert.equal(
    selectRandomExplorationRow(candidates, () => 0, MIN_LAYOUT_WIDTH).length,
    MIN_EXPLORATION_ITEMS,
  );
  assert.equal(selectRandomExplorationRow(candidates, () => 0, Infinity).length, candidates.length);
});

test("exploration selects at least the configured minimum when candidates are available", () => {
  const candidates = Array.from({ length: 5 }, (_, index) =>
    item(`item-${index}`, [], [], 400, 100),
  );

  assert.equal(selectRandomExplorationRow(candidates, () => 0).length, MIN_EXPLORATION_ITEMS);
});

test("exploration respects the configured maximum even with unlimited width", () => {
  const candidates = Array.from({ length: MAX_EXPLORATION_ITEMS + 5 }, (_, index) =>
    item(`item-${index}`, [], [], 1600, 1000),
  );

  assert.equal(
    selectRandomExplorationRow(candidates, () => 0, Infinity, DEFAULT_MAX_EXPLORATION_ITEMS).length,
    DEFAULT_MAX_EXPLORATION_ITEMS,
  );
  assert.equal(
    selectRandomExplorationRow(candidates, () => 0, Infinity, MAX_EXPLORATION_ITEMS).length,
    MAX_EXPLORATION_ITEMS,
  );
});

test("unrated exploration triggers from 80% zoom on the last row", () => {
  const rows = [
    { top: 0, bottom: 180 },
    { top: 212, bottom: 392 },
  ];
  const viewport = { width: 1200, height: 800 };

  assert.equal(shouldLoadUnratedRow(rows, { x: 0, y: 0, scale: 0.79 }, viewport, 1), false);
  assert.equal(shouldLoadUnratedRow(rows, { x: 0, y: 0, scale: 0.8 }, viewport, 1), true);
  assert.equal(shouldLoadUnratedRow(rows, { x: 0, y: 0, scale: 1 }, viewport, 1), true);
  assert.equal(shouldLoadUnratedRow(rows, { x: 0, y: 0, scale: 1.5 }, viewport, 1), true);
  assert.equal(shouldLoadUnratedRow(rows, { x: 0, y: -1000, scale: 1.5 }, viewport, 1), false);
});

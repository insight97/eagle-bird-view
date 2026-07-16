"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { selectDiverseExplorationRow } = require("../bird-view-core.js");

function item(id, folders, tags, width = 200, height = 100) {
  return { id, folders, tags, width, height, ext: "jpg" };
}

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

test("exploration stops as soon as candidates fill one justified row", () => {
  const pivot = item("pivot", ["ui"], []);
  const candidates = Array.from({ length: 10 }, (_, index) =>
    item(`item-${index}`, ["ui", `folder-${index}`], [`tag-${index}`]),
  );

  const selected = selectDiverseExplorationRow(candidates, pivot, () => 0);
  assert.equal(selected.length, 4);
});

test("exploration randomizes only among equally suitable candidates", () => {
  const pivot = item("pivot", ["ui"], []);
  const candidates = ["a", "b", "c", "d"].map((id) =>
    item(id, ["ui", `folder-${id}`], [`tag-${id}`], 400, 100),
  );

  const fromStart = selectDiverseExplorationRow(candidates, pivot, () => 0);
  const fromEnd = selectDiverseExplorationRow(candidates, pivot, () => 0.999999);

  assert.deepEqual(fromStart.map(({ id }) => id), ["a", "b"]);
  assert.deepEqual(fromEnd.map(({ id }) => id), ["d", "c"]);
});

test("exploration does not randomize a weaker candidate into the shortlist", () => {
  const pivot = item("pivot", ["ui"], []);
  const stronger = item("stronger", ["ui", "web"], ["bold", "dark"], 400, 100);
  const weaker = item("weaker", ["ui", "web"], [], 400, 100);

  const selected = selectDiverseExplorationRow([stronger, weaker], pivot, () => 0.999999);
  assert.equal(selected[0], stronger);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createFolderEntries } = require("../folder-picker.js");

test("createFolderEntries builds searchable paths from nested folders", () => {
  const entries = createFolderEntries([
    {
      id: "root",
      name: "Design",
      children: [{ id: "child", name: "References", parent: "root" }],
    },
    { id: "other", name: "Archive", parent: "root" },
  ]);

  assert.deepEqual(
    entries.map(({ path }) => path).sort(),
    ["Design", "Design / Archive", "Design / References"],
  );
  assert.equal(
    entries.find(({ path }) => path === "Design / References").folder.id,
    "child",
  );
});

test("createFolderEntries ignores duplicate folder IDs", () => {
  const entries = createFolderEntries([
    { id: "root", name: "Design", children: [{ id: "child", name: "Refs" }] },
    { id: "child", name: "Refs", parent: "root" },
  ]);

  assert.equal(entries.filter(({ folder }) => folder.id === "child").length, 1);
});

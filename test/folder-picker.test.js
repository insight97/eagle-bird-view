"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { FolderPicker, createFolderEntries } = require("../folder-picker.js");

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

test("committing multiple folders only applies values the user touched", async () => {
  const originalDocument = global.document;
  global.document = { removeEventListener() {} };
  const first = { item: { folders: ["shared", "first"] } };
  const second = { item: { folders: ["shared", "second"] } };
  const calls = [];
  const picker = new FolderPicker({
    onCommitMultiple: async (...args) => calls.push(args),
  });
  picker.session = {
    node: first,
    nodes: [first, second],
    multi: true,
    selected: new Set(["shared"]),
    mixed: new Set(["first", "second"]),
    touched: new Set(["first"]),
    initialByNode: new Map([
      [first, new Set(["shared", "first"])],
      [second, new Set(["shared", "second"])],
    ]),
    outsideHandler() {},
    editor: { remove() {} },
  };

  try {
    await picker.commit(picker.session);
    assert.deepEqual([...calls[0][1].get(first)], ["shared"]);
    assert.deepEqual([...calls[0][1].get(second)], ["shared", "second"]);
  } finally {
    global.document = originalDocument;
  }
});

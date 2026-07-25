"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { FolderPicker, createFolderEntries } = require("../folder-picker.js");
const { withDom } = require("../test-support/dom-harness.js");

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

test("folder picker filters folders and selects the active result with Enter", () =>
  withDom((window) => {
    const viewport = document.createElement("div");
    const anchor = document.createElement("button");
    const node = { item: { name: "Cover" } };
    const selections = [];
    viewport.append(anchor);
    document.body.append(viewport);

    const picker = new FolderPicker({
      getViewport: () => viewport,
      onSelect: (...args) => selections.push(args),
    });
    picker.open(node, anchor, [
      { id: "design", name: "Design", children: [{ id: "refs", name: "References" }] },
      { id: "archive", name: "Archive" },
    ]);

    assert.equal(viewport.querySelector("[role='dialog']"), picker.session.editor);
    assert.equal(picker.session.options.children.length, 3);

    picker.session.input.value = "references";
    picker.session.input.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(picker.session.actions.length, 1);
    assert.equal(picker.session.actions[0].element.textContent, "Design / References");

    picker.session.input.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );

    assert.deepEqual(selections, [[node, { id: "refs", name: "References" }]]);
    assert.equal(picker.session, null);
  }));

test("folder picker closes on Escape and outside pointerdown", () =>
  withDom((window) => {
    const viewport = document.createElement("div");
    const anchor = document.createElement("button");
    const node = { item: { name: "Cover" } };
    viewport.append(anchor);
    document.body.append(viewport);

    const picker = new FolderPicker({
      getViewport: () => viewport,
      onSelect() {},
    });
    picker.open(node, anchor, [{ id: "design", name: "Design" }]);
    picker.session.input.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    assert.equal(picker.session, null);

    picker.open(node, anchor, [{ id: "design", name: "Design" }]);
    document.body.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
    assert.equal(picker.session, null);
  }));

test("folder picker reports when there are no folders", () =>
  withDom(() => {
    const viewport = document.createElement("div");
    const emptyCalls = [];
    const picker = new FolderPicker({
      getViewport: () => viewport,
      onSelect() {},
      onEmpty: (...args) => emptyCalls.push(args),
    });
    const node = { item: { name: "Cover" } };

    assert.equal(picker.open(node, null, []), false);
    assert.deepEqual(emptyCalls, [[node]]);
    assert.equal(picker.session, null);
  }));

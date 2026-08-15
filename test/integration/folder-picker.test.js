"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { FolderPicker } = require("../../folder-picker.js");
const { withDom } = require("../../test-support/dom-harness.js");

test("folder picker keeps existing folders selected and commits additions/removals", () =>
  withDom(async (window) => {
    const viewport = document.createElement("div");
    const anchor = document.createElement("button");
    const node = { item: { name: "Cover", folders: ["refs"] } };
    const commits = [];
    viewport.append(anchor);
    document.body.append(viewport);

    const picker = new FolderPicker({
      getViewport: () => viewport,
      onSelectNode() {},
      onCommit: async (...args) => commits.push(args),
    });
    picker.open(node, anchor, [
      { id: "design", name: "Design", children: [{ id: "refs", name: "References" }] },
      { id: "archive", name: "Archive" },
    ]);

    assert.equal(viewport.querySelector("[role='dialog']"), picker.session.editor);
    assert.equal(picker.session.options.children.length, 3);
    assert.equal(
      picker.session.actions.find(({ element }) => element.textContent.includes("References"))
        .element.getAttribute("aria-pressed"),
      "true",
    );

    picker.session.input.value = "archive";
    picker.session.input.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(picker.session.actions.length, 1);
    assert.equal(picker.session.actions[0].element.textContent, "Archive");
    picker.session.actions[0].element.click();
    assert.deepEqual([...picker.session.selected], ["refs", "archive"]);

    const referencesAction = picker.session.actions.find(({ element }) =>
      element.textContent.includes("References"),
    );
    referencesAction.element.click();
    assert.deepEqual([...picker.session.selected], ["archive"]);

    picker.session.input.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await Promise.resolve();

    assert.deepEqual([...commits[0][0]], [[node, ["archive"]]]);
    assert.equal(picker.session, null);
  }));

test("folder picker prioritizes similarity before usage count", () =>
  withDom((window) => {
    const viewport = document.createElement("div");
    const anchor = document.createElement("button");
    const node = { item: { name: "Cover", folders: [] } };
    viewport.append(anchor);
    document.body.append(viewport);

    const picker = new FolderPicker({
      getViewport: () => viewport,
      onSelectNode() {},
    });
    picker.open(node, anchor, [
      { id: "ph", name: "Ph", count: 1 },
      { id: "phrone", name: "Phrone", count: 4 },
      { id: "phrons", name: "Phrons", count: 12 },
      { id: "xph", name: "Xph", count: 100 },
    ]);

    picker.session.input.value = "ph";
    picker.session.input.dispatchEvent(new window.Event("input", { bubbles: true }));

    assert.deepEqual(
      picker.session.actions.map(({ element }) => element.textContent),
      ["Phrons", "Phrone", "Ph", "Xph"],
    );
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
      onCommit() {},
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
      onCommit() {},
      onEmpty: (...args) => emptyCalls.push(args),
    });
    const node = { item: { name: "Cover" } };

    assert.equal(picker.open(node, null, []), false);
    assert.deepEqual(emptyCalls, [[node]]);
    assert.equal(picker.session, null);
  }));

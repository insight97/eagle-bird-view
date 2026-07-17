"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { TagEditor } = require("../tag-editor.js");
const { withDom } = require("../test-support/dom-harness.js");

function withDocumentStub(run) {
  const originalDocument = global.document;
  global.document = { removeEventListener() {} };
  return Promise.resolve()
    .then(run)
    .finally(() => {
      global.document = originalDocument;
    });
}

test("closing a tag editor removes its session and element", () =>
  withDocumentStub(() => {
    let removed = false;
    const node = {};
    const editor = new TagEditor({});
    editor.session = {
      node,
      outsideHandler() {},
      editor: { remove: () => { removed = true; } },
    };

    editor.closeForNode({});
    assert.equal(removed, false);
    editor.closeForNode(node);
    assert.equal(removed, true);
    assert.equal(editor.session, null);
  }));

test("committing unchanged tags only closes the editor", () =>
  withDocumentStub(async () => {
    let commits = 0;
    const node = { item: { tags: ["UI", "Photo"] } };
    const editor = new TagEditor({ onCommit: async () => { commits += 1; } });
    const session = {
      node,
      selected: new Set(["UI", "Photo"]),
      outsideHandler() {},
      editor: { remove() {} },
    };
    editor.session = session;

    await editor.commit(session);
    assert.equal(commits, 0);
    assert.equal(editor.session, null);
  }));

test("committing changed tags delegates persistence after closing", () =>
  withDocumentStub(async () => {
    const calls = [];
    const node = { item: { tags: ["UI"] } };
    const editor = new TagEditor({
      onCommit: async (...args) => calls.push(args),
    });
    const session = {
      node,
      selected: new Set(["UI", "Photo"]),
      outsideHandler() {},
      editor: { remove() {} },
    };
    editor.session = session;

    await editor.commit(session);
    assert.deepEqual(calls, [[node, ["UI", "Photo"], ["UI"]]]);
    assert.equal(editor.session, null);
  }));

test("tag editor opens, filters tags, selects a result, and commits with Enter", () =>
  withDom(async (window) => {
    const viewport = document.createElement("div");
    const anchor = document.createElement("button");
    const node = { item: { name: "Cover", tags: ["UI"] } };
    const commits = [];
    let selectedNode = null;
    viewport.append(anchor);
    document.body.append(viewport);

    const editor = new TagEditor({
      getViewport: () => viewport,
      getAvailableTags: () => ["Photo", "Web Design"],
      createTagChip: (tag) => {
        const chip = document.createElement("span");
        chip.textContent = tag;
        return chip;
      },
      onSelectNode: (selected) => { selectedNode = selected; },
      onCommit: async (...args) => commits.push(args),
    });
    editor.open(node, anchor);

    assert.equal(selectedNode, node);
    assert.equal(viewport.querySelector("[role='dialog']"), editor.session.editor);
    editor.session.input.value = "pho";
    editor.session.input.dispatchEvent(new window.Event("input", { bubbles: true }));
    const photoAction = editor.session.actions.find(({ element }) =>
      element.textContent.includes("Photo"),
    );
    assert.ok(photoAction);

    photoAction.element.click();
    assert.deepEqual([...editor.session.selected], ["UI", "Photo"]);
    editor.session.input.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await Promise.resolve();

    assert.deepEqual(commits, [[node, ["UI", "Photo"], ["UI"]]]);
    assert.equal(viewport.querySelector("[role='dialog']"), null);
  }));

test("tag editor closes when a pointer starts outside the dialog", () =>
  withDom((window) => {
    const viewport = document.createElement("div");
    const anchor = document.createElement("button");
    const node = { item: { name: "Cover", tags: [] } };
    viewport.append(anchor);
    document.body.append(viewport);
    const editor = new TagEditor({
      getViewport: () => viewport,
      getAvailableTags: () => [],
      createTagChip: () => document.createElement("span"),
      onSelectNode() {},
      onCommit() {},
    });
    editor.open(node, anchor);

    document.body.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));

    assert.equal(editor.session, null);
    assert.equal(viewport.querySelector("[role='dialog']"), null);
  }));

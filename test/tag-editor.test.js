"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { TagEditor } = require("../tag-editor.js");

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

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const core = require("../bird-view-core.js");
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

test("browser globals take priority over CommonJS shims in Eagle", () => {
  let requireCalls = 0;
  const module = { exports: {} };
  const source = fs.readFileSync(path.resolve(__dirname, "../tag-editor.js"), "utf8");
  const context = {
    BirdViewCore: core,
    module,
    require() {
      requireCalls += 1;
      throw new Error("browser script should not call require");
    },
  };

  vm.runInNewContext(source, context);

  assert.equal(requireCalls, 0);
  assert.equal(typeof context.BirdViewTagEditor.TagEditor, "function");
  assert.equal(module.exports, context.BirdViewTagEditor);
});

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

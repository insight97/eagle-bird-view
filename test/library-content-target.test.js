"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createLibraryContentTarget } = require("../library-content-target.js");
const { createRowLoadCoordinator } = require("../row-load-coordinator.js");

function createHarness({ itemApi = {}, folderApi = {}, folderTree = [], intake = {} } = {}) {
  return createLibraryContentTarget({
    itemApi,
    folderApi,
    getFolderTree: () => folderTree,
    intake: {
      async start() {
        return { status: "ready" };
      },
      async startFromItems() {
        return { status: "ready" };
      },
      ...intake,
    },
    loadCoordinator: createRowLoadCoordinator(),
  });
}

test("library content target filters Tag items and starts the shared intake", async () => {
  const events = [];
  const intakeCalls = [];
  const target = createHarness({
    itemApi: {
      async get(options) {
        events.push(["query", options]);
        return [
          { id: "valid", name: "valid.jpg" },
          { id: "deleted", isDeleted: true },
          { name: "missing-id" },
        ];
      },
    },
    intake: {
      async startFromItems(items, options) {
        intakeCalls.push({ items, options });
        return { status: "ready" };
      },
    },
  });

  const result = await target.load({
    type: "tag",
    value: " UI ",
    label: "UI",
    onBeforeStart() {
      events.push(["before"]);
    },
  });

  assert.equal(result.status, "loaded");
  assert.deepEqual(events, [["before"], ["query", { tags: ["UI"] }]]);
  assert.deepEqual(intakeCalls, [
    {
      items: [{ id: "valid", name: "valid.jpg" }],
      options: { focus: true },
    },
  ]);
});

test("library content target resolves nested folders before starting intake", async () => {
  const resolved = [];
  const intakeCalls = [];
  const folder = { id: "child", name: "Child" };
  const target = createHarness({
    folderTree: [{ id: "root", name: "Root", children: [folder] }],
    intake: {
      async start(options) {
        intakeCalls.push(options);
        return { status: "ready" };
      },
    },
  });

  const result = await target.load({
    type: "folder",
    value: " child ",
    label: "Child",
    onBeforeStart({ folder: selectedFolder }) {
      resolved.push(selectedFolder);
    },
  });

  assert.equal(result.status, "loaded");
  assert.deepEqual(resolved, [folder]);
  assert.deepEqual(intakeCalls, [{ folders: [folder], includeSubfolders: true }]);
});

test("library content target falls back to Eagle folder lookup", async () => {
  const folder = { id: "remote", name: "Remote" };
  const target = createHarness({
    folderApi: {
      async getById(id) {
        assert.equal(id, "remote");
        return folder;
      },
    },
  });

  const result = await target.load({ type: "folder", value: "remote", label: "Remote" });

  assert.equal(result.status, "loaded");
  assert.equal(result.folder, folder);
});

test("a newer library content target invalidates a late request", async () => {
  let releaseFirst;
  const firstDone = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const calls = [];
  const target = createHarness({
    itemApi: {
      async get({ tags }) {
        if (tags[0] === "first") await firstDone;
        return [{ id: tags[0] }];
      },
    },
    intake: {
      async startFromItems(items) {
        calls.push(items[0].id);
        return { status: "ready" };
      },
    },
  });

  const first = target.load({ type: "tag", value: "first" });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await target.load({ type: "tag", value: "second" });
  releaseFirst();
  const stale = await first;

  assert.equal(second.status, "loaded");
  assert.equal(stale.status, "stale");
  assert.deepEqual(calls, ["second"]);
});

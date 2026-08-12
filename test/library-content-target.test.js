"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createLibraryContentTarget } = require("../library-content-target.js");
const { createRowLoadCoordinator } = require("../row-load-coordinator.js");

function createHarness({ itemApi = {}, intake = {} } = {}) {
  return createLibraryContentTarget({
    itemApi,
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

test("library content target loads one file extension through the shared intake", async () => {
  const queries = [];
  const intakeCalls = [];
  const target = createHarness({
    itemApi: {
      async get(options) {
        queries.push(options);
        return [
          { id: "pdf", name: "guide.pdf", ext: "pdf" },
          { id: "deleted", ext: "pdf", isDeleted: true },
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
    type: "extension",
    value: ".PDF",
    label: "PDF",
  });

  assert.equal(result.status, "loaded");
  assert.deepEqual(queries, [{ ext: "pdf" }]);
  assert.deepEqual(intakeCalls, [
    {
      items: [{ id: "pdf", name: "guide.pdf", ext: "pdf" }],
      options: { focus: true },
    },
  ]);
});

test("library content target leaves folder sessions to the folder intake", async () => {
  const target = createHarness();

  const result = await target.load({ type: "folder", value: "folder-1" });

  assert.equal(result.status, "invalid");
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

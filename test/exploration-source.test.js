"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { RelatedItemSource } = require("../exploration-source.js");

test("findCandidates unions folder and tag results while excluding existing items", async () => {
  const calls = [];
  const api = {
    get: async (options) => {
      calls.push(options);
      if (options.folders) return [{ id: "folder-item" }, { id: "shared" }];
      return [{ id: "shared" }, { id: "tag-item" }, { id: "deleted", isDeleted: true }];
    },
    getByIds: async () => [],
  };
  const source = new RelatedItemSource(api);
  const pivot = { folders: ["ui", "ui"], tags: ["dark", "dark"] };

  const result = await source.findCandidates(pivot, new Set(["shared"]));
  assert.deepEqual(result.map(({ id }) => id), ["folder-item", "tag-item"]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].folders, ["ui"]);
  assert.deepEqual(calls[1].tags, ["dark"]);
  assert.ok(calls[0].fields.includes("width"));
});

test("findCandidates reuses cached folder and tag queries", async () => {
  let calls = 0;
  const source = new RelatedItemSource({
    get: async () => {
      calls += 1;
      return [{ id: "candidate" }];
    },
    getByIds: async () => [],
  });
  const pivot = { folders: ["ui"], tags: ["dark"] };

  await source.findCandidates(pivot);
  await source.findCandidates(pivot);
  assert.equal(calls, 2);

  source.clear();
  await source.findCandidates(pivot);
  assert.equal(calls, 4);
});

test("findCandidates limits the number of queries from heavily tagged items", async () => {
  let calls = 0;
  const source = new RelatedItemSource({
    get: async () => {
      calls += 1;
      return [];
    },
    getByIds: async () => [],
  });
  const pivot = {
    folders: Array.from({ length: 10 }, (_, index) => `folder-${index}`),
    tags: Array.from({ length: 20 }, (_, index) => `tag-${index}`),
  };

  await source.findCandidates(pivot);
  assert.equal(calls, 18);
});

test("hydrate preserves the selected exploration order", async () => {
  const source = new RelatedItemSource({
    get: async () => [],
    getByIds: async () => [{ id: "second", full: true }, { id: "first", full: true }],
  });

  const result = await source.hydrate([{ id: "first" }, { id: "second" }]);
  assert.deepEqual(result.map(({ id }) => id), ["first", "second"]);
});

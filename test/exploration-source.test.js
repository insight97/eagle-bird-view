"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { RelatedItemSource, UnratedItemSource } = require("../exploration-source.js");

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

test("findCandidates bounds cached results and stops after collecting enough candidates", async () => {
  const calls = [];
  const source = new RelatedItemSource({
    get: async (options) => {
      const connection = options.folders?.[0] || options.tags?.[0];
      calls.push(options);
      return Array.from({ length: 1000 }, (_, index) => ({
        id: `${connection}-${index}`,
        folders: options.folders || ["other"],
        tags: options.tags || ["other"],
      }));
    },
    getByIds: async () => [],
  });
  const pivot = {
    folders: Array.from({ length: 6 }, (_, index) => `folder-${index}`),
    tags: Array.from({ length: 12 }, (_, index) => `tag-${index}`),
  };

  const result = await source.findCandidates(pivot);

  assert.equal(result.length, 600);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].folders, ["folder-0"]);
  assert.deepEqual(calls[1].tags, ["tag-0"]);
  assert.deepEqual(calls[2].folders, ["folder-1"]);
});

test("hydrate preserves the selected exploration order", async () => {
  const source = new RelatedItemSource({
    get: async () => [],
    getByIds: async () => [{ id: "second", full: true }, { id: "first", full: true }],
  });

  const result = await source.hydrate([{ id: "first" }, { id: "second" }]);
  assert.deepEqual(result.map(({ id }) => id), ["first", "second"]);
});

test("unrated source queries rating zero and does not repeat selected items", async () => {
  const calls = [];
  const items = Array.from({ length: 8 }, (_, index) => ({
    id: `item-${index}`,
    width: 200,
    height: 100,
  }));
  const source = new UnratedItemSource({
    get: async (options) => {
      calls.push(options);
      return items;
    },
    getByIds: async () => [],
  }, () => 0);

  const first = await source.findNextRow(new Set(["item-0"]));
  const second = await source.findNextRow();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].rating, 0);
  assert.equal(first.length, 4);
  assert.equal(first.some(({ id }) => id === "item-0"), false);
  assert.equal(second.some(({ id }) => first.some((item) => item.id === id)), false);
});

test("clearing an unrated source invalidates an in-flight query", async () => {
  let resolveItems;
  const source = new UnratedItemSource({
    get: () => new Promise((resolve) => { resolveItems = resolve; }),
    getByIds: async () => [],
  });

  const pending = source.findNextRow();
  source.clear();
  resolveItems([{ id: "old-library", width: 200, height: 100 }]);

  assert.deepEqual(await pending, []);
});

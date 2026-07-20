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
  assert.ok(calls[0].fields.includes("star"));
  assert.equal(first.length, 4);
  assert.equal(first.some(({ id }) => id === "item-0"), false);
  assert.equal(second.some(({ id }) => first.some((item) => item.id === id)), false);
});

test("unrated source allows exploration without a tag filter", async () => {
  const calls = [];
  const source = new UnratedItemSource({
    get: async (options) => {
      calls.push(options);
      return [
        { id: "without-tags", width: 200, height: 100, star: 2, tags: [] },
        { id: "with-tags", width: 200, height: 100, star: 2, tags: ["UI"] },
      ];
    },
    getByIds: async () => [],
  }, () => 0);

  const result = await source.findNextRow(new Set(), {
    rating: 2,
    tags: [],
    maxTagCount: null,
  });

  assert.deepEqual(result.map(({ id }) => id), ["without-tags", "with-tags"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tags, undefined);
});

test("unrated source filters images and videos by file type", async () => {
  const calls = [];
  const items = [
    { id: "image", ext: "jpg", width: 200, height: 100 },
    { id: "video", ext: "mp4", width: 200, height: 100 },
  ];
  const source = new UnratedItemSource({
    get: async (options) => {
      calls.push(options);
      return options.ext ? items.filter(({ ext }) => ext === options.ext) : items;
    },
    getByIds: async () => [],
  }, () => 0);

  const imageResult = await source.findNextRow(new Set(), {
    fileTypes: ["image"],
    rating: "any",
  });
  assert.deepEqual(imageResult.map(({ id }) => id), ["image"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ext, undefined);

  source.clear();
  const videoResult = await source.findNextRow(new Set(), {
    fileTypes: ["video"],
    rating: "any",
  });
  assert.deepEqual(videoResult.map(({ id }) => id), ["video"]);
  assert.deepEqual(
    calls.slice(1).map(({ ext }) => ext),
    ["mp4", "m4v", "mov", "webm", "mkv"],
  );
});

test("unrated source applies rating, tag matching, and strict tag count filters", async () => {
  const calls = [];
  const items = [
    { id: "match", width: 200, height: 100, star: 3, tags: ["UI", "Photo"] },
    { id: "too-many-tags", width: 200, height: 100, star: 3, tags: ["UI", "Photo", "Brand"] },
    { id: "wrong-rating", width: 200, height: 100, star: 4, tags: ["UI", "Photo"] },
    { id: "missing-tag", width: 200, height: 100, star: 3, tags: ["UI"] },
    { id: "excluded-tag", width: 200, height: 100, star: 3, tags: ["UI", "Photo", "Archive"] },
  ];
  const source = new UnratedItemSource({
    get: async (options) => {
      calls.push(options);
      return items;
    },
    getByIds: async () => [],
  }, () => 0);

  const result = await source.findNextRow(new Set(), {
    rating: 3,
    tags: ["UI", "Photo"],
    excludedTags: ["Archive"],
    tagMatch: "all",
    maxTagCount: 3,
  });

  assert.deepEqual(result.map(({ id }) => id), ["match"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].rating, 3);
  assert.deepEqual(calls[0].tags, ["UI"]);
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

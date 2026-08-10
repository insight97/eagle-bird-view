"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AiSimilarItemSource,
  DEFAULT_UNRATED_FILTER,
  HybridExplorationSource,
  RelatedItemSource,
  UnratedItemSource,
  normalizeUnratedFilter,
  unratedFiltersEqual,
} = require("../exploration-source.js");

function mediaItem(id, overrides = {}) {
  return {
    id,
    ext: "jpg",
    width: 200,
    height: 100,
    folders: [],
    tags: [],
    ...overrides,
  };
}

test("normalizeUnratedFilter repairs every field of a stored filter", () => {
  assert.deepEqual(normalizeUnratedFilter(), {
    fileTypes: ["image", "video", "audio"],
    rating: "unrated",
    minRating: null,
    maxRating: null,
    folders: [],
    folderMatch: "any",
    includeSubfolders: true,
    tags: [],
    excludedTags: [],
    tagMatch: "any",
    tagGroups: [],
    tagGroupMatch: "any",
    maxTagCount: null,
  });

  assert.deepEqual(
    normalizeUnratedFilter({
      fileTypes: ["video", "audio"],
      rating: "3",
      minRating: "2",
      maxRating: "5",
      folders: ["root"],
      folderMatch: "all",
      includeSubfolders: false,
      tags: [" UI ", "UI", ""],
      excludedTags: ["Draft"],
      tagMatch: "all",
      tagGroups: [{ tags: [" Photo ", "Photo"], match: "any" }],
      tagGroupMatch: "all",
      maxTagCount: 2,
    }),
    {
      fileTypes: ["video", "audio"],
      rating: 3,
      minRating: 2,
      maxRating: 5,
      folders: ["root"],
      folderMatch: "all",
      includeSubfolders: false,
      tags: ["UI"],
      excludedTags: ["Draft"],
      tagMatch: "all",
      tagGroups: [{ tags: ["Photo"], match: "any" }],
      tagGroupMatch: "all",
      maxTagCount: 2,
    },
  );
});

test("normalizeUnratedFilter falls back on unusable values", () => {
  const filter = normalizeUnratedFilter({
    fileTypes: ["audio"],
    rating: 9,
    tagMatch: "either",
    maxTagCount: 0,
  });

  assert.deepEqual(filter.fileTypes, ["audio"]);
  assert.equal(filter.rating, "unrated");
  assert.equal(filter.minRating, null);
  assert.equal(filter.maxRating, null);
  assert.equal(filter.tagMatch, "any");
  assert.equal(filter.maxTagCount, null);
});

test("normalizeUnratedFilter accepts the legacy single fileType field", () => {
  assert.deepEqual(normalizeUnratedFilter({ fileType: "video" }).fileTypes, ["video"]);
  assert.deepEqual(
    normalizeUnratedFilter({ fileType: "any" }).fileTypes,
    ["image", "video", "audio"],
  );
});

test("unratedFiltersEqual compares filters after normalization", () => {
  assert.equal(unratedFiltersEqual(DEFAULT_UNRATED_FILTER, {}), true);
  assert.equal(unratedFiltersEqual({ rating: "3" }, { rating: 3 }), true);
  assert.equal(unratedFiltersEqual({ tags: ["UI"] }, { tags: ["UI", "UI"] }), true);
  assert.equal(unratedFiltersEqual({ rating: 3 }, { rating: 4 }), false);
  assert.equal(unratedFiltersEqual({ tags: ["UI"] }, { excludedTags: ["UI"] }), false);
});

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

test("findCandidates excludes non-media files", async () => {
  const source = new RelatedItemSource({
    get: async () => [
      { id: "image", ext: "jpg" },
      { id: "text", ext: "txt" },
    ],
    getByIds: async () => [],
  });

  const result = await source.findCandidates({ folders: ["ui"], tags: [] });

  assert.deepEqual(result.map(({ id }) => id), ["image"]);
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

test("AI source searches by pivot, caches ready results, and filters unsupported items", async () => {
  const calls = [];
  const source = new AiSimilarItemSource({
    isInstalled: async () => true,
    isReady: async () => true,
    searchByItemId: async (itemId, options) => {
      calls.push({ itemId, options });
      return {
        results: [
          { item: mediaItem("similar", { ext: "jpg" }), score: 0.82 },
          { item: mediaItem("excluded", { ext: "jpg" }), score: 0.7 },
          { item: mediaItem("text", { ext: "txt" }), score: 0.99 },
          { item: mediaItem("deleted", { ext: "jpg", isDeleted: true }), score: 0.95 },
        ],
      };
    },
  });

  const first = await source.findCandidates(
    { id: "pivot" },
    new Set(["excluded"]),
    { limit: 32 },
  );
  const second = await source.findCandidates({ id: "pivot" }, new Set(), { limit: 32 });

  assert.deepEqual(first.map(({ item, aiScore }) => [item.id, aiScore]), [["similar", 0.82]]);
  assert.deepEqual(second.map(({ item }) => item.id), ["similar", "excluded"]);
  const capped = await source.findCandidates(
    { id: "pivot" },
    new Set(),
    { limit: 32, maxSimilarity: 0.8 },
  );
  assert.deepEqual(capped.map(({ item }) => item.id), ["excluded"]);
  assert.deepEqual(calls, [{ itemId: "pivot", options: { limit: 32 } }]);
});

test("hybrid exploration forwards the AI similarity cap", async () => {
  let options;
  const hybrid = new HybridExplorationSource(
    {
      findCandidates: async () => [],
      hydrate: async (items) => items,
      clear() {},
    },
    {
      findCandidates: async (...args) => {
        options = args[2];
        return [];
      },
      clear() {},
    },
  );

  await hybrid.findCandidates(
    { id: "pivot" },
    new Set(),
    { aiEnabled: true, maxAiItems: 2, maxAiSimilarity: 0.75 },
  );

  assert.equal(options.maxSimilarity, 0.75);
});

test("AI source retries after the service becomes ready", async () => {
  let ready = false;
  let searches = 0;
  const source = new AiSimilarItemSource({
    isReady: async () => ready,
    searchByItemId: async () => {
      searches += 1;
      return { results: [{ item: mediaItem("similar"), score: 0.8 }] };
    },
  });

  assert.deepEqual(await source.findCandidates({ id: "pivot" }), []);
  ready = true;
  assert.deepEqual(
    (await source.findCandidates({ id: "pivot" })).map(({ item }) => item.id),
    ["similar"],
  );
  assert.equal(searches, 1);
});

test("hybrid exploration merges AI scores without duplicating related items", async () => {
  const related = mediaItem("related");
  const shared = mediaItem("shared");
  const hybrid = new HybridExplorationSource(
    {
      findCandidates: async () => [related, shared],
      hydrate: async (items) => items,
      clear() {},
    },
    {
      findCandidates: async () => [
        { item: shared, aiScore: 0.4 },
        { item: mediaItem("ai-only"), aiScore: 0.9 },
      ],
      clear() {},
    },
  );

  const result = await hybrid.findCandidates(
    { id: "pivot" },
    new Set(),
    { aiEnabled: true, maxAiItems: 2 },
  );

  assert.deepEqual(
    result.map(({ item, aiScore }) => [item.id, aiScore ?? null]),
    [["related", null], ["shared", 0.4], ["ai-only", 0.9]],
  );
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

test("unrated source excludes non-media files from image, video, and audio exploration", async () => {
  const source = new UnratedItemSource({
    get: async () => [
      { id: "image", ext: "jpg", width: 200, height: 100 },
      { id: "video", ext: "mp4", width: 200, height: 100 },
      { id: "audio", ext: "mp3", width: 200, height: 100 },
      { id: "text", ext: "txt", width: 200, height: 100 },
      { id: "document", ext: "pdf", width: 200, height: 100 },
    ],
    getByIds: async () => [],
  }, () => 0);

  const result = await source.findNextRow(new Set(), {
    fileTypes: ["image", "video", "audio"],
    rating: "any",
  });

  assert.deepEqual(result.map(({ id }) => id), ["image", "video", "audio"]);
});

test("unrated source filters images, videos, and audio by file type", async () => {
  const calls = [];
  const items = [
    { id: "image", ext: "jpg", width: 200, height: 100 },
    { id: "video", ext: "mp4", width: 200, height: 100 },
    { id: "audio", ext: "mp3", width: 200, height: 100 },
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
    fileTypes: ["video", "audio"],
    rating: "any",
  });
  assert.deepEqual(videoResult.map(({ id }) => id), ["video", "audio"]);
  assert.deepEqual(
    calls.slice(1).map(({ ext }) => ext),
    ["mp4", "m4v", "mov", "webm", "mkv", "mp3"],
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

test("unrated source applies rating ranges and folder include filters", async () => {
  const calls = [];
  const source = new UnratedItemSource(
    {
      get: async (options) => {
        calls.push(options);
        return [
          { id: "child-match", ext: "jpg", width: 200, height: 100, star: 3, folders: ["child"] },
          { id: "root-match", ext: "jpg", width: 200, height: 100, star: 4, folders: ["root"] },
          { id: "too-low", ext: "jpg", width: 200, height: 100, star: 2, folders: ["child"] },
          { id: "too-high", ext: "jpg", width: 200, height: 100, star: 5, folders: ["root"] },
        ];
      },
      getByIds: async () => [],
    },
    {
      async getAll() {
        return [
          {
            id: "root",
            children: [{ id: "child", parent: "root" }],
          },
        ];
      },
    },
    () => 0,
  );

  const result = await source.findNextRow(new Set(), {
    rating: "any",
    minRating: 3,
    maxRating: 4,
    folders: ["root"],
    includeSubfolders: true,
  });

  assert.deepEqual(result.map(({ id }) => id), ["child-match", "root-match"]);
  assert.deepEqual(calls.map(({ folders }) => folders), [["root"], ["child"]]);
});

test("unrated source falls back when the folder tree API throws synchronously", async () => {
  const calls = [];
  const source = new UnratedItemSource(
    {
      get: async (options) => {
        calls.push(options);
        return [];
      },
      getByIds: async () => [],
    },
    {
      getAll() {
        throw new TypeError("Class constructor Folder cannot be invoked without 'new'");
      },
    },
    () => 0,
  );

  const result = await source.findNextRow(new Set(), {
    rating: "any",
    folders: ["root"],
    includeSubfolders: true,
  });

  assert.deepEqual(result, []);
  assert.deepEqual(calls.map(({ folders }) => folders), [["root"]]);
});

test("unrated source does not treat an Eagle Folder class as the random function", async () => {
  class Folder {}
  Folder.getAll = async () => [];

  const source = new UnratedItemSource(
    {
      get: async () => [
        { id: "match", ext: "jpg", width: 200, height: 100, folders: ["root"] },
      ],
      getByIds: async () => [],
    },
    Folder,
    () => 0,
  );

  const result = await source.findNextRow(new Set(), {
    rating: "any",
    folders: ["root"],
    includeSubfolders: true,
  });

  assert.deepEqual(result.map(({ id }) => id), ["match"]);
});

test("unrated source combines tag groups with configurable boolean logic", async () => {
  const source = new UnratedItemSource({
    get: async () => [
      { id: "first-group", ext: "jpg", width: 200, height: 100, tags: ["A", "B"] },
      { id: "second-group", ext: "jpg", width: 200, height: 100, tags: ["C", "D"] },
      { id: "partial", ext: "jpg", width: 200, height: 100, tags: ["A"] },
    ],
    getByIds: async () => [],
  }, () => 0);

  const anyGroupResult = await source.findNextRow(new Set(), {
    rating: "any",
    tags: ["A", "B"],
    tagMatch: "all",
    tagGroups: [{ tags: ["C", "D"], match: "all" }],
    tagGroupMatch: "any",
  });
  assert.deepEqual(anyGroupResult.map(({ id }) => id), ["first-group", "second-group"]);

  source.clear();
  const allGroupsResult = await source.findNextRow(new Set(), {
    rating: "any",
    tags: ["A"],
    tagGroups: [{ tags: ["C"], match: "any" }],
    tagGroupMatch: "all",
  });
  assert.deepEqual(allGroupsResult.map(({ id }) => id), []);
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

test("clearing a related source invalidates an in-flight query", async () => {
  let resolveItems;
  const source = new RelatedItemSource({
    get: () => new Promise((resolve) => { resolveItems = resolve; }),
    getByIds: async () => [],
  });

  const pending = source.findCandidates({ folders: ["old-folder"], tags: [] });
  source.clear();
  resolveItems([{ id: "old-library", ext: "jpg" }]);

  assert.deepEqual(await pending, []);
});

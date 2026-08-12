"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { FolderItemSource } = require("../folder-item-source.js");

test("folder item source loads selected folders and nested children without duplicates", async () => {
  const queries = [];
  const itemApi = {
    async get(options) {
      queries.push(options);
      return options.folders.flatMap((folderId) =>
        ({
          root: [{ id: "root-item", name: "10.png", folders: [folderId] }],
          child: [
            { id: "child-item", name: "2.png", folders: [folderId] },
            { id: "shared", name: "1.png" },
          ],
          grandchild: [
            { id: "shared", name: "1.png" },
            { id: "deleted", name: "deleted.png", isDeleted: true },
          ],
        }[folderId] || []),
      );
    },
  };
  const folderApi = {
    async getSelected() {
      return [
        {
          id: "root",
          name: "Assets",
          children: [{ id: "child", children: [{ id: "grandchild" }] }],
        },
      ];
    },
  };

  const source = new FolderItemSource(itemApi, folderApi);
  const result = await source.loadSelected();

  assert.deepEqual(queries.map(({ folders }) => folders), [["root"], ["child"], ["grandchild"]]);
  assert.deepEqual(result.items.map(({ id }) => id), ["shared", "child-item", "root-item"]);
  assert.deepEqual(result.folders.map(({ id }) => id), ["root"]);
});

test("folder item source reports completed folder results before all queries finish", async () => {
  let releaseRoot;
  const rootDone = new Promise((resolve) => {
    releaseRoot = resolve;
  });
  const streamedItems = [];
  const source = new FolderItemSource(
    {
      async get({ folders }) {
        if (folders[0] === "root") await rootDone;
        return [{ id: `item-${folders[0]}`, name: `${folders[0]}.jpg` }];
      },
    },
    null,
  );
  const loading = source.loadFolders(
    [{ id: "root", children: [{ id: "child" }] }],
    { onItems: (items) => streamedItems.push(...items) },
  );

  await new Promise((resolve) => setImmediate(resolve));
  let assertionError = null;
  try {
    assert.deepEqual(streamedItems.map(({ id }) => id), ["item-child"]);
  } catch (error) {
    assertionError = error;
  } finally {
    releaseRoot();
  }
  await loading;
  if (assertionError) throw assertionError;
});

test("folder item source returns successful items and failed folder queries together", async () => {
  const source = new FolderItemSource(
    {
      async get({ folders }) {
        if (folders[0] === "broken") throw new Error("folder unavailable");
        return [{ id: `item-${folders[0]}`, name: `${folders[0]}.jpg` }];
      },
    },
    null,
  );

  const result = await source.loadFolders([
    { id: "working" },
    { id: "broken" },
  ]);

  assert.deepEqual(result.items.map(({ id }) => id), ["item-working"]);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].folderId, "broken");
});

test("folder item source hydrates a batch in the original order", async () => {
  const source = new FolderItemSource(
    {
      async getByIds(ids) {
        return ids
          .slice()
          .reverse()
          .map((id) => ({ id, fileURL: `${id}.jpg` }));
      },
    },
    null,
  );

  const result = await source.hydrate([{ id: "first" }, { id: "second" }]);

  assert.deepEqual(result.map(({ id }) => id), ["first", "second"]);
});

test("folder item source falls back to the selected-folder query", async () => {
  const source = new FolderItemSource(
    {
      async get({ folders }) {
        return [{ id: `item-${folders[0]}` }];
      },
    },
    {
      async get(options) {
        assert.deepEqual(options, { isSelected: true });
        return [{ id: "selected-folder" }];
      },
    },
  );

  const result = await source.loadSelected();

  assert.deepEqual(result.items.map(({ id }) => id), ["item-selected-folder"]);
});

test("folder item source does not repeat the query when getSelected is empty", async () => {
  let selectedCalls = 0;
  let queryUsed = false;
  const source = new FolderItemSource(
    {
      async get({ folders }) {
        return [{ id: `item-${folders[0]}` }];
      },
    },
    {
      async getSelected() {
        selectedCalls += 1;
        return [];
      },
      async get(options) {
        queryUsed = true;
        assert.deepEqual(options, { isSelected: true });
        return [{ id: "selected-folder" }];
      },
    },
  );

  const result = await source.loadSelected();

  assert.equal(selectedCalls, 1);
  assert.equal(queryUsed, false);
  assert.deepEqual(result, { folders: [], items: [] });
});

test("folder item source hydrates with the query API when getByIds is unavailable", async () => {
  const source = new FolderItemSource(
    {
      async get({ ids }) {
        return ids.map((id) => ({ id, fileURL: `${id}.jpg` }));
      },
    },
    null,
  );

  const result = await source.hydrate([{ id: "first" }, { id: "second" }]);

  assert.deepEqual(result.map(({ id }) => id), ["first", "second"]);
  assert.equal(result[0].fileURL, "first.jpg");
});

test("folder item source loads one folder without its descendants", async () => {
  const queriedFolderIds = [];
  const source = new FolderItemSource(
    {
      async get({ folders }) {
        queriedFolderIds.push(folders[0]);
        return [{ id: `item-${folders[0]}`, name: `${folders[0]}.jpg` }];
      },
    },
    null,
  );

  const folders = [{ id: "root", name: "Root", children: [{ id: "child" }] }];
  const result = await source.loadFolders(folders, { includeSubfolders: false });

  assert.deepEqual(queriedFolderIds, ["root"]);
  assert.deepEqual(result.folders, folders);
  assert.deepEqual(result.items.map(({ id }) => id), ["item-root"]);
});

test("folder item source limits concurrent Eagle folder queries", async () => {
  let activeQueries = 0;
  let peakQueries = 0;
  const releaseQueries = [];
  const source = new FolderItemSource(
    {
      async get({ folders }) {
        activeQueries += 1;
        peakQueries = Math.max(peakQueries, activeQueries);
        await new Promise((resolve) => releaseQueries.push(resolve));
        activeQueries -= 1;
        return [{ id: `item-${folders[0]}`, name: `${folders[0]}.jpg` }];
      },
    },
    null,
  );
  const folders = Array.from({ length: 8 }, (_, index) => ({ id: `folder-${index}` }));
  const loading = source.loadFolders(folders, { includeSubfolders: false });

  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(peakQueries <= 4);
  releaseQueries.splice(0).forEach((resolve) => resolve());
  await new Promise((resolve) => setImmediate(resolve));
  releaseQueries.splice(0).forEach((resolve) => resolve());
  await loading;
});

test("folder item source summarizes Tag, extension, and recursive folder counts", async () => {
  const queries = [];
  const source = new FolderItemSource(
    {
      async get(options) {
        queries.push(options);
        return [
          { id: "root-jpg", ext: "jpg", folders: ["root"], tags: ["UI"] },
          { id: "child-pdf", ext: "pdf", folders: ["child"], tags: ["UI", "Doc"] },
          { id: "shared-jpg", ext: "jpg", folders: ["root", "child"], tags: ["Shared"] },
          { id: "deleted-mp4", ext: "mp4", folders: ["other"], isDeleted: true },
          { id: "loose-webm", ext: "webm", folders: ["missing"], tags: ["Loose"] },
        ];
      },
    },
    null,
  );
  const folders = [
    { id: "root", children: [{ id: "child", children: [] }] },
    { id: "other", children: [] },
  ];

  const result = await source.loadLibrarySummary(folders);

  assert.deepEqual(queries, [
    { fields: ["id", "ext", "isDeleted", "tags", "folders"] },
  ]);
  assert.deepEqual(result.extensionCounts, new Map([
    ["jpg", 2],
    ["pdf", 1],
    ["webm", 1],
  ]));
  assert.deepEqual(result.tagCounts, new Map([
    ["UI", 2],
    ["Doc", 1],
    ["Shared", 1],
    ["Loose", 1],
  ]));
  assert.deepEqual(result.folderCounts, new Map([
    ["root", 2],
    ["child", 2],
    ["other", 0],
  ]));
  assert.deepEqual(result.recursiveFolderCounts, new Map([
    ["root", 3],
    ["child", 2],
    ["other", 0],
  ]));
});

test("folder item source reuses completed folder queries", async () => {
  let queryCount = 0;
  const source = new FolderItemSource(
    {
      async get({ folders }) {
        queryCount += 1;
        return [{ id: `item-${folders[0]}`, name: `${folders[0]}.jpg` }];
      },
    },
    null,
  );
  const folder = { id: "shared-folder", name: "Shared" };

  await source.loadFolders([folder]);
  await source.loadFolders([folder]);

  assert.equal(queryCount, 1);
  source.clear();
  await source.loadFolders([folder]);
  assert.equal(queryCount, 2);
});

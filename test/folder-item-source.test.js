"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { FolderItemSource } = require("../folder-item-source.js");

test("folder item source loads selected folders and nested children without duplicates", async () => {
  const queries = [];
  const itemApi = {
    async get(options) {
      const folderId = options.folders[0];
      queries.push(options);
      return {
        root: [{ id: "root-item", name: "10.png", folders: [folderId] }],
        child: [
          { id: "child-item", name: "2.png", folders: [folderId] },
          { id: "shared", name: "1.png" },
        ],
        grandchild: [
          { id: "shared", name: "1.png" },
          { id: "deleted", name: "deleted.png", isDeleted: true },
        ],
      }[folderId] || [];
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

  assert.deepEqual(queries.map(({ folders }) => folders[0]), ["root", "child", "grandchild"]);
  assert.deepEqual(result.items.map(({ id }) => id), ["shared", "child-item", "root-item"]);
  assert.deepEqual(result.folders.map(({ id }) => id), ["root"]);
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

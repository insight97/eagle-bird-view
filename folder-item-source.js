"use strict";

(function exposeBirdViewFolderSource(root, factory) {
  const source = factory();
  if (typeof module === "object" && module.exports) module.exports = source;
  root.BirdViewFolder = source;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const FOLDER_ITEM_FIELDS = Object.freeze([
    "id",
    "name",
    "ext",
    "isDeleted",
  ]);
  const ITEM_COLLATOR = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });
  const FOLDER_QUERY_CONCURRENCY = 4;

  class FolderItemSource {
    #itemApi;
    #folderApi;
    #folderQueryCache = new Map();

    constructor(itemApi, folderApi) {
      this.#itemApi = itemApi;
      this.#folderApi = folderApi;
    }

    async loadSelected() {
      if (typeof this.#itemApi?.get !== "function") {
        return { folders: [], items: [] };
      }

      const folders = await getSelectedFolders(this.#folderApi);
      return this.loadFolders(folders);
    }

    async loadFolders(folders, { includeSubfolders = true } = {}) {
      if (typeof this.#itemApi?.get !== "function") {
        return { folders: [], items: [] };
      }

      const folderIds = collectFolderIds(folders, { includeSubfolders });
      if (!folderIds.length) return { folders, items: [] };

      const responses = await queryFolders(
        (folderId) => this.#queryFolder(folderId),
        folderIds,
      );
      const itemsById = new Map();
      for (const items of responses) {
        for (const item of items || []) {
          if (item?.id && !item.isDeleted) itemsById.set(item.id, item);
        }
      }
      return { folders, items: [...itemsById.values()].sort(compareItems) };
    }

    async hydrate(items) {
      if (!items.length) return [];
      const ids = items.map(({ id }) => id);
      const hydrated =
        typeof this.#itemApi?.getByIds === "function"
          ? await this.#itemApi.getByIds(ids)
          : typeof this.#itemApi?.get === "function"
            ? await this.#itemApi.get({ ids })
            : items;
      const hydratedById = new Map((hydrated || []).map((item) => [item.id, item]));
      return items.map(({ id }) => hydratedById.get(id)).filter(Boolean);
    }

    clear() {
      this.#folderQueryCache.clear();
    }

    #queryFolder(folderId) {
      if (this.#folderQueryCache.has(folderId)) {
        return this.#folderQueryCache.get(folderId);
      }

      const request = Promise.resolve(
        this.#itemApi.get({ folders: [folderId], fields: FOLDER_ITEM_FIELDS }),
      )
        .then((items) => items || [])
        .catch((error) => {
          this.#folderQueryCache.delete(folderId);
          throw error;
        });
      this.#folderQueryCache.set(folderId, request);
      return request;
    }
  }

  async function getSelectedFolders(folderApi) {
    if (typeof folderApi?.getSelected === "function") {
      return (await folderApi.getSelected()) || [];
    }
    if (typeof folderApi?.get === "function") {
      return (await folderApi.get({ isSelected: true })) || [];
    }
    return [];
  }

  function collectFolderIds(folders, { includeSubfolders = true } = {}) {
    const folderIds = [];
    const seen = new Set();
    const visit = (folder) => {
      const id = String(folder?.id || "").trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      folderIds.push(id);
      if (includeSubfolders) {
        for (const child of folder?.children || []) visit(child);
      }
    };
    for (const folder of folders) visit(folder);
    return folderIds;
  }

  function compareItems(first, second) {
    const nameOrder = ITEM_COLLATOR.compare(
      String(first?.name || ""),
      String(second?.name || ""),
    );
    if (nameOrder !== 0) return nameOrder;

    const extensionOrder = ITEM_COLLATOR.compare(
      String(first?.ext || ""),
      String(second?.ext || ""),
    );
    if (extensionOrder !== 0) return extensionOrder;
    return String(first?.id || "").localeCompare(String(second?.id || ""));
  }

  async function queryFolders(queryFolder, folderIds) {
    const responses = new Array(folderIds.length);
    let nextIndex = 0;
    const workerCount = Math.min(FOLDER_QUERY_CONCURRENCY, folderIds.length);

    async function worker() {
      while (nextIndex < folderIds.length) {
        const index = nextIndex;
        nextIndex += 1;
        responses[index] = await queryFolder(folderIds[index]);
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return responses;
  }

  return Object.freeze({ FolderItemSource });
});

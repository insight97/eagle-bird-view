"use strict";

(function exposeExplorationSource(root, factory) {
  const exploration = factory();
  if (typeof module === "object" && module.exports) module.exports = exploration;
  root.BirdViewExploration = exploration;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const MAX_FOLDER_QUERIES = 6;
  const MAX_TAG_QUERIES = 12;
  const INDEX_FIELDS = [
    "id",
    "name",
    "ext",
    "width",
    "height",
    "folders",
    "tags",
    "importedAt",
    "isDeleted",
  ];

  class RelatedItemSource {
    #cache = new Map();
    #itemApi;

    constructor(itemApi) {
      this.#itemApi = itemApi;
    }

    async findCandidates(pivot, excludedIds = new Set()) {
      const queries = [];
      for (const folderId of uniqueValues(pivot.folders).slice(0, MAX_FOLDER_QUERIES)) {
        queries.push(this.#query(`folder:${folderId}`, { folders: [folderId] }));
      }
      for (const tag of uniqueValues(pivot.tags).slice(0, MAX_TAG_QUERIES)) {
        queries.push(this.#query(`tag:${tag}`, { tags: [tag] }));
      }
      if (!queries.length) return [];

      const itemsById = new Map();
      for (const items of await Promise.all(queries)) {
        for (const item of items) {
          if (!item?.id || item.isDeleted || excludedIds.has(item.id)) continue;
          itemsById.set(item.id, item);
        }
      }
      return [...itemsById.values()];
    }

    async hydrate(items) {
      if (!items.length) return [];
      const hydrated = await this.#itemApi.getByIds(items.map(({ id }) => id));
      const hydratedById = new Map(hydrated.map((item) => [item.id, item]));
      return items.map(({ id }) => hydratedById.get(id)).filter(Boolean);
    }

    clear() {
      this.#cache.clear();
    }

    #query(cacheKey, conditions) {
      if (this.#cache.has(cacheKey)) return this.#cache.get(cacheKey);
      const request = this.#itemApi
        .get({ ...conditions, fields: INDEX_FIELDS })
        .catch((error) => {
          this.#cache.delete(cacheKey);
          throw error;
        });
      this.#cache.set(cacheKey, request);
      return request;
    }
  }

  function uniqueValues(values = []) {
    return [...new Set(values.filter(Boolean))];
  }

  return Object.freeze({ RelatedItemSource });
});

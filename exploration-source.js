"use strict";

(function exposeExplorationSource(root, factory) {
  const hasCommonJS = typeof module === "object" && module.exports;
  const core =
    root.BirdViewCore ||
    (hasCommonJS && typeof require === "function" ? require("./bird-view-core.js") : null);
  const exploration = factory(core);
  if (typeof module === "object" && module.exports) module.exports = exploration;
  root.BirdViewExploration = exploration;
})(typeof globalThis === "object" ? globalThis : this, (core) => {
  const { selectRandomExplorationRow } = core;
  const MAX_FOLDER_QUERIES = 6;
  const MAX_TAG_QUERIES = 12;
  const MAX_CACHED_ITEMS_PER_QUERY = 240;
  const MAX_CANDIDATES = 600;
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
      const queries = interleave(
        uniqueValues(pivot.folders)
          .slice(0, MAX_FOLDER_QUERIES)
          .map((folderId) => [`folder:${folderId}`, { folders: [folderId] }]),
        uniqueValues(pivot.tags)
          .slice(0, MAX_TAG_QUERIES)
          .map((tag) => [`tag:${tag}`, { tags: [tag] }]),
      );

      const itemsById = new Map();
      for (const [cacheKey, conditions] of queries) {
        const items = await this.#query(cacheKey, conditions);
        for (const item of items) {
          if (!item?.id || item.isDeleted || excludedIds.has(item.id)) continue;
          itemsById.set(item.id, item);
          if (itemsById.size >= MAX_CANDIDATES) break;
        }
        if (itemsById.size >= MAX_CANDIDATES) break;
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
        .then((items) => sampleEvenly(items, MAX_CACHED_ITEMS_PER_QUERY))
        .catch((error) => {
          this.#cache.delete(cacheKey);
          throw error;
        });
      this.#cache.set(cacheKey, request);
      return request;
    }
  }

  class UnratedItemSource {
    #items = null;
    #itemApi;
    #random;
    #generation = 0;

    constructor(itemApi, random = Math.random) {
      this.#itemApi = itemApi;
      this.#random = random;
    }

    async findNextRow(excludedIds = new Set()) {
      const generation = this.#generation;
      if (!this.#items) {
        this.#items = this.#itemApi
          .get({ rating: 0, fields: INDEX_FIELDS })
          .catch((error) => {
            if (generation === this.#generation) this.#items = null;
            throw error;
          });
      }
      const items = await this.#items;
      if (generation !== this.#generation) return [];
      const available = items.filter(
        (item) => item?.id && !item.isDeleted && !excludedIds.has(item.id),
      );
      const selected = selectRandomExplorationRow(available, this.#random);
      if (selected.length) {
        const selectedIds = new Set(selected.map(({ id }) => id));
        this.#items = Promise.resolve(items.filter(({ id }) => !selectedIds.has(id)));
      }
      return selected;
    }

    async hydrate(items) {
      if (!items.length) return [];
      const hydrated = await this.#itemApi.getByIds(items.map(({ id }) => id));
      const hydratedById = new Map(hydrated.map((item) => [item.id, item]));
      return items.map(({ id }) => hydratedById.get(id)).filter(Boolean);
    }

    clear() {
      this.#generation += 1;
      this.#items = null;
    }
  }

  function uniqueValues(values = []) {
    return [...new Set(values.filter(Boolean))];
  }

  function interleave(first, second) {
    const values = [];
    const length = Math.max(first.length, second.length);
    for (let index = 0; index < length; index += 1) {
      if (index < first.length) values.push(first[index]);
      if (index < second.length) values.push(second[index]);
    }
    return values;
  }

  function sampleEvenly(items, limit) {
    if (!Array.isArray(items) || items.length <= limit) return items || [];
    const sampled = [];
    const step = items.length / limit;
    for (let index = 0; index < limit; index += 1) {
      sampled.push(items[Math.floor(index * step)]);
    }
    return sampled;
  }

  return Object.freeze({ RelatedItemSource, UnratedItemSource });
});

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
  const {
    VIDEO_EXTENSIONS,
    getItemRating,
    normalizeTags,
    selectRandomExplorationRow,
  } = core;
  const MAX_FOLDER_QUERIES = 6;
  const MAX_TAG_QUERIES = 12;
  const MAX_CACHED_ITEMS_PER_QUERY = 240;
  const MAX_CANDIDATES = 600;
  const FILE_TYPES = Object.freeze(["image", "video"]);
  const IMAGE_EXTENSIONS = new Set([
    "avif",
    "bmp",
    "gif",
    "heic",
    "heif",
    "ico",
    "jpeg",
    "jpg",
    "png",
    "svg",
    "tif",
    "tiff",
    "webp",
  ]);
  const DEFAULT_UNRATED_FILTER = Object.freeze({
    fileTypes: Object.freeze(["image", "video"]),
    rating: "unrated",
    tags: Object.freeze([]),
    excludedTags: Object.freeze([]),
    tagMatch: "any",
    maxTagCount: null,
  });
  const INDEX_FIELDS = [
    "id",
    "name",
    "ext",
    "width",
    "height",
    "star",
    "folders",
    "tags",
    "importedAt",
    "isDeleted",
  ];

  class RelatedItemSource {
    #cache = new Map();
    #itemApi;
    #generation = 0;

    constructor(itemApi) {
      this.#itemApi = itemApi;
    }

    async findCandidates(pivot, excludedIds = new Set()) {
      const generation = this.#generation;
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
        if (generation !== this.#generation) return [];
        for (const item of items) {
          if (
            !item?.id ||
            item.isDeleted ||
            excludedIds.has(item.id) ||
            !isSupportedMediaItem(item)
          ) {
            continue;
          }
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
      this.#generation += 1;
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
    #filterKey = null;

    constructor(itemApi, random = Math.random) {
      this.#itemApi = itemApi;
      this.#random = random;
    }

    async findNextRow(
      excludedIds = new Set(),
      filter = DEFAULT_UNRATED_FILTER,
      layoutWidth,
      maxItems,
    ) {
      const normalizedFilter = normalizeUnratedFilter(filter);
      const filterKey = JSON.stringify(normalizedFilter);
      if (this.#filterKey !== filterKey) {
        this.#generation += 1;
        this.#filterKey = filterKey;
        this.#items = null;
      }
      const generation = this.#generation;
      if (!this.#items) {
        this.#items = loadFilteredItems(this.#itemApi, normalizedFilter)
          .catch((error) => {
            if (generation === this.#generation) this.#items = null;
            throw error;
          });
      }
      const items = await this.#items;
      if (generation !== this.#generation) return [];
      const available = items.filter(
        (item) => isEligibleItem(item, excludedIds, normalizedFilter),
      );
      const selected = selectRandomExplorationRow(
        available,
        this.#random,
        layoutWidth,
        maxItems,
      );
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
      this.#filterKey = null;
    }
  }

  function normalizeUnratedFilter(filter = DEFAULT_UNRATED_FILTER) {
    const fileTypes = normalizeFileTypes(filter);
    const rating =
      filter.rating === "any" || filter.rating === "unrated" || [1, 2, 3, 4, 5].includes(Number(filter.rating))
        ? filter.rating === "any" || filter.rating === "unrated"
          ? filter.rating
          : Number(filter.rating)
        : DEFAULT_UNRATED_FILTER.rating;
    const maxTagCount = Number(filter.maxTagCount);
    return {
      fileTypes,
      rating,
      tags: normalizeTags(filter.tags),
      excludedTags: normalizeTags(filter.excludedTags),
      tagMatch: filter.tagMatch === "all" ? "all" : "any",
      maxTagCount: Number.isInteger(maxTagCount) && maxTagCount >= 1 ? maxTagCount : null,
    };
  }

  async function loadFilteredItems(itemApi, filter) {
    const rating = filter.rating === "any" ? {} : { rating: filter.rating === "unrated" ? 0 : filter.rating };
    const fields = { fields: INDEX_FIELDS };
    if (!filter.tags.length) {
      if (!filter.fileTypes.includes("video") || filter.fileTypes.includes("image")) {
        return itemApi.get({ ...rating, ...fields });
      }
      const results = await Promise.all(
        [...VIDEO_EXTENSIONS].map((ext) => itemApi.get({ ...rating, ext, ...fields })),
      );
      return results.flatMap((items) => items || []);
    }

    const queryTags = filter.tagMatch === "all" ? filter.tags.slice(0, 1) : filter.tags;
    const results = await Promise.all(
      queryTags.map((tag) => itemApi.get({ ...rating, tags: [tag], ...fields })),
    );
    const itemsById = new Map();
    for (const items of results) {
      for (const item of items || []) {
        if (item?.id) itemsById.set(item.id, item);
      }
    }
    return [...itemsById.values()];
  }

  function isEligibleItem(item, excludedIds, filter) {
    if (!item?.id || item.isDeleted || excludedIds.has(item.id)) return false;
    const fileType = getItemFileType(item);
    if (!fileType || !filter.fileTypes.includes(fileType)) return false;
    if (filter.rating !== "any") {
      const rating = getItemRating(item);
      if (filter.rating === "unrated" ? rating !== 0 : rating !== filter.rating) return false;
    }
    const tags = normalizeTags(item.tags);
    if (
      filter.tags.length &&
      (filter.tagMatch === "all"
        ? !filter.tags.every((tag) => tags.includes(tag))
        : !filter.tags.some((tag) => tags.includes(tag)))
    ) {
      return false;
    }
    if (filter.excludedTags.some((tag) => tags.includes(tag))) return false;
    return filter.maxTagCount === null || tags.length < filter.maxTagCount;
  }

  function getItemFileType(item) {
    const extension = String(item?.ext || "").toLowerCase().replace(/^\./, "");
    if (VIDEO_EXTENSIONS.has(extension)) return "video";
    if (!extension || IMAGE_EXTENSIONS.has(extension)) return "image";
    return null;
  }

  function isSupportedMediaItem(item) {
    return getItemFileType(item) !== null;
  }

  function normalizeFileTypes(filter) {
    const requested = Array.isArray(filter.fileTypes)
      ? filter.fileTypes
      : filter.fileType === "any"
        ? FILE_TYPES
        : [filter.fileType];
    const fileTypes = FILE_TYPES.filter((fileType) => requested.includes(fileType));
    return fileTypes.length ? fileTypes : [...DEFAULT_UNRATED_FILTER.fileTypes];
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

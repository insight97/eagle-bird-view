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
    clamp,
    getItemRating,
    normalizeTags,
    selectRandomExplorationRow,
  } = core;
  const MAX_FOLDER_QUERIES = 6;
  const MAX_TAG_QUERIES = 12;
  const MAX_CACHED_ITEMS_PER_QUERY = 240;
  const MAX_CANDIDATES = 600;
  const DEFAULT_AI_SEARCH_LIMIT = 20;
  const MAX_AI_SEARCH_LIMIT = 100;
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
    minRating: null,
    maxRating: null,
    folders: Object.freeze([]),
    folderMatch: "any",
    includeSubfolders: true,
    tags: Object.freeze([]),
    excludedTags: Object.freeze([]),
    tagMatch: "any",
    tagGroups: Object.freeze([]),
    tagGroupMatch: "any",
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
    #folderApi;
    #random;
    #generation = 0;
    #filterKey = null;

    constructor(itemApi, folderApiOrRandom, random) {
      this.#itemApi = itemApi;
      if (arguments.length < 3 && typeof folderApiOrRandom === "function") {
        this.#folderApi = null;
        this.#random = folderApiOrRandom;
      } else {
        this.#folderApi = folderApiOrRandom;
        this.#random = typeof random === "function" ? random : Math.random;
      }
    }

    async findNextRow(
      excludedIds = new Set(),
      filter = DEFAULT_UNRATED_FILTER,
      layoutWidth,
      maxItems,
      layoutOptions = {},
    ) {
      const normalizedFilter = normalizeUnratedFilter(filter);
      const folderScopeResult = resolveFolderScope(this.#folderApi, normalizedFilter);
      const folderScope =
        folderScopeResult instanceof Promise ? await folderScopeResult : folderScopeResult;
      const filterKey = JSON.stringify({ normalizedFilter, folderScope });
      if (this.#filterKey !== filterKey) {
        this.#generation += 1;
        this.#filterKey = filterKey;
        this.#items = null;
      }
      const generation = this.#generation;
      if (!this.#items) {
        this.#items = loadFilteredItems(this.#itemApi, normalizedFilter, folderScope)
          .catch((error) => {
            if (generation === this.#generation) this.#items = null;
            throw error;
          });
      }
      const items = await this.#items;
      if (generation !== this.#generation) return [];
      const available = items.filter(
        (item) => isEligibleItem(item, excludedIds, normalizedFilter, folderScope),
      );
      const selected = selectRandomExplorationRow(
        available,
        this.#random,
        layoutWidth,
        maxItems,
        layoutOptions,
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

  class AiSimilarItemSource {
    #aiSearch;
    #cache = new Map();
    #generation = 0;

    constructor(aiSearch) {
      this.#aiSearch = aiSearch;
    }

    async findCandidates(
      pivot,
      excludedIds = new Set(),
      { limit, maxSimilarity = 1 } = {},
    ) {
      if (!pivot?.id || typeof this.#aiSearch?.searchByItemId !== "function") return [];
      const normalizedLimit = normalizeAiSearchLimit(limit);
      const normalizedMaxSimilarity = normalizeAiSimilarityMax(maxSimilarity);
      const generation = this.#generation;
      const cacheKey = `${pivot.id}:${normalizedLimit}`;
      let request = this.#cache.get(cacheKey);
      if (!request) {
        request = this.#load(pivot.id, normalizedLimit);
        this.#cache.set(cacheKey, request);
        request.catch(() => {
          if (this.#cache.get(cacheKey) === request) this.#cache.delete(cacheKey);
        });
      }

      const result = await request;
      if (!result.cacheable) {
        if (this.#cache.get(cacheKey) === request) this.#cache.delete(cacheKey);
        return [];
      }
      if (generation !== this.#generation) return [];
      return result.candidates.filter(
        ({ item, aiScore }) =>
          !excludedIds.has(item.id) && aiScore <= normalizedMaxSimilarity,
      );
    }

    clear() {
      this.#generation += 1;
      this.#cache.clear();
    }

    async #load(itemId, limit) {
      if (typeof this.#aiSearch.isInstalled === "function" && !(await this.#aiSearch.isInstalled())) {
        return { cacheable: false, candidates: [] };
      }
      if (typeof this.#aiSearch.isReady === "function" && !(await this.#aiSearch.isReady())) {
        return { cacheable: false, candidates: [] };
      }

      const response = await this.#aiSearch.searchByItemId(itemId, { limit });
      const candidates = (Array.isArray(response?.results) ? response.results : [])
        .map(({ item, score }) => ({ item, aiScore: normalizeAiScore(score) }))
        .filter(
          ({ item, aiScore }) =>
            item?.id &&
            aiScore !== null &&
            !item.isDeleted &&
            isSupportedMediaItem(item),
        );
      return { cacheable: true, candidates };
    }
  }

  class HybridExplorationSource {
    #relatedSource;
    #aiSource;

    constructor(relatedSource, aiSource = null) {
      this.#relatedSource = relatedSource;
      this.#aiSource = aiSource;
    }

    async findCandidates(
      pivot,
      excludedIds = new Set(),
      { aiEnabled = false, maxAiItems = 0, maxAiSimilarity = 1 } = {},
    ) {
      const relatedPromise = this.#relatedSource.findCandidates(pivot, excludedIds);
      if (!aiEnabled || !this.#aiSource || maxAiItems < 1) return relatedPromise;

      const [relatedResult, aiResult] = await Promise.allSettled([
        relatedPromise,
        this.#aiSource.findCandidates(pivot, excludedIds, {
          limit: Math.max(DEFAULT_AI_SEARCH_LIMIT, maxAiItems * 4),
          maxSimilarity: maxAiSimilarity,
        }),
      ]);
      if (relatedResult.status === "rejected") throw relatedResult.reason;
      if (aiResult.status === "rejected") return relatedResult.value;
      return mergeExplorationCandidates(relatedResult.value, aiResult.value);
    }

    hydrate(candidates) {
      return this.#relatedSource.hydrate(candidates.map(getExplorationCandidateItem));
    }

    clear() {
      this.#relatedSource.clear();
      this.#aiSource?.clear();
    }
  }

  function normalizeUnratedFilter(filter = DEFAULT_UNRATED_FILTER) {
    const minRating = normalizeRatingBound(filter.minRating);
    const maxRating = normalizeRatingBound(filter.maxRating);
    const normalizedRatingRange = normalizeRatingRange(minRating, maxRating);
    const maxTagCount = Number(filter.maxTagCount);
    return {
      fileTypes: normalizeFileTypes(filter),
      rating: normalizeRating(filter.rating),
      minRating: normalizedRatingRange.min,
      maxRating: normalizedRatingRange.max,
      folders: normalizeTags(filter.folders),
      folderMatch: filter.folderMatch === "all" ? "all" : "any",
      includeSubfolders: filter.includeSubfolders !== false,
      tags: normalizeTags(filter.tags),
      excludedTags: normalizeTags(filter.excludedTags),
      tagMatch: filter.tagMatch === "all" ? "all" : "any",
      tagGroups: normalizeTagGroups(filter.tagGroups),
      tagGroupMatch: filter.tagGroupMatch === "all" ? "all" : "any",
      maxTagCount: Number.isInteger(maxTagCount) && maxTagCount >= 1 ? maxTagCount : null,
    };
  }

  function normalizeRating(rating) {
    if (rating === "any" || rating === "unrated") return rating;
    const value = Number(rating);
    return [1, 2, 3, 4, 5].includes(value) ? value : DEFAULT_UNRATED_FILTER.rating;
  }

  function normalizeRatingBound(rating) {
    const value = Number(rating);
    return [1, 2, 3, 4, 5].includes(value) ? value : null;
  }

  function normalizeRatingRange(minRating, maxRating) {
    if (minRating !== null && maxRating !== null && minRating > maxRating) {
      return { min: maxRating, max: minRating };
    }
    return { min: minRating, max: maxRating };
  }

  function normalizeTagGroups(groups) {
    if (!Array.isArray(groups)) return [];
    return groups
      .filter((group) => group && typeof group === "object")
      .map((group) => ({
        tags: normalizeTags(group.tags),
        match: group.match === "any" ? "any" : "all",
      }));
  }

  function getUnratedFilterKey(filter) {
    return JSON.stringify(normalizeUnratedFilter(filter));
  }

  function unratedFiltersEqual(first, second) {
    return getUnratedFilterKey(first) === getUnratedFilterKey(second);
  }

  async function loadFilteredItems(itemApi, filter, folderScope) {
    const rating =
      filter.rating === "any" || filter.minRating !== null || filter.maxRating !== null
        ? {}
        : { rating: filter.rating === "unrated" ? 0 : filter.rating };
    const fields = { fields: INDEX_FIELDS };
    const queries = [];
    const queryTags = getQueryTags(filter);
    for (const tag of queryTags) queries.push({ ...rating, tags: [tag], ...fields });
    for (const folderId of folderScope.queryFolderIds) {
      queries.push({ ...rating, folders: [folderId], ...fields });
    }

    if (!queries.length) {
      if (!filter.fileTypes.includes("video") || filter.fileTypes.includes("image")) {
        queries.push({ ...rating, ...fields });
      } else {
        queries.push(
          ...[...VIDEO_EXTENSIONS].map((ext) => ({ ...rating, ext, ...fields })),
        );
      }
    }

    const results = await Promise.all(queries.map((query) => itemApi.get(query)));
    const itemsById = new Map();
    for (const items of results) {
      for (const item of items || []) {
        if (item?.id) itemsById.set(item.id, item);
      }
    }
    return [...itemsById.values()];
  }

  function isEligibleItem(item, excludedIds, filter, folderScope = createFolderScope(filter)) {
    if (!item?.id || item.isDeleted || excludedIds.has(item.id)) return false;
    const fileType = getItemFileType(item);
    if (!fileType || !filter.fileTypes.includes(fileType)) return false;
    const rating = getItemRating(item);
    if (filter.rating === "unrated" && rating !== 0) return false;
    if (filter.rating !== "any" && filter.rating !== "unrated" && rating !== filter.rating) {
      return false;
    }
    if (filter.minRating !== null && rating < filter.minRating) return false;
    if (filter.maxRating !== null && rating > filter.maxRating) return false;

    const itemFolders = new Set(normalizeTags(item.folders));
    if (
      folderScope.includedGroups.length &&
      (filter.folderMatch === "all"
        ? !folderScope.includedGroups.every((group) => group.some((id) => itemFolders.has(id)))
        : !folderScope.includedGroups.some((group) => group.some((id) => itemFolders.has(id))))
    ) {
      return false;
    }
    const tags = normalizeTags(item.tags);
    const tagGroups = [
      { tags: filter.tags, match: filter.tagMatch },
      ...filter.tagGroups,
    ].filter((group) => group.tags.length);
    if (tagGroups.length) {
      const groupMatches = tagGroups.map((group) =>
        group.match === "all"
          ? group.tags.every((tag) => tags.includes(tag))
          : group.tags.some((tag) => tags.includes(tag)),
      );
      if (filter.tagGroupMatch === "all" ? !groupMatches.every(Boolean) : !groupMatches.some(Boolean)) {
        return false;
      }
    }
    if (filter.excludedTags.some((tag) => tags.includes(tag))) return false;
    return filter.maxTagCount === null || tags.length < filter.maxTagCount;
  }

  function getQueryTags(filter) {
    const groups = [
      { tags: filter.tags, match: filter.tagMatch },
      ...filter.tagGroups,
    ].filter((group) => group.tags.length);
    return [
      ...new Set(
        groups.flatMap(({ tags, match }) => (match === "all" ? tags.slice(0, 1) : tags)),
      ),
    ].slice(0, MAX_TAG_QUERIES);
  }

  function resolveFolderScope(folderApi, filter) {
    const selectedFolderIds = [...new Set(filter.folders)];
    const descendants = new Map(selectedFolderIds.map((id) => [id, [id]]));
    const createScope = () => createResolvedFolderScope(filter, descendants);
    if (
      !filter.includeSubfolders ||
      !selectedFolderIds.length ||
      typeof folderApi?.getAll !== "function"
    ) {
      return createScope();
    }

    return Promise.resolve()
      .then(() => folderApi.getAll())
      .then((folders) => {
        const byId = new Map();
        const visit = (folder, parentId = "") => {
          const id = String(folder?.id || "").trim();
          if (!id || byId.has(id)) return;
          byId.set(id, {
            id,
            parentId: String(folder?.parent || parentId || "").trim(),
          });
          for (const child of folder?.children || []) visit(child, id);
        };
        for (const folder of folders || []) visit(folder);
        for (const folder of byId.values()) {
          for (const selectedId of selectedFolderIds) {
            if (isDescendantOf(folder.id, selectedId, byId)) {
              descendants.get(selectedId)?.push(folder.id);
            }
          }
        }
        return createScope();
      })
      .catch(() => createScope());
  }

  function createResolvedFolderScope(filter, descendants) {
    const includedGroups = filter.folders.map((id) => [...new Set(descendants.get(id) || [id])]);
    return {
      includedGroups,
      queryFolderIds: [...new Set(includedGroups.flat())].slice(0, MAX_FOLDER_QUERIES),
    };
  }

  function createFolderScope(filter) {
    return {
      includedGroups: filter.folders.map((id) => [id]),
      queryFolderIds: [...filter.folders].slice(0, MAX_FOLDER_QUERIES),
    };
  }

  function isDescendantOf(folderId, ancestorId, byId) {
    let currentId = folderId;
    const visited = new Set();
    while (currentId && !visited.has(currentId)) {
      if (currentId === ancestorId) return true;
      visited.add(currentId);
      currentId = byId.get(currentId)?.parentId || "";
    }
    return false;
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

  function normalizeAiSearchLimit(limit) {
    const value = Number(limit);
    return Number.isFinite(value)
      ? clamp(Math.floor(value), DEFAULT_AI_SEARCH_LIMIT, MAX_AI_SEARCH_LIMIT)
      : DEFAULT_AI_SEARCH_LIMIT;
  }

  function normalizeAiScore(score) {
    const value = Number(score);
    return Number.isFinite(value) ? clamp(value, 0, 1) : null;
  }

  function normalizeAiSimilarityMax(value) {
    const number = Number(value);
    return Number.isFinite(number) ? clamp(number, 0, 1) : 1;
  }

  function getExplorationCandidateItem(candidate) {
    return candidate?.item?.id ? candidate.item : candidate;
  }

  function mergeExplorationCandidates(relatedItems, aiCandidates) {
    const aiCandidatesById = new Map();
    for (const candidate of aiCandidates) {
      const item = getExplorationCandidateItem(candidate);
      if (!item?.id) continue;
      if (!aiCandidatesById.has(item.id)) aiCandidatesById.set(item.id, candidate);
    }
    const relatedCandidatesById = new Map();
    for (const item of relatedItems) {
      if (item?.id && !aiCandidatesById.has(item.id) && !relatedCandidatesById.has(item.id)) {
        relatedCandidatesById.set(item.id, { item });
      }
    }
    return [...relatedCandidatesById.values(), ...aiCandidatesById.values()];
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

  return Object.freeze({
    AiSimilarItemSource,
    DEFAULT_UNRATED_FILTER,
    HybridExplorationSource,
    RelatedItemSource,
    UnratedItemSource,
    normalizeUnratedFilter,
    unratedFiltersEqual,
  });
});

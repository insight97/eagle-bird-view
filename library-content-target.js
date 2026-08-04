"use strict";

(function exposeBirdViewLibraryContent(root, factory) {
  const target = factory();
  if (typeof module === "object" && module.exports) module.exports = target;
  root.BirdViewLibraryContent = target;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const DEFAULT_CHANNEL = "library-content-target";

  function createLibraryContentTarget({
    itemApi,
    folderApi,
    getFolderTree = () => [],
    intake,
    loadCoordinator,
    channel = DEFAULT_CHANNEL,
  } = {}) {
    if (
      !intake ||
      typeof intake.start !== "function" ||
      typeof intake.startFromItems !== "function" ||
      !loadCoordinator ||
      typeof loadCoordinator.run !== "function" ||
      typeof loadCoordinator.invalidate !== "function"
    ) {
      throw new Error("Library content target requires an intake and load coordinator");
    }

    function normalizeTarget({ type, value, label } = {}) {
      const normalizedType = type === "tag" || type === "folder" ? type : "";
      const normalizedValue = String(value || "").trim();
      return {
        type: normalizedType,
        value: normalizedValue,
        label: String(label || normalizedValue).trim(),
      };
    }

    async function load(options = {}) {
      const target = normalizeTarget(options);
      if (!target.type || !target.value) return { status: "invalid", target };

      loadCoordinator.invalidate(channel);
      const result = await loadCoordinator.run(channel, async ({ isCurrent }) => {
        if (target.type === "tag") return loadTag(target, options.onBeforeStart, isCurrent);
        return loadFolder(target, options.onBeforeStart, isCurrent);
      });

      if (result.status !== "success") return result;
      return result.value || { status: "stale" };
    }

    async function loadTag(target, onBeforeStart, isCurrent) {
      if (typeof itemApi?.get !== "function") {
        return { status: "unavailable", ...target };
      }

      await onBeforeStart?.({ ...target });
      if (!isCurrent()) return null;
      const items = (await itemApi.get({ tags: [target.value] })) || [];
      if (!isCurrent()) return null;

      const filteredItems = items.filter((item) => item?.id && !item.isDeleted);
      if (!filteredItems.length) return { status: "empty", ...target, items: [] };

      const intakeResult = await intake.startFromItems(filteredItems, { focus: true });
      if (!isCurrent()) return null;
      return normalizeIntakeResult(intakeResult, { ...target, items: filteredItems });
    }

    async function loadFolder(target, onBeforeStart, isCurrent) {
      const { folder, error } = await resolveFolder(target.value);
      if (!folder) return { status: "missing", ...target, error };

      await onBeforeStart?.({ ...target, folder });
      if (!isCurrent()) return null;

      const intakeResult = await intake.start({
        folders: [folder],
        includeSubfolders: true,
      });
      if (!isCurrent()) return null;
      return normalizeIntakeResult(intakeResult, { ...target, folder });
    }

    async function resolveFolder(folderId) {
      const localFolder = findFolderById(getFolderTree(), folderId);
      if (localFolder) return { folder: localFolder };
      if (typeof folderApi?.getById !== "function") return { folder: null };

      try {
        return { folder: await folderApi.getById(folderId) };
      } catch (error) {
        return { folder: null, error };
      }
    }

    function reset() {
      loadCoordinator.invalidate(channel);
    }

    return Object.freeze({ load, reset });
  }

  function normalizeIntakeResult(result, target) {
    if (!result || result.status === "stale") return { status: "stale", ...target };
    if (result.status === "error") return { status: "error", ...target, error: result.error };
    if (result.status === "empty") return { status: "empty", ...target, intake: result };
    if (result.status === "partial") return { status: "partial", ...target, intake: result };
    return { status: "loaded", ...target, intake: result };
  }

  function findFolderById(source, folderId) {
    for (const folder of source || []) {
      if (String(folder?.id || "").trim() === folderId) return folder;
      const child = findFolderById(folder?.children, folderId);
      if (child) return child;
    }
    return null;
  }

  return Object.freeze({ createLibraryContentTarget });
});

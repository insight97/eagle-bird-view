"use strict";

(function exposeBirdViewLibraryContent(root, factory) {
  const target = factory();
  if (typeof module === "object" && module.exports) module.exports = target;
  root.BirdViewLibraryContent = target;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const DEFAULT_CHANNEL = "library-content-target";

  // Tag is the pre-filtered library target. Folder resolution and folder
  // sessions belong to FolderContentIntake so every folder origin shares one
  // generation and retry owner.
  function createLibraryContentTarget({
    itemApi,
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
      if (target.type !== "tag") return { status: "invalid", target };

      loadCoordinator.invalidate(channel);
      const result = await loadCoordinator.run(channel, async ({ isCurrent }) => {
        return loadTag(target, options.onBeforeStart, isCurrent);
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

  return Object.freeze({ createLibraryContentTarget });
});

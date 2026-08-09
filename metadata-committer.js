"use strict";

(function exposeBirdViewMetadata(root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  root.BirdViewMetadata = metadata;
})(typeof globalThis === "object" ? globalThis : this, () => {
  // Owns the transaction lifecycle shared by rating, Tag, and folder changes.
  // Eagle item objects are the production save adapters; tests supply mock
  // items with the same save interface.
  function createMetadataCommitter(options = {}) {
    const {
      maxConcurrent = 4,
      onChange = () => {},
      onSavingChange = () => {},
      invalidateSources = () => {},
      onComplete = () => {},
    } = options;

    async function commit({ property, changes } = {}) {
      const normalizedProperty = String(property || "").trim();
      if (!normalizedProperty) throw new Error("Metadata commit requires a property");
      const changeMap = changes instanceof Map ? new Map(changes) : new Map(changes || []);
      const nodes = [...changeMap.keys()].filter(Boolean);
      if (!nodes.length) return resultFor("empty");

      const busy = nodes.filter((node) => node.isSaving);
      if (busy.length) return resultFor("busy", { busy });
      const unsupported = nodes.filter((node) => typeof node.item?.save !== "function");
      if (unsupported.length) return resultFor("unsupported", { unsupported });

      const entries = nodes.map((node) => ({
        node,
        previous: node.item[normalizedProperty],
        status: "pending",
        error: null,
      }));

      for (const entry of entries) {
        entry.node.isSaving = true;
        onSavingChange(entry.node, true);
        entry.node.item[normalizedProperty] = changeMap.get(entry.node);
        onChange(entry.node, normalizedProperty);
      }
      invalidateSources();

      let nextIndex = 0;
      async function worker() {
        while (nextIndex < entries.length) {
          const entry = entries[nextIndex++];
          try {
            const saved = await entry.node.item.save();
            if (saved === false) throw new Error("Eagle 拒絕儲存變更");
            entry.status = "saved";
          } catch (error) {
            entry.status = "failed";
            entry.error = error;
            entry.node.item[normalizedProperty] = entry.previous;
            onChange(entry.node, normalizedProperty);
          }
        }
      }

      const workerCount = Math.min(
        Math.max(1, Number(maxConcurrent) || 1),
        entries.length,
      );
      await Promise.all(Array.from({ length: workerCount }, () => worker()));

      for (const { node } of entries) {
        node.isSaving = false;
        onSavingChange(node, false);
      }

      const succeeded = entries
        .filter(({ status }) => status === "saved")
        .map(({ node }) => node);
      const failed = entries
        .filter(({ status }) => status === "failed")
        .map(({ node, error }) => ({ node, error }));
      const status = failed.length
        ? succeeded.length
          ? "partial"
          : "failed"
        : "saved";
      const result = resultFor(status, { entries, succeeded, failed });
      onComplete(result);
      return result;
    }

    return Object.freeze({ commit });
  }

  function resultFor(status, details = {}) {
    return {
      status,
      entries: [],
      succeeded: [],
      failed: [],
      busy: [],
      unsupported: [],
      ...details,
    };
  }

  return Object.freeze({ createMetadataCommitter });
});

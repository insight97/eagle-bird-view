"use strict";

(function exposeBirdViewBulkMetadata(root, factory) {
  const bulkMetadata = factory();
  if (typeof module === "object" && module.exports) module.exports = bulkMetadata;
  root.BirdViewBulkMetadata = bulkMetadata;
})(typeof globalThis === "object" ? globalThis : this, () => {
  function createBulkMetadataService({ maxConcurrent = 4 } = {}) {
    async function save(nodes, { save, rollback } = {}) {
      const entries = nodes.map((node) => ({ node, status: "pending", error: null }));
      let nextIndex = 0;

      async function worker() {
        while (nextIndex < entries.length) {
          const entry = entries[nextIndex++];
          try {
            const result = await save(entry.node);
            if (result === false) throw new Error("Eagle 拒絕儲存變更");
            entry.status = "saved";
          } catch (error) {
            entry.status = "failed";
            entry.error = error;
            rollback?.(entry.node);
          }
        }
      }

      const workerCount = Math.min(Math.max(1, maxConcurrent), entries.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      return {
        entries,
        succeeded: entries.filter(({ status }) => status === "saved").map(({ node }) => node),
        failed: entries.filter(({ status }) => status === "failed").map(({ node, error }) => ({ node, error })),
      };
    }

    return Object.freeze({ save });
  }

  return Object.freeze({ createBulkMetadataService });
});

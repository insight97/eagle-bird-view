"use strict";

(function exposeBirdViewFolderContent(root, factory) {
  const intake = factory();
  if (typeof module === "object" && module.exports) module.exports = intake;
  root.BirdViewFolderContent = intake;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const DEFAULT_CHANNEL = "folder-content";
  const DEFAULT_INITIAL_DISPLAY_MIN_ITEMS = 120;
  const DEFAULT_BATCH_SIZE = 120;

  // Owns the folder-content session seam for selected folders, the sidebar,
  // and folder metadata targets. Source querying, folder resolution, stale
  // target protection, progressive hydration, and retry stay behind this
  // interface; callers only adapt the start/batch events to the board and UI.
  function createFolderContentIntake({
    source,
    folderApi,
    getFolderTree = () => [],
    loadCoordinator,
    channel = DEFAULT_CHANNEL,
    initialDisplayMinItems = DEFAULT_INITIAL_DISPLAY_MIN_ITEMS,
    batchSize = DEFAULT_BATCH_SIZE,
    onStart = () => {},
    onBatch = () => {},
    onStateChange = () => {},
  } = {}) {
    if (
      !source ||
      typeof source.loadFolders !== "function" ||
      typeof source.hydrate !== "function" ||
      !loadCoordinator ||
      typeof loadCoordinator.run !== "function" ||
      typeof loadCoordinator.invalidate !== "function"
    ) {
      throw new Error("Folder content intake requires a source and load coordinator");
    }

    const initialThreshold = Math.max(1, Math.floor(initialDisplayMinItems));
    const batchLimit = Math.max(1, Math.floor(batchSize));
    let session = null;
    let requestGeneration = 0;

    function beginRequest() {
      requestGeneration += 1;
      loadCoordinator.invalidate(channel);
      return requestGeneration;
    }

    function isRequestCurrent(generation) {
      return requestGeneration === generation;
    }

    function createSession(folders, includeSubfolders) {
      return {
        folders: Array.isArray(folders) ? folders.slice() : [],
        includeSubfolders: includeSubfolders !== false,
        summaries: [],
        summaryIds: new Set(),
        offset: 0,
        hasStarted: false,
        queryFailures: [],
        pendingBatch: null,
        hydrationError: null,
        status: "loading",
        error: null,
      };
    }

    function isCurrent(current, token) {
      return session === current && (!token || token.isCurrent());
    }

    function snapshot() {
      const current = session;
      const summaries = current?.summaries || [];
      const offset = current?.offset || 0;
      const failures = current?.queryFailures || [];
      const pending = Boolean(current?.pendingBatch);
      return {
        status: current?.status || "idle",
        folders: current?.folders?.slice() || [],
        includeSubfolders: current?.includeSubfolders ?? null,
        itemCount: summaries.length,
        loadedCount: offset,
        remaining: Math.max(summaries.length - offset, 0),
        hasMore: Boolean(failures.length || pending || offset < summaries.length),
        isLoading: Boolean(loadCoordinator.isLoading?.(channel)),
        failureCount: failures.length,
        error: current?.error || null,
      };
    }

    function notify() {
      onStateChange(snapshot());
    }

    function activateSession(folders, includeSubfolders, { generation, origin } = {}) {
      onStart({
        origin: origin || "folder",
        folders: Array.isArray(folders) ? folders.slice() : [],
        includeSubfolders: includeSubfolders !== false,
      });
      if (!isRequestCurrent(generation)) return null;
      session = createSession(folders, includeSubfolders);
      notify();
      return session;
    }

    function appendSummaries(current, items) {
      for (const item of items || []) {
        if (!item?.id || item.isDeleted || current.summaryIds.has(item.id)) continue;
        current.summaryIds.add(item.id);
        current.summaries.push(item);
      }
    }

    async function releaseBatch(current, { focus = false, token } = {}) {
      if (!isCurrent(current, token)) return { status: "stale" };
      const pending = current.pendingBatch;
      const start = pending?.offset ?? current.offset;
      const candidates = pending?.items || current.summaries.slice(start, start + batchLimit);
      if (!candidates.length) return { status: "empty" };

      current.pendingBatch = { offset: start, items: candidates };
      current.status = "loading";
      current.error = null;
      notify();

      try {
        const items = await source.hydrate(candidates);
        if (!isCurrent(current, token)) return { status: "stale" };
        current.offset = start + candidates.length;
        current.pendingBatch = null;
        current.hydrationError = null;
        await onBatch(items || [], {
          initial: start === 0,
          focus,
          offset: current.offset,
          total: current.summaries.length,
        });
        return { status: "success", items: items || [] };
      } catch (error) {
        if (!isCurrent(current, token)) return { status: "stale" };
        current.hydrationError = error;
        current.error = error;
        current.status = current.offset ? "partial" : "error";
        notify();
        return { status: "error", error };
      } finally {
        if (isCurrent(current, token)) notify();
      }
    }

    async function runQuery(current) {
      if (!isCurrent(current)) return { status: "stale" };
      current.status = "loading";
      current.error = null;
      notify();

      const result = await loadCoordinator.run(channel, async (token) => {
        const sourceResult = await source.loadFolders(current.folders, {
          includeSubfolders: current.includeSubfolders,
          onItems: async (items) => {
            if (!isCurrent(current, token)) return;
            appendSummaries(current, items);
            if (!current.hasStarted && current.summaries.length >= initialThreshold) {
              current.hasStarted = true;
              await releaseBatch(current, { focus: true, token });
            }
            notify();
          },
        });
        if (!isCurrent(current, token)) return null;
        return sourceResult || {};
      });

      if (session !== current || result.status === "stale") return { status: "stale" };
      if (result.status === "error") {
        current.queryFailures = [{ folderId: "", error: result.error }];
        current.error = result.error;
        current.status = current.offset ? "partial" : "error";
        notify();
        return snapshot();
      }

      appendSummaries(current, result.value?.items);
      current.queryFailures = Array.isArray(result.value?.failures) ? result.value.failures : [];
      if (!current.hasStarted && current.summaries.length) {
        current.hasStarted = true;
        await releaseBatch(current, { focus: true });
      }

      if (current.hydrationError) {
        current.status = current.offset ? "partial" : "error";
      } else if (current.queryFailures.length) {
        current.error = current.queryFailures[0].error || null;
        current.status = current.offset ? "partial" : "error";
      } else if (current.summaries.length) {
        current.status = "ready";
      } else {
        current.status = "empty";
      }
      notify();
      return snapshot();
    }

    async function resolveFolder({ folder, folderId } = {}) {
      if (folder?.id) return { folder };
      const normalizedId = String(folderId || "").trim();
      if (!normalizedId) return { folder: null };

      const localFolder = findFolderById(getFolderTree(), normalizedId);
      if (localFolder) return { folder: localFolder };

      if (typeof folderApi?.getById === "function") {
        try {
          return { folder: await folderApi.getById(normalizedId) };
        } catch (error) {
          return { folder: null, error };
        }
      }

      if (typeof folderApi?.getByIds === "function") {
        try {
          const folders = await folderApi.getByIds([normalizedId]);
          return { folder: folders?.[0] || null };
        } catch (error) {
          return { folder: null, error };
        }
      }

      return { folder: null };
    }

    async function startFolder({
      folder,
      folderId,
      includeSubfolders = true,
      origin = "folder",
    } = {}) {
      const generation = beginRequest();
      // A target can take a round trip through Eagle before its folder is
      // known. Hide the previous session during that gap so load-more cannot
      // continue working on stale folder contents.
      session = null;
      notify();
      const resolved = await resolveFolder({ folder, folderId });
      if (!isRequestCurrent(generation)) return { status: "stale" };
      if (!resolved.folder) {
        return {
          status: "missing",
          folderId: String(folderId || resolved.folder?.id || "").trim(),
          error: resolved.error,
        };
      }

      const current = activateSession([resolved.folder], includeSubfolders, {
        generation,
        origin,
      });
      if (!current) return { status: "stale" };
      const result = await runQuery(current);
      if (result.status === "stale") return result;
      return { ...result, folder: resolved.folder };
    }

    async function loadNextBatch(current, { focus = false } = {}) {
      if (!isCurrent(current)) return { status: "stale" };
      if (loadCoordinator.isLoading?.(channel)) return snapshot();
      const result = await loadCoordinator.run(channel, (token) =>
        releaseBatch(current, { focus, token }),
      );
      if (session !== current || result.status === "stale") return { status: "stale" };
      if (result.status === "error") return snapshot();
      current.status = current.queryFailures.length ? "partial" : "ready";
      current.error = current.queryFailures[0]?.error || null;
      notify();
      return snapshot();
    }

    async function start({ folders, includeSubfolders = true, origin = "folder" } = {}) {
      const generation = beginRequest();
      const current = activateSession(folders, includeSubfolders, {
        generation,
        origin,
      });
      if (!current) return { status: "stale" };
      return runQuery(current);
    }

    async function startFromItems(items, { folders = [], includeSubfolders = true, focus = true } = {}) {
      beginRequest();
      session = createSession(folders, includeSubfolders);
      appendSummaries(session, items);
      session.hasStarted = true;
      notify();
      if (!session.summaries.length) {
        session.status = "empty";
        notify();
        return snapshot();
      }
      return loadNextBatch(session, { focus });
    }

    async function loadMore() {
      if (!session) return snapshot();
      if (loadCoordinator.isLoading?.(channel)) return snapshot();
      if (session.queryFailures.length) {
        const retried = await runQuery(session);
        if (retried.status === "stale" || session.queryFailures.length) return retried;
      }
      return loadNextBatch(session);
    }

    function reset() {
      beginRequest();
      session = null;
      notify();
    }

    return Object.freeze({ loadMore, reset, snapshot, start, startFolder, startFromItems });
  }

  function findFolderById(source, folderId) {
    for (const folder of source || []) {
      if (String(folder?.id || "").trim() === folderId) return folder;
      const child = findFolderById(folder?.children, folderId);
      if (child) return child;
    }
    return null;
  }

  return Object.freeze({ createFolderContentIntake });
});

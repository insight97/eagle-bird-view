"use strict";

(function exposeBirdViewPdfBoard(root, factory) {
  const core =
    root.BirdViewCore ||
    (typeof module === "object" && typeof require === "function"
      ? require("./bird-view-core.js")
      : null);
  const pdfBoard = factory(core);
  if (typeof module === "object" && module.exports) module.exports = pdfBoard;
  root.BirdViewPdfBoard = pdfBoard;
})(typeof globalThis === "object" ? globalThis : this, (core) => {
  const { isPdfItem } = core;

  const DEFAULT_PAGE_SIZE = Object.freeze({ width: 612, height: 792 });
  const DEFAULT_PAGE_SIZE_CONCURRENCY = 4;

  function createPdfPageItem(parentItem, pageNumber, pageSize, pageCount) {
    const width = positiveNumber(pageSize?.width, DEFAULT_PAGE_SIZE.width);
    const height = positiveNumber(pageSize?.height, DEFAULT_PAGE_SIZE.height);
    const parentName = parentItem?.name || "PDF";
    return {
      id: `${parentItem.id}:page:${pageNumber}`,
      name: `${parentName} · 第 ${pageNumber} 頁`,
      ext: "pdf-page",
      width,
      height,
      size: 0,
      isPdfPage: true,
      pdfParentItem: parentItem,
      pdfPageNumber: pageNumber,
      pdfPageCount: pageCount,
    };
  }

  function createPdfBoardSession({
    runtime,
    host,
    pageSizeConcurrency = DEFAULT_PAGE_SIZE_CONCURRENCY,
    onCleanupError = () => {},
  } = {}) {
    if (!runtime?.openDocument) {
      throw new TypeError("PDF board session requires a PDF runtime");
    }
    if (
      !host ||
      typeof host.captureParentBoard !== "function" ||
      typeof host.invalidateParentWork !== "function" ||
      typeof host.releaseBoardPresentation !== "function" ||
      typeof host.showPdfPages !== "function" ||
      typeof host.restoreParentBoard !== "function" ||
      typeof host.publishView !== "function" ||
      typeof host.focusFirstPage !== "function"
    ) {
      throw new TypeError("PDF board session requires a host adapter");
    }

    let phase = "parent";
    let generation = 0;
    let documentHandle = null;
    let parentItem = null;
    let pageItems = [];
    let parentBoard = null;
    let openingController = null;

    function transition(intent) {
      if (!intent || (intent.type !== "enter" && intent.type !== "leave")) {
        throw new TypeError("PDF board session requires an enter or leave intent");
      }
      if (intent.type === "enter") return enter(intent.item);
      return leave();
    }

    async function enter(item) {
      if (!isPdfItem(item)) return { status: "unchanged", reason: "not-pdf" };
      if (phase === "active" || phase === "leaving") {
        return { status: "unchanged", reason: "already-active" };
      }
      const nextParentBoard = host.captureParentBoard();
      if (!nextParentBoard) return { status: "failed", code: "missing-parent-board" };

      openingController?.abort?.();
      const currentGeneration = ++generation;
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      openingController = controller;
      phase = "opening";
      parentItem = item;
      publishView();

      let handle = null;
      let parentPresentationReleased = false;
      try {
        handle = await runtime.openDocument(item, { signal: controller?.signal });
        if (generation !== currentGeneration) {
          cleanupDetachedDocument(handle);
          return { status: "cancelled", reason: "superseded" };
        }
        const pageCount = positiveInteger(handle?.numPages);
        if (!pageCount) {
          cleanupDetachedDocument(handle);
          resetOpening(currentGeneration);
          return { status: "failed", code: "missing-page-count" };
        }

        const nextPageItems = await loadPageItems(handle, item, pageCount, {
          concurrency: pageSizeConcurrency,
          signal: controller?.signal,
        });
        if (generation !== currentGeneration) {
          cleanupDetachedDocument(handle);
          return { status: "cancelled", reason: "superseded" };
        }

        documentHandle = handle;
        parentBoard = nextParentBoard;
        pageItems = nextPageItems;
        openingController = null;
        host.invalidateParentWork();
        parentPresentationReleased = true;
        host.releaseBoardPresentation();
        host.showPdfPages({ parentItem: item, pageItems: nextPageItems.slice() });
        phase = "active";
        publishView();
        host.focusFirstPage();
        return { status: "entered", pageCount: nextPageItems.length };
      } catch (error) {
        cleanupDetachedDocument(handle);
        if (generation !== currentGeneration) {
          return { status: "cancelled", reason: "superseded" };
        }
        if (parentPresentationReleased) {
          try {
            host.restoreParentBoard(nextParentBoard);
          } catch (restoreError) {
            resetOpening(currentGeneration);
            return {
              status: "failed",
              code: "restore-failed",
              error: restoreError,
            };
          }
        }
        resetOpening(currentGeneration);
        return {
          status: "failed",
          code: parentPresentationReleased
            ? "host-transition-failed"
            : error?.code || "load-failed",
          error,
        };
      }
    }

    async function leave() {
      if (phase === "parent") return { status: "unchanged", reason: "already-parent" };

      generation += 1;
      if (phase === "opening") {
        openingController?.abort?.();
        openingController = null;
        parentItem = null;
        pageItems = [];
        phase = "parent";
        publishView();
        return { status: "cancelled", reason: "left-while-opening" };
      }
      const handle = documentHandle;
      const snapshot = parentBoard;
      documentHandle = null;
      parentBoard = null;
      phase = "leaving";
      publishView();
      let transitionError = null;
      try {
        host.releaseBoardPresentation();
      } catch (error) {
        transitionError = error;
      }
      if (snapshot) {
        try {
          host.restoreParentBoard(snapshot);
        } catch (error) {
          transitionError ||= error;
        }
      }
      parentItem = null;
      pageItems = [];
      phase = "parent";
      publishView();
      cleanupDetachedDocument(handle);
      if (transitionError) throw transitionError;
      return { status: "left" };
    }

    function resetOpening(currentGeneration) {
      if (generation !== currentGeneration) return;
      openingController = null;
      documentHandle = null;
      parentBoard = null;
      parentItem = null;
      pageItems = [];
      phase = "parent";
      publishView();
    }

    function cleanupDetachedDocument(handle) {
      if (!handle?.destroy) return;
      Promise.resolve()
        .then(() => handle.destroy())
        .catch((error) => {
          try {
            onCleanupError(error);
          } catch {}
        });
    }

    function renderPage({ pageItem, canvas, scale = 1, signal = null } = {}) {
      if (phase !== "active" || !documentHandle) {
        return Promise.reject(createPdfError("document-closed", "PDF 文件已關閉"));
      }
      if (!pageItems.includes(pageItem)) {
        return Promise.reject(createPdfError("stale-page", "PDF 頁面不屬於目前的白板"));
      }
      const pageNumber = Number(pageItem?.pdfPageNumber);
      if (!Number.isInteger(pageNumber) || pageNumber < 1) {
        return Promise.reject(createPdfError("invalid-page", "PDF 頁碼無效"));
      }
      return documentHandle.renderPage(pageNumber, canvas, { scale, signal });
    }

    function view() {
      const active = phase === "active";
      const parent = phase === "parent";
      return Object.freeze({
        phase,
        parentItem,
        pageCount: pageItems.length,
        capabilities: Object.freeze({
          parentBoardActions: parent,
          leave: !parent,
          renderPages: active,
        }),
      });
    }

    function publishView() {
      host.publishView(view());
    }

    return Object.freeze({
      renderPage,
      transition,
      view,
    });
  }

  async function loadPageItems(handle, parentItem, pageCount, { concurrency, signal } = {}) {
    const sizes = new Array(pageCount);
    let nextPage = 1;
    const workerCount = Math.min(
      pageCount,
      Math.max(1, positiveInteger(concurrency) || DEFAULT_PAGE_SIZE_CONCURRENCY),
    );

    async function worker() {
      while (true) {
        throwIfAborted(signal);
        const pageNumber = nextPage;
        nextPage += 1;
        if (pageNumber > pageCount) return;
        sizes[pageNumber - 1] = await handle.getPageSize(pageNumber);
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return sizes.map((size, index) =>
      createPdfPageItem(parentItem, index + 1, size, pageCount),
    );
  }

  function positiveInteger(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : 0;
  }

  function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) throw createAbortError();
  }

  function createAbortError() {
    const error = new Error("PDF page loading was aborted");
    error.name = "AbortError";
    error.code = "aborted";
    return error;
  }

  function createPdfError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  return Object.freeze({
    DEFAULT_PAGE_SIZE,
    DEFAULT_PAGE_SIZE_CONCURRENCY,
    createPdfBoardSession,
    createPdfPageItem,
  });
});

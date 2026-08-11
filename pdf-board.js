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
    onPageLoadError = () => {},
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
      typeof host.refreshPdfPageLayout !== "function" ||
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
    let pageCount = 0;
    let parentBoard = null;
    let sessionController = null;

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

      sessionController?.abort?.();
      const currentGeneration = ++generation;
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      sessionController = controller;
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
        const nextPageCount = positiveInteger(handle?.numPages);
        if (!nextPageCount) {
          cleanupDetachedDocument(handle);
          resetOpening(currentGeneration);
          return { status: "failed", code: "missing-page-count" };
        }

        const [firstPageItem] = await loadPageItems(handle, item, nextPageCount, {
          concurrency: 1,
          startPage: 1,
          endPage: 1,
          signal: controller?.signal,
        });
        if (generation !== currentGeneration) {
          cleanupDetachedDocument(handle);
          return { status: "cancelled", reason: "superseded" };
        }

        documentHandle = handle;
        parentBoard = nextParentBoard;
        pageItems = Array.from({ length: nextPageCount }, (_, index) =>
          createPdfPageItem(
            item,
            index + 1,
            { width: firstPageItem.width, height: firstPageItem.height },
            nextPageCount,
          ),
        );
        pageCount = nextPageCount;
        host.invalidateParentWork();
        parentPresentationReleased = true;
        host.releaseBoardPresentation();
        host.showPdfPages({ parentItem: item, pageItems: pageItems.slice() });
        phase = "active";
        publishView();
        host.focusFirstPage();
        scheduleRemainingPageMetrics({
          controller,
          currentGeneration,
          handle,
          item,
          totalPageCount: nextPageCount,
        });
        return { status: "entered", pageCount: nextPageCount };
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
        sessionController?.abort?.();
        sessionController = null;
        parentItem = null;
        pageItems = [];
        pageCount = 0;
        phase = "parent";
        publishView();
        return { status: "cancelled", reason: "left-while-opening" };
      }
      const handle = documentHandle;
      const snapshot = parentBoard;
      sessionController?.abort?.();
      sessionController = null;
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
      pageCount = 0;
      phase = "parent";
      publishView();
      cleanupDetachedDocument(handle);
      if (transitionError) throw transitionError;
      return { status: "left" };
    }

    function resetOpening(currentGeneration) {
      if (generation !== currentGeneration) return;
      sessionController = null;
      documentHandle = null;
      parentBoard = null;
      parentItem = null;
      pageItems = [];
      pageCount = 0;
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

    function scheduleRemainingPageMetrics({
      controller,
      currentGeneration,
      handle,
      item,
      totalPageCount,
    }) {
      if (totalPageCount <= 1) return;
      const run = () => {
        void hydrateRemainingPageMetrics({
          controller,
          currentGeneration,
          handle,
          item,
          totalPageCount,
        }).catch((error) => {
          if (!isActiveRevision(currentGeneration, handle)) return;
          safelyReport(onPageLoadError, error);
        });
      };
      if (typeof host.scheduleBackgroundWork === "function") {
        try {
          host.scheduleBackgroundWork(run);
          return;
        } catch (error) {
          safelyReport(onPageLoadError, error);
        }
      }
      Promise.resolve().then(run);
    }

    async function hydrateRemainingPageMetrics({
      controller,
      currentGeneration,
      handle,
      item,
      totalPageCount,
    }) {
      const batchSize = Math.max(
        1,
        positiveInteger(pageSizeConcurrency) || DEFAULT_PAGE_SIZE_CONCURRENCY,
      );
      const hydratedItems = [pageItems[0]];
      for (let startPage = 2; startPage <= totalPageCount; startPage += batchSize) {
        const endPage = Math.min(totalPageCount, startPage + batchSize - 1);
        const nextItems = await loadPageItems(handle, item, totalPageCount, {
          concurrency: pageSizeConcurrency,
          startPage,
          endPage,
          signal: controller?.signal,
        });
        if (!isActiveRevision(currentGeneration, handle)) return;
        hydratedItems.push(...nextItems);
      }
      if (!isActiveRevision(currentGeneration, handle)) return;

      const needsRelayout = hydratedItems.some(
        (nextItem, index) =>
          !sameAspectRatio(pageItems[index], nextItem),
      );
      for (let index = 1; index < hydratedItems.length; index += 1) {
        pageItems[index].width = hydratedItems[index].width;
        pageItems[index].height = hydratedItems[index].height;
      }
      if (needsRelayout) {
        host.refreshPdfPageLayout({
          parentItem: item,
          pageItems: pageItems.slice(),
          pageCount: totalPageCount,
        });
      }
    }

    function isActiveRevision(currentGeneration, handle) {
      return (
        generation === currentGeneration &&
        phase === "active" &&
        documentHandle === handle
      );
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
        pageCount,
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

  async function loadPageItems(
    handle,
    parentItem,
    pageCount,
    { concurrency, startPage = 1, endPage = pageCount, signal } = {},
  ) {
    const firstPage = Math.max(1, positiveInteger(startPage) || 1);
    const lastPage = Math.min(pageCount, positiveInteger(endPage) || pageCount);
    const itemCount = Math.max(0, lastPage - firstPage + 1);
    const sizes = new Array(itemCount);
    let nextPage = firstPage;
    const workerCount = Math.min(
      itemCount,
      Math.max(1, positiveInteger(concurrency) || DEFAULT_PAGE_SIZE_CONCURRENCY),
    );

    async function worker() {
      while (true) {
        throwIfAborted(signal);
        const pageNumber = nextPage;
        nextPage += 1;
        if (pageNumber > lastPage) return;
        sizes[pageNumber - firstPage] = await handle.getPageSize(pageNumber);
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return sizes.map((size, index) =>
      createPdfPageItem(parentItem, firstPage + index, size, pageCount),
    );
  }

  function safelyReport(callback, error) {
    try {
      callback(error);
    } catch {}
  }

  function sameAspectRatio(first, second) {
    const firstWidth = positiveNumber(first?.width, 0);
    const firstHeight = positiveNumber(first?.height, 0);
    const secondWidth = positiveNumber(second?.width, 0);
    const secondHeight = positiveNumber(second?.height, 0);
    if (!firstWidth || !firstHeight || !secondWidth || !secondHeight) return false;
    return Math.abs(firstWidth / firstHeight - secondWidth / secondHeight) < 0.0001;
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

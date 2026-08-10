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
    pageSizeConcurrency = DEFAULT_PAGE_SIZE_CONCURRENCY,
  } = {}) {
    if (!runtime?.openDocument) {
      throw new Error("PDF board session requires a PDF runtime");
    }

    let documentHandle = null;
    let parentItem = null;
    let pageItems = [];
    let opening = null;

    async function open(item, options = {}) {
      if (!isPdfItem(item)) throw createPdfError("not-pdf", "不是 PDF 素材");
      await closeDocument();

      const handle = await runtime.openDocument(item, options);
      const pageCount = positiveInteger(handle?.numPages);
      if (!pageCount) {
        await handle?.destroy?.();
        throw createPdfError("missing-page-count", "PDF 沒有可讀取的頁面");
      }

      const load = loadPageItems(handle, item, pageCount, {
        concurrency: pageSizeConcurrency,
        signal: options.signal,
      });
      opening = load;
      try {
        const nextPageItems = await load;
        if (opening !== load) throw createAbortError();
        documentHandle = handle;
        parentItem = item;
        pageItems = nextPageItems;
        return snapshot();
      } catch (error) {
        await handle.destroy?.();
        throw error;
      } finally {
        if (opening === load) opening = null;
      }
    }

    function renderPage(node, canvas, options = {}) {
      if (!documentHandle) {
        return Promise.reject(createPdfError("document-closed", "PDF 文件已關閉"));
      }
      const pageNumber = Number(node?.item?.pdfPageNumber || node?.pdfPageNumber);
      if (!Number.isInteger(pageNumber) || pageNumber < 1) {
        return Promise.reject(createPdfError("invalid-page", "PDF 頁碼無效"));
      }
      return documentHandle.renderPage(pageNumber, canvas, options);
    }

    async function closeDocument() {
      const handle = documentHandle;
      documentHandle = null;
      parentItem = null;
      pageItems = [];
      opening = null;
      await handle?.destroy?.();
    }

    function snapshot() {
      return Object.freeze({
        parentItem,
        pageItems: pageItems.slice(),
        pageCount: pageItems.length,
      });
    }

    return Object.freeze({
      close: closeDocument,
      get pageItems() {
        return pageItems;
      },
      get parentItem() {
        return parentItem;
      },
      get pageCount() {
        return pageItems.length;
      },
      open,
      renderPage,
      snapshot,
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

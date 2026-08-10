"use strict";

(function exposeBirdViewPdfRuntime(root, factory) {
  const core =
    root.BirdViewCore ||
    (typeof module === "object" && typeof require === "function"
      ? require("./bird-view-core.js")
      : null);
  const runtime = factory(core, root);
  if (typeof module === "object" && module.exports) module.exports = runtime;
  root.BirdViewPdfRuntime = runtime;
})(typeof globalThis === "object" ? globalThis : this, (core, root) => {
  const { isPdfItem } = core;

  const DEFAULT_WORKER_SRC = "vendor/pdfjs/pdf.worker.min.js";
  const DEFAULT_CMAP_URL = "vendor/pdfjs/cmaps/";
  const DEFAULT_STANDARD_FONT_DATA_URL = "vendor/pdfjs/standard_fonts/";

  function createPdfRuntime(options = {}) {
    const {
      pdfjsLib = root.pdfjsLib,
      document: documentRef = root.document,
      workerSrc = DEFAULT_WORKER_SRC,
      cMapUrl = DEFAULT_CMAP_URL,
      standardFontDataUrl = DEFAULT_STANDARD_FONT_DATA_URL,
      baseURI = documentRef?.baseURI || "",
      readFile = null,
      debugLog = () => {},
    } = options;
    let configuredWorkerSrc = null;

    function resolveAssetURL(path) {
      if (!path) return "";
      try {
        return new URL(path, baseURI || "http://bird-view.invalid/").href;
      } catch {
        return String(path);
      }
    }

    function configure() {
      const available = typeof pdfjsLib?.getDocument === "function";
      const workerOptions = pdfjsLib?.GlobalWorkerOptions;
      let workerConfigured = false;
      let workerError = null;

      if (available && workerOptions) {
        const nextWorkerSrc = resolveAssetURL(workerSrc);
        try {
          workerOptions.workerSrc = nextWorkerSrc;
          configuredWorkerSrc = workerOptions.workerSrc;
          workerConfigured = Boolean(configuredWorkerSrc);
        } catch (error) {
          workerError = error;
        }
      } else if (available) {
        workerError = new Error("PDF.js GlobalWorkerOptions is unavailable");
      }

      const result = {
        available,
        workerConfigured,
        workerSrc: configuredWorkerSrc,
        workerError: workerError ? describeError(workerError) : null,
        cMapUrl: resolveAssetURL(cMapUrl),
        standardFontDataUrl: resolveAssetURL(standardFontDataUrl),
      };
      debugLog("pdf-runtime-capabilities", result);
      return Object.freeze(result);
    }

    function buildDocumentInit(item, { data = null, password = null } = {}) {
      const source =
        data === null || data === undefined
          ? { url: String(item?.fileURL || item?.filePath || "") }
          : { data: toUint8Array(data) };
      const init = {
        ...source,
        cMapUrl: resolveAssetURL(cMapUrl),
        cMapPacked: true,
        standardFontDataUrl: resolveAssetURL(standardFontDataUrl),
      };
      if (password) init.password = password;
      return init;
    }

    async function openDocument(item, options = {}) {
      if (!isPdfItem(item)) throw createPdfError("not-pdf", "素材不是 PDF。");
      const capabilities = configure();
      if (!capabilities.available) {
        throw createPdfError("pdfjs-unavailable", "PDF.js runtime 尚未載入。");
      }

      const { data = null, password = null, signal = null } = options;
      const fileURL = String(item?.fileURL || item?.filePath || "").trim();
      if (data === null && !fileURL) {
        throw createPdfError("missing-source", "PDF 沒有可讀取的 fileURL。");
      }
      throwIfAborted(signal);

      let loadingTask = null;
      const abort = () => loadingTask?.destroy?.();
      signal?.addEventListener?.("abort", abort, { once: true });
      try {
        const source = await resolveDocumentSource(item, { data, password, signal });
        loadingTask = pdfjsLib.getDocument(buildDocumentInit(item, source));
        const document = await loadingTask.promise;
        throwIfAborted(signal);
        return createDocumentHandle(document, loadingTask, source.kind);
      } catch (error) {
        await destroyLoadingTask(loadingTask);
        throw normalizeError(error);
      } finally {
        signal?.removeEventListener?.("abort", abort);
      }
    }

    async function probe(item, options = {}) {
      const capabilities = configure();
      if (!isPdfItem(item)) {
        return { status: "unsupported", reason: "not-pdf", capabilities };
      }
      if (!capabilities.available) {
        return { status: "unsupported", reason: "pdfjs-unavailable", capabilities };
      }

      let handle = null;
      try {
        handle = await openDocument(item, options);
        const firstPage = await handle.getPageSize(1);
        return {
          status: "ok",
          capabilities,
          numPages: handle.numPages,
          firstPage,
          source: handle.source,
        };
      } catch (error) {
        return {
          status: "error",
          capabilities,
          reason: error.code || "load-failed",
          message: error.message || String(error),
        };
      } finally {
        await handle?.destroy?.();
      }
    }

    return Object.freeze({
      buildDocumentInit,
      configure,
      openDocument,
      probe,
      resolveAssetURL,
    });

    async function resolveDocumentSource(item, { data = null, password = null, signal = null } = {}) {
      if (data !== null && data !== undefined) {
        return { data, password, kind: "data" };
      }
      if (typeof readFile === "function") {
        try {
          const localData = await readFile(item);
          throwIfAborted(signal);
          if (localData !== null && localData !== undefined) {
            return { data: localData, password, kind: "data" };
          }
        } catch (error) {
          if (error?.code === "aborted" || error?.name === "AbortError") throw error;
          debugLog("pdf-source-read-fallback", {
            fileURL: item?.fileURL,
            message: error?.message || String(error),
          });
        }
      }
      return { data: null, password, kind: "url" };
    }

    function createDocumentHandle(document, loadingTask, source) {
      let destroyed = false;
      const activeRenders = new Set();

      function assertOpen() {
        if (destroyed) throw createPdfError("document-destroyed", "PDF 文件已關閉。");
      }

      function assertPageNumber(pageNumber) {
        const number = Number(pageNumber);
        if (!Number.isInteger(number) || number < 1 || number > document.numPages) {
          throw createPdfError("invalid-page", `PDF 頁碼無效：${pageNumber}。`);
        }
        return number;
      }

      async function getPageSize(pageNumber) {
        assertOpen();
        const number = assertPageNumber(pageNumber);
        const page = await document.getPage(number);
        try {
          const viewport = page.getViewport({ scale: 1 });
          return {
            width: Number(viewport.width) || 0,
            height: Number(viewport.height) || 0,
          };
        } finally {
          page.cleanup?.();
        }
      }

      function renderPage(pageNumber, canvas, options = {}) {
        let renderTask = null;
        let cancelled = false;
        const { scale = 1, signal = null } = options;
        const abort = () => {
          cancelled = true;
          renderTask?.cancel?.();
        };
        signal?.addEventListener?.("abort", abort, { once: true });
        const promise = (async () => {
          assertOpen();
          const number = assertPageNumber(pageNumber);
          const page = await document.getPage(number);
          try {
            if (cancelled) throw createAbortError();
            const viewport = page.getViewport({ scale: Number(scale) || 1 });
            const canvasContext = canvas?.getContext?.("2d");
            if (!canvasContext) {
              throw createPdfError("canvas-unavailable", "目前環境無法取得 PDF Canvas context。");
            }
            canvas.width = Math.max(1, Math.ceil(viewport.width));
            canvas.height = Math.max(1, Math.ceil(viewport.height));
            renderTask = page.render({ canvasContext, viewport });
            activeRenders.add(renderTask);
            await renderTask.promise;
            if (cancelled) throw createAbortError();
            return {
              pageNumber: number,
              width: canvas.width,
              height: canvas.height,
            };
          } finally {
            activeRenders.delete(renderTask);
            page.cleanup?.();
          }
        })();
        const cleanup = () => signal?.removeEventListener?.("abort", abort);
        promise.then(cleanup, cleanup);
        return {
          promise,
          cancel() {
            cancelled = true;
            renderTask?.cancel?.();
          },
        };
      }

      async function destroy() {
        if (destroyed) return;
        destroyed = true;
        for (const renderTask of activeRenders) renderTask.cancel?.();
        activeRenders.clear();
        try {
          await document.destroy?.();
        } finally {
          await destroyLoadingTask(loadingTask);
        }
      }

      return Object.freeze({
        source,
        get numPages() {
          return Number(document.numPages) || 0;
        },
        destroy,
        getPageSize,
        renderPage,
      });
    }
  }

  function toUint8Array(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    throw createPdfError("invalid-data", "PDF bytes 必須是 ArrayBuffer 或 Uint8Array。");
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) throw createAbortError();
  }

  function createAbortError() {
    const error = new Error("PDF 載入已取消。");
    error.name = "AbortError";
    error.code = "aborted";
    return error;
  }

  function createPdfError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function normalizeError(error) {
    if (error?.code) return error;
    const normalized = new Error(error?.message || String(error));
    normalized.code = error?.name === "AbortError" ? "aborted" : "load-failed";
    return normalized;
  }

  function describeError(error) {
    return { name: error?.name || "Error", message: error?.message || String(error) };
  }

  async function destroyLoadingTask(loadingTask) {
    try {
      await loadingTask?.destroy?.();
    } catch {
      // Cleanup must not replace the original PDF load error.
    }
  }

  return Object.freeze({
    DEFAULT_CMAP_URL,
    DEFAULT_STANDARD_FONT_DATA_URL,
    DEFAULT_WORKER_SRC,
    createPdfRuntime,
  });
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPdfRuntime } = require("../pdf-runtime.js");

function createFakePdfJs() {
  const calls = {
    documents: [],
    pageSizes: [],
    renders: [],
    documentDestroyed: 0,
    loadingTaskDestroyed: 0,
  };
  const pdfDocument = {
    numPages: 2,
    async getPage(pageNumber) {
      calls.pageSizes.push(pageNumber);
      return {
        getViewport({ scale }) {
          return { width: 600 * scale, height: 800 * scale };
        },
        render({ canvasContext, viewport }) {
          calls.renders.push({ canvasContext, viewport });
          return {
            promise: Promise.resolve(),
            cancel() {},
          };
        },
        cleanup() {},
      };
    },
    async destroy() {
      calls.documentDestroyed += 1;
    },
  };
  const loadingTask = {
    promise: Promise.resolve(pdfDocument),
    async destroy() {
      calls.loadingTaskDestroyed += 1;
    },
  };
  const pdfjsLib = {
    GlobalWorkerOptions: {},
    getDocument(init) {
      calls.documents.push(init);
      return loadingTask;
    },
  };
  return { calls, pdfjsLib };
}

function pdfItem() {
  return {
    id: "manual",
    name: "manual.pdf",
    ext: "PDF",
    fileURL: "file:///library/manual.pdf",
  };
}

function canvasStub() {
  return {
    width: 0,
    height: 0,
    getContext(kind) {
      return kind === "2d" ? {} : null;
    },
  };
}

test("PDF runtime configures a matching local worker and document assets", () => {
  const { pdfjsLib } = createFakePdfJs();
  const runtime = createPdfRuntime({
    pdfjsLib,
    baseURI: "file:///plugin/index.html",
  });

  const capabilities = runtime.configure();
  assert.equal(capabilities.available, true);
  assert.equal(capabilities.workerConfigured, true);
  assert.equal(
    capabilities.workerSrc,
    "file:///plugin/vendor/pdfjs/pdf.worker.min.js",
  );
  assert.equal(
    capabilities.cMapUrl,
    "file:///plugin/vendor/pdfjs/cmaps/",
  );
  assert.deepEqual(runtime.buildDocumentInit(pdfItem()), {
    url: "file:///library/manual.pdf",
    cMapUrl: "file:///plugin/vendor/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "file:///plugin/vendor/pdfjs/standard_fonts/",
  });
});

test("PDF runtime probes page count and first-page size, then releases the document", async () => {
  const { calls, pdfjsLib } = createFakePdfJs();
  const runtime = createPdfRuntime({ pdfjsLib, baseURI: "file:///plugin/index.html" });

  const result = await runtime.probe(pdfItem());

  assert.equal(result.status, "ok");
  assert.equal(result.source, "url");
  assert.equal(result.numPages, 2);
  assert.deepEqual(result.firstPage, { width: 600, height: 800 });
  assert.equal(calls.documents[0].url, "file:///library/manual.pdf");
  assert.equal(calls.documentDestroyed, 1);
  assert.equal(calls.loadingTaskDestroyed, 1);
});

test("PDF runtime prefers a local file reader so file:// loading does not depend on fetch", async () => {
  const { calls, pdfjsLib } = createFakePdfJs();
  const bytes = new Uint8Array([37, 80, 68, 70]);
  const runtime = createPdfRuntime({
    pdfjsLib,
    readFile: async () => bytes,
    baseURI: "file:///plugin/index.html",
  });

  const result = await runtime.probe(pdfItem());

  assert.equal(result.status, "ok");
  assert.equal(result.source, "data");
  assert.equal(calls.documents[0].data, bytes);
  assert.equal("url" in calls.documents[0], false);
});

test("PDF runtime exposes bounded page rendering behind the document handle", async () => {
  const { calls, pdfjsLib } = createFakePdfJs();
  const runtime = createPdfRuntime({ pdfjsLib, baseURI: "file:///plugin/index.html" });
  const document = await runtime.openDocument(pdfItem());
  const canvas = canvasStub();

  const render = document.renderPage(2, canvas, { scale: 0.5 });
  const result = await render.promise;

  assert.deepEqual(result, { pageNumber: 2, width: 300, height: 400 });
  assert.equal(canvas.width, 300);
  assert.equal(canvas.height, 400);
  assert.equal(calls.renders.length, 1);
  assert.equal(calls.renders[0].viewport.width, 300);
  await document.destroy();
});

test("PDF runtime reports missing PDF.js without throwing from the probe", async () => {
  const runtime = createPdfRuntime({ pdfjsLib: null });
  const result = await runtime.probe(pdfItem());

  assert.deepEqual(
    { status: result.status, reason: result.reason },
    { status: "unsupported", reason: "pdfjs-unavailable" },
  );
});

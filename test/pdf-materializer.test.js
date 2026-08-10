"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createElementStub } = require("../test-support/plugin-harness.js");
const { createMediaMaterializer } = require("../media-materializer.js");
const { MediaLoadQueue } = require("../media-load-queue.js");

function createHarness(options = {}) {
  const world = createElementStub("div");
  const created = [];
  const document = {
    createElement(tag) {
      const element = createElementStub(tag);
      created.push(element);
      return element;
    },
  };
  const queue = new MediaLoadQueue({ maxConcurrent: 4 });
  const opened = [];
  const materializer = createMediaMaterializer({
    document,
    window: { setTimeout, clearTimeout },
    world,
    mediaLoadQueue: queue,
    getNodeScreenLongEdge: options.getNodeScreenLongEdge || (() => 800),
    onPositionNode() {},
    onClickNode() {},
    onSelectNode() {},
    onOpenContextMenu() {},
    onOpenPdf: (node) => opened.push(node),
    renderPdfPage: options.renderPdfPage,
    onLayoutChange() {},
    getVideoControlsHeight: () => 8,
    getVideoVolume: () => 1,
    onVolumeChange() {},
    showToast() {},
    debugLog() {},
    startVideoPlayer() {},
  });
  return { created, materializer, opened, queue, world };
}

function createPdfNode() {
  return {
    item: {
      id: "document",
      name: "document.pdf",
      ext: "pdf",
      fileURL: "file:///document.pdf",
      thumbnailURL: "file:///document-thumb.jpg",
    },
    width: 135,
    mediaHeight: 180,
    height: 180,
    rotation: 0,
  };
}

test("PDF page overlays explicitly hide when their hidden attribute is set", () => {
  const styles = fs.readFileSync(path.resolve(__dirname, "../styles.css"), "utf8");
  assert.match(
    styles,
    /\.pdf-page-placeholder\[hidden\][\s\S]*\.pdf-page-retry-button\[hidden\][\s\S]*display:\s*none/,
  );
});

test("PDF outer cards use the thumbnail and open a PDF board on double click", () => {
  const harness = createHarness();
  const node = createPdfNode();

  harness.materializer.mount(node);
  harness.materializer.preloadSelected(node);

  assert.ok(node.element.querySelector(".pdf-visual"));
  assert.equal(
    node.element.querySelector(".pdf-entry-badge").textContent,
    "PDF · 雙擊進入",
  );
  assert.deepEqual(harness.queue.snapshot(node).loadingQuality, "thumbnail");
  node.element.querySelector("img").emit("load");
  node.element.emit("dblclick");
  assert.deepEqual(harness.opened, [node]);
});

test("PDF page cards render through the shared media queue and cancel on release", async () => {
  let resolveRender;
  let renderOptions;
  const harness = createHarness({
    renderPdfPage(options) {
      renderOptions = options;
      options.canvas.width = 300;
      options.canvas.height = 400;
      return {
        promise: new Promise((resolve) => {
          resolveRender = resolve;
        }),
        cancel() {},
      };
    },
  });
  const node = createPdfNode();
  node.item = {
    ...node.item,
    id: "document:page:1",
    name: "document.pdf · 第 1 頁",
    ext: "pdf-page",
    width: 600,
    height: 800,
    isPdfPage: true,
    pdfPageNumber: 1,
  };

  harness.materializer.mount(node);
  harness.materializer.preloadSelected(node);

  assert.equal(harness.queue.snapshot(node).loadingQuality, "original");
  assert.equal(node.element.querySelector(".pdf-page-number"), null);
  assert.equal(renderOptions.node, node);
  assert.equal(renderOptions.scale, 1.28);
  assert.equal(node.element.querySelector(".pdf-page-placeholder").hidden, false);

  resolveRender();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.queue.snapshot(node).readyQuality, "original");
  assert.equal(node.element.querySelector(".pdf-page-canvas").style.visibility, "visible");
  assert.equal(node.element.querySelector(".pdf-page-placeholder").hidden, true);

  harness.materializer.releaseAll();
  assert.equal(node.element, null);
  assert.equal(node.mediaElement, null);
});

test("PDF page cards re-render at a larger budget after zooming in", async () => {
  let screenLongEdge = 800;
  const renders = [];
  const harness = createHarness({
    getNodeScreenLongEdge: () => screenLongEdge,
    renderPdfPage(options) {
      renders.push(options);
      options.canvas.width = Math.ceil(600 * options.scale);
      options.canvas.height = Math.ceil(800 * options.scale);
      return Promise.resolve();
    },
  });
  const node = createPdfNode();
  node.item = {
    ...node.item,
    id: "document:page:1",
    name: "document.pdf · 第 1 頁",
    ext: "pdf-page",
    width: 600,
    height: 800,
    isPdfPage: true,
    pdfPageNumber: 1,
  };

  harness.materializer.mount(node);
  harness.materializer.preloadSelected(node);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(renders.length, 1);
  assert.equal(renders[0].budget, 1024);
  const firstCanvas = renders[0].canvas;
  assert.equal(firstCanvas.style.visibility, "visible");

  screenLongEdge = 1500;
  harness.materializer.syncQuality({
    loadNodes: [node],
    getQuality: () => "original",
  });

  assert.equal(renders.length, 2);
  assert.equal(renders[1].budget, 1536);
  assert.notEqual(renders[1].canvas, firstCanvas);
  assert.equal(firstCanvas.style.visibility, "visible");

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(node.mediaElement, renders[1].canvas);
  assert.equal(firstCanvas.parentNode, null);
  assert.equal(renders[1].canvas.style.visibility, "visible");
});

test("PDF page cards keep the previous raster when a sharper render fails", async () => {
  let screenLongEdge = 800;
  let renderCount = 0;
  const harness = createHarness({
    getNodeScreenLongEdge: () => screenLongEdge,
    renderPdfPage(options) {
      renderCount += 1;
      options.canvas.width = Math.ceil(600 * options.scale);
      options.canvas.height = Math.ceil(800 * options.scale);
      return renderCount === 1
        ? Promise.resolve()
        : Promise.reject(new Error("render failed"));
    },
  });
  const node = createPdfNode();
  node.item = {
    ...node.item,
    id: "document:page:1",
    ext: "pdf-page",
    width: 600,
    height: 800,
    isPdfPage: true,
    pdfPageNumber: 1,
  };

  harness.materializer.mount(node);
  harness.materializer.preloadSelected(node);
  await new Promise((resolve) => setImmediate(resolve));
  const firstCanvas = node.mediaElement;

  screenLongEdge = 1500;
  harness.materializer.syncQuality({
    loadNodes: [node],
    getQuality: () => "original",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(node.mediaElement, firstCanvas);
  assert.equal(firstCanvas.style.visibility, "visible");
  assert.equal(node.element.querySelector(".pdf-page-placeholder").hidden, true);
  assert.equal(node.element.querySelector(".pdf-page-retry-button").hidden, false);
  assert.equal(harness.created.at(-1).width, 0);
  assert.equal(harness.created.at(-1).height, 0);
});

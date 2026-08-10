"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPluginHarness } = require("../../test-support/plugin-harness.js");

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createPdfJsProbe() {
  const calls = [];
  const pdfDocument = {
    numPages: 3,
    async getPage(pageNumber) {
      calls.push(["getPage", pageNumber]);
      return {
        getViewport({ scale }) {
          return { width: 600 * scale, height: 800 * scale };
        },
        render() {
          return {
            promise: Promise.resolve(),
            cancel() {},
          };
        },
        cleanup() {},
      };
    },
    async destroy() {
      calls.push(["document-destroy"]);
    },
  };
  const pdfjsLib = {
    GlobalWorkerOptions: {},
    getDocument(init) {
      calls.push(["getDocument", init]);
      return {
        promise: Promise.resolve(pdfDocument),
        async destroy() {
          calls.push(["loading-destroy"]);
        },
      };
    },
  };
  return { calls, pdfjsLib };
}

test("PDF enters as virtual pages and returns without polluting the parent board", async () => {
  const probe = createPdfJsProbe();
  const parentItem = {
    id: "manual",
    name: "manual.pdf",
    ext: "pdf",
    width: 600,
    height: 800,
    fileURL: "file:///manual.pdf",
    thumbnailURL: "file:///manual-thumb.jpg",
  };
  const plugin = createPluginHarness({
    selectedItems: [parentItem],
    pdfjsLib: probe.pdfjsLib,
    navigationProbe: true,
    runAnimationFrames: true,
  });

  plugin.start();
  await flush();
  assert.equal(plugin.state.selectedNode.item.id, "manual");

  plugin.keyDown({ key: "Enter", target: null, preventDefault() {} });
  await flush();
  await flush();

  assert.equal(plugin.state.pdfMode, true);
  assert.equal(plugin.state.selectedNode.item.isPdfPage, true);
  assert.equal(plugin.state.selectedNode.item.pdfPageNumber, 1);
  assert.equal(plugin.elements.get("#item-count").textContent, "3 個 PDF 頁面");
  assert.equal(plugin.elements.get("#pdf-board-back-button").hidden, false);
  assert.equal(plugin.elements.get("#board-history-back-button").disabled, true);
  assert.equal(plugin.state.pdfBoardSession.pageCount, 3);
  const pageLabel = plugin.createdElements.find((element) =>
    element.classList.contains("is-pdf-page-label"),
  );
  assert.ok(pageLabel);
  assert.equal(pageLabel.querySelector(".media-name").textContent, "第 1 / 3 頁");
  assert.equal(
    plugin.elements.get("#pdf-board-breadcrumb").textContent,
    "PDF：manual.pdf · 第 1 / 3 頁",
  );
  assert.ok(plugin.elements.get("#world").children.length > 0);
  const canvases = plugin.createdElementsOfTag("canvas");
  assert.ok(canvases.length > 0, "PDF page cards should create canvases");
  assert.ok(canvases.some((canvas) => canvas.width > 0 && canvas.height > 0));
  assert.ok(canvases.some((canvas) => canvas.style.visibility === "visible"));
  assert.ok(
    plugin.createdElements
      .filter((element) => element.classList.contains("pdf-page-placeholder"))
      .some((placeholder) => placeholder.hidden),
  );
  plugin.keyDown({ key: "ArrowRight", ctrlKey: true, target: null, preventDefault() {} });
  await flush();
  assert.equal(plugin.state.selectedNode.item.pdfPageNumber, 2);
  assert.equal(
    plugin.elements.get("#pdf-board-breadcrumb").textContent,
    "PDF：manual.pdf · 第 2 / 3 頁",
  );

  plugin.elements.get("#auto-explore-settings-panel").hidden = true;
  plugin.keyDown({ key: "Escape", target: null, preventDefault() {} });
  await flush();

  assert.equal(plugin.state.pdfMode, false);
  assert.equal(plugin.state.selectedNode.item.id, "manual");
  assert.equal(plugin.elements.get("#item-count").textContent, "1 個素材");
  assert.equal(plugin.elements.get("#pdf-board-back-button").hidden, true);
  assert.ok(probe.calls.some(([name]) => name === "document-destroy"));
});

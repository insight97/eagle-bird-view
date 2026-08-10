"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPdfBoardSession, createPdfPageItem } = require("../pdf-board.js");

function createRuntime() {
  const calls = [];
  const handle = {
    numPages: 3,
    async getPageSize(pageNumber) {
      calls.push(["size", pageNumber]);
      return { width: 600 + pageNumber, height: 800 + pageNumber };
    },
    renderPage(pageNumber, canvas, options) {
      calls.push(["render", pageNumber, canvas, options]);
      return Promise.resolve({ pageNumber });
    },
    async destroy() {
      calls.push(["destroy"]);
    },
  };
  return {
    calls,
    handle,
    async openDocument(item) {
      calls.push(["open", item.id]);
      return handle;
    },
  };
}

test("PDF board session creates ordered virtual page items and delegates rendering", async () => {
  const runtime = createRuntime();
  const parentItem = { id: "pdf-1", name: "guide.pdf", ext: "pdf", fileURL: "file:///guide.pdf" };
  const session = createPdfBoardSession({ runtime, pageSizeConcurrency: 2 });

  const result = await session.open(parentItem);

  assert.equal(result.pageCount, 3);
  assert.deepEqual(
    result.pageItems.map((item) => [item.id, item.pdfPageNumber, item.width, item.height]),
    [
      ["pdf-1:page:1", 1, 601, 801],
      ["pdf-1:page:2", 2, 602, 802],
      ["pdf-1:page:3", 3, 603, 803],
    ],
  );
  assert.equal(result.pageItems[0].isPdfPage, true);
  assert.equal(result.pageItems[0].pdfParentItem, parentItem);

  const canvas = {};
  await session.renderPage({ item: result.pageItems[1] }, canvas, { scale: 0.5 });
  assert.equal(runtime.calls[0][0], "open");
  assert.deepEqual(runtime.calls.filter(([type]) => type === "size"), [
    ["size", 1],
    ["size", 2],
    ["size", 3],
  ]);
  assert.equal(runtime.calls.at(-1)[0], "render");
  assert.equal(runtime.calls.at(-1)[1], 2);
  assert.equal(runtime.calls.at(-1)[2], canvas);

  await session.close();
  assert.equal(runtime.calls.at(-1)[0], "destroy");
  assert.equal(session.pageCount, 0);
});

test("PDF page item keeps virtual pages separate from Eagle metadata", () => {
  const parentItem = { id: "pdf-2", name: "paper.pdf", ext: "pdf" };
  const page = createPdfPageItem(parentItem, 4, { width: 100, height: 200 }, 8);

  assert.deepEqual(
    {
      id: page.id,
      name: page.name,
      ext: page.ext,
      width: page.width,
      height: page.height,
      isPdfPage: page.isPdfPage,
      pdfPageNumber: page.pdfPageNumber,
      pdfPageCount: page.pdfPageCount,
    },
    {
      id: "pdf-2:page:4",
      name: "paper.pdf · 第 4 頁",
      ext: "pdf-page",
      width: 100,
      height: 200,
      isPdfPage: true,
      pdfPageNumber: 4,
      pdfPageCount: 8,
    },
  );
  assert.equal("tags" in page, false);
  assert.equal("folders" in page, false);
});

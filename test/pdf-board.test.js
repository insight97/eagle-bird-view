"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPdfBoardSession, createPdfPageItem } = require("../pdf-board.js");

function createRuntime({ events = [], destroyError = null } = {}) {
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
      events.push(["destroy"]);
      if (destroyError) throw destroyError;
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

function createHost(calls = []) {
  const parentBoard = Object.freeze({ id: "parent-board" });
  return {
    calls,
    parentBoard,
    host: {
      captureParentBoard() {
        calls.push(["capture"]);
        return parentBoard;
      },
      invalidateParentWork() {
        calls.push(["invalidate"]);
      },
      releaseBoardPresentation() {
        calls.push(["release"]);
      },
      showPdfPages(details) {
        calls.push(["show-pages", details]);
      },
      restoreParentBoard(snapshot) {
        calls.push(["restore", snapshot]);
      },
      publishView(view) {
        calls.push(["view", view]);
      },
      focusFirstPage() {
        calls.push(["focus-first-page"]);
      },
    },
  };
}

test("PDF board session keeps the parent Board until every virtual page is ready", async () => {
  const runtime = createRuntime();
  const { calls, host } = createHost();
  const parentItem = { id: "pdf-1", name: "guide.pdf", ext: "pdf", fileURL: "file:///guide.pdf" };
  const session = createPdfBoardSession({ runtime, host, pageSizeConcurrency: 2 });

  const transition = session.transition({ type: "enter", item: parentItem });

  assert.equal(session.view().phase, "opening");
  assert.deepEqual(calls.map(([type]) => type), ["capture", "view"]);

  const result = await transition;

  assert.deepEqual(result, { status: "entered", pageCount: 3 });
  assert.equal(session.view().phase, "active");
  assert.equal(session.view().parentItem, parentItem);
  assert.equal(session.view().pageCount, 3);
  const pageItems = calls.find(([type]) => type === "show-pages")[1].pageItems;
  assert.deepEqual(
    pageItems.map((item) => [item.id, item.pdfPageNumber, item.width, item.height]),
    [
      ["pdf-1:page:1", 1, 601, 801],
      ["pdf-1:page:2", 2, 602, 802],
      ["pdf-1:page:3", 3, 603, 803],
    ],
  );
  assert.equal(pageItems[0].isPdfPage, true);
  assert.equal(pageItems[0].pdfParentItem, parentItem);
  assert.deepEqual(runtime.calls.filter(([type]) => type === "size"), [
    ["size", 1],
    ["size", 2],
    ["size", 3],
  ]);
  assert.deepEqual(calls.map(([type]) => type), [
    "capture",
    "view",
    "invalidate",
    "release",
    "show-pages",
    "view",
    "focus-first-page",
  ]);
});

test("PDF board session restores the parent Board before best-effort cleanup", async () => {
  const events = [];
  const cleanupErrors = [];
  const runtime = createRuntime({
    events,
    destroyError: new Error("cleanup failed"),
  });
  const { host, parentBoard } = createHost(events);
  const session = createPdfBoardSession({
    runtime,
    host,
    onCleanupError: (error) => cleanupErrors.push(error),
  });
  await session.transition({
    type: "enter",
    item: { id: "pdf-1", name: "guide.pdf", ext: "pdf", fileURL: "file:///guide.pdf" },
  });
  events.length = 0;

  const result = await session.transition({ type: "leave", reason: "user" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(result, { status: "left" });
  assert.equal(session.view().phase, "parent");
  assert.equal(session.view().parentItem, null);
  assert.equal(session.view().capabilities.parentBoardActions, true);
  assert.deepEqual(events.map(([type]) => type), [
    "view",
    "release",
    "restore",
    "view",
    "destroy",
  ]);
  assert.equal(events.find(([type]) => type === "restore")[1], parentBoard);
  assert.equal(cleanupErrors.length, 1);
  assert.equal(cleanupErrors[0].message, "cleanup failed");
});

test("leaving while a PDF opens keeps stale pages off the parent Board", async () => {
  let resolveOpen;
  let openingSignal;
  const events = [];
  const handle = {
    numPages: 1,
    async getPageSize() {
      events.push(["size"]);
      return { width: 600, height: 800 };
    },
    async destroy() {
      events.push(["destroy"]);
    },
  };
  const runtime = {
    openDocument(item, options) {
      events.push(["open", item.id]);
      openingSignal = options.signal;
      return new Promise((resolve) => {
        resolveOpen = resolve;
      });
    },
  };
  const { host } = createHost(events);
  const session = createPdfBoardSession({ runtime, host });

  const entering = session.transition({
    type: "enter",
    item: { id: "slow-pdf", name: "slow.pdf", ext: "pdf", fileURL: "file:///slow.pdf" },
  });
  const leaving = await session.transition({ type: "leave", reason: "content-replacement" });

  assert.deepEqual(leaving, { status: "cancelled", reason: "left-while-opening" });
  assert.equal(openingSignal.aborted, true);
  assert.equal(session.view().phase, "parent");
  assert.deepEqual(events.map(([type]) => type), ["capture", "view", "open", "view"]);

  resolveOpen(handle);
  const stale = await entering;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(stale, { status: "cancelled", reason: "superseded" });
  assert.equal(events.some(([type]) => type === "show-pages"), false);
  assert.equal(events.some(([type]) => type === "restore"), false);
  assert.equal(events.at(-1)[0], "destroy");
});

test("PDF board session renders only pages owned by the active revision", async () => {
  const runtime = createRuntime();
  const firstHost = createHost();
  const session = createPdfBoardSession({ runtime, host: firstHost.host });
  await session.transition({
    type: "enter",
    item: { id: "first-pdf", name: "first.pdf", ext: "pdf", fileURL: "file:///first.pdf" },
  });
  const firstPages = firstHost.calls.find(([type]) => type === "show-pages")[1].pageItems;
  const canvas = {};

  await session.renderPage({ pageItem: firstPages[1], canvas, scale: 0.5 });

  assert.equal(runtime.calls.at(-1)[0], "render");
  assert.equal(runtime.calls.at(-1)[1], 2);
  assert.equal(runtime.calls.at(-1)[2], canvas);

  await session.transition({ type: "leave", reason: "user" });
  await session.transition({
    type: "enter",
    item: { id: "second-pdf", name: "second.pdf", ext: "pdf", fileURL: "file:///second.pdf" },
  });

  await assert.rejects(
    session.renderPage({ pageItem: firstPages[1], canvas, scale: 1 }),
    (error) => error.code === "stale-page",
  );
});

test("a failed PDF Board commit restores the released parent Board", async () => {
  const events = [];
  const runtime = createRuntime({ events });
  const { host, parentBoard } = createHost(events);
  host.showPdfPages = (details) => {
    events.push(["show-pages", details]);
    throw new Error("commit failed");
  };
  const session = createPdfBoardSession({ runtime, host });

  const result = await session.transition({
    type: "enter",
    item: { id: "pdf-1", name: "guide.pdf", ext: "pdf", fileURL: "file:///guide.pdf" },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.status, "failed");
  assert.equal(result.code, "host-transition-failed");
  assert.equal(session.view().phase, "parent");
  assert.deepEqual(events.map(([type]) => type), [
    "capture",
    "view",
    "invalidate",
    "release",
    "show-pages",
    "restore",
    "view",
    "destroy",
  ]);
  assert.equal(events.find(([type]) => type === "restore")[1], parentBoard);
});

test("a parent restoration error cannot leave the PDF board session locked", async () => {
  const events = [];
  const runtime = createRuntime({ events });
  const { host } = createHost(events);
  host.restoreParentBoard = (snapshot) => {
    events.push(["restore", snapshot]);
    throw new Error("restore failed");
  };
  const session = createPdfBoardSession({ runtime, host });
  await session.transition({
    type: "enter",
    item: { id: "pdf-1", name: "guide.pdf", ext: "pdf", fileURL: "file:///guide.pdf" },
  });
  events.length = 0;

  await assert.rejects(
    session.transition({ type: "leave", reason: "user" }),
    /restore failed/,
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(session.view().phase, "parent");
  assert.deepEqual(events.map(([type]) => type), [
    "view",
    "release",
    "restore",
    "view",
    "destroy",
  ]);
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

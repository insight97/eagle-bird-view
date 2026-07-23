"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const BirdViewCore = require("../../bird-view-core.js");
const BirdViewMedia = require("../../media-load-queue.js");

const ORIGINAL_IMAGE_LOAD_TIMEOUT = 8000;

function createStyle() {
  const store = {};
  return new Proxy(store, {
    get(target, prop) {
      if (prop === "setProperty") return (name, value) => { target[name] = value; };
      if (prop === "removeProperty") return (name) => { delete target[name]; };
      return target[prop];
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

function createStubElement(tag = "div") {
  const listeners = new Map();
  const attributes = {};
  const el = {
    tagName: tag,
    dataset: {},
    style: createStyle(),
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [],
    parentNode: null,
    isConnected: false,
    hidden: false,
    textContent: "",
    value: "",
    title: "",
    clientWidth: 1200,
    clientHeight: 800,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) {
      listeners.get(type)?.delete(callback);
    },
    _fire(type, eventLike = {}) {
      const event = { stopPropagation() {}, preventDefault() {}, target: el, ...eventLike };
      for (const callback of [...(listeners.get(type) || [])]) callback(event);
    },
    click() {
      el._fire("click");
    },
    setAttribute(name, value) {
      attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    },
    removeAttribute(name) {
      delete attributes[name];
    },
    append(...nodes) {
      for (const node of nodes) {
        node.parentNode = el;
        node.isConnected = true;
        el.children.push(node);
      }
    },
    remove() {
      if (!el.parentNode) return;
      const index = el.parentNode.children.indexOf(el);
      if (index !== -1) el.parentNode.children.splice(index, 1);
      el.parentNode = null;
      el.isConnected = false;
    },
    replaceWith(...nodes) {
      const parent = el.parentNode;
      if (!parent) return;
      const index = parent.children.indexOf(el);
      if (index === -1) return;
      parent.children.splice(index, 1, ...nodes);
      for (const node of nodes) {
        node.parentNode = parent;
        node.isConnected = true;
      }
      el.parentNode = null;
      el.isConnected = false;
    },
    replaceChildren(...nodes) {
      el.children.length = 0;
      el.append(...nodes);
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: el.clientWidth, height: el.clientHeight };
    },
  };
  return el;
}

function buildPlugin(item) {
  const elementsById = new Map();
  const createdElements = [];
  const timers = [];
  let nextTimerId = 1;
  let domReady;
  let pluginCreate;

  const context = {
    BirdViewCore,
    BirdViewMedia,
    BirdViewExploration: {
      RelatedItemSource: class {
        clear() {}
      },
      UnratedItemSource: class {
        clear() {}
        async findNextRow() {
          return [];
        }
      },
    },
    BirdViewVideo: { startVideoPlayer() {} },
    BirdViewTagEditor: {
      TagEditor: class {
        close() {}
        closeForNode() {}
        refresh() {}
      },
    },
    BirdViewCamera: {
      createCameraNavigation() {
        return {
          animateCameraTo() {},
          cancelCameraFocus() {},
          fitSelectedRowInViewport() {},
          focusSelectedNodeAtRowScale() {},
          getKeyboardPanStep() { return 240; },
          handleKeyUp() {},
          handleWindowBlur() {},
          panBy() {},
          panOneViewport() {},
          startSmoothKeyboardPan() {},
          startSmoothKeyboardZoom() {},
          stopSmoothKeyboardPan() {},
          stopSmoothKeyboardZoom() {},
          zoomAtPoint() {},
        };
      },
    },
    BirdViewSelection: {
      createSelectionNavigation() {
        return {
          clearSelection() {},
          moveSelection() { return null; },
          selectNodeAtViewportCenter() {},
          setSelectedNode() {},
        };
      },
    },
    document: {
      addEventListener(type, callback) {
        if (type === "DOMContentLoaded") domReady = callback;
      },
      querySelector(selector) {
        if (!elementsById.has(selector)) elementsById.set(selector, createStubElement());
        return elementsById.get(selector);
      },
      createElement(tag) {
        const element = createStubElement(tag);
        createdElements.push(element);
        return element;
      },
    },
    eagle: {
      item: {
        async getSelected() {
          return [item];
        },
        async open() {},
      },
      tag: {
        async get() {
          return [];
        },
      },
      onPluginCreate(callback) {
        pluginCreate = callback;
      },
      onLibraryChanged() {},
    },
    window: {
      addEventListener() {},
      removeEventListener() {},
      setTimeout(callback, delay) {
        const id = nextTimerId++;
        timers.push({ id, callback, delay });
        return id;
      },
      clearTimeout(id) {
        const index = timers.findIndex((timer) => timer.id === id);
        if (index !== -1) timers.splice(index, 1);
      },
    },
    requestAnimationFrame(callback) {
      callback(0);
      return 1;
    },
    cancelAnimationFrame() {},
    performance: { now: () => 0 },
    console,
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.resolve(__dirname, "../../plugin.js"), "utf8");
  vm.runInContext(source, context);

  return {
    async start() {
      domReady();
      pluginCreate();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    createdElements,
    fireTimer(delay) {
      const index = timers.findIndex((timer) => timer.delay === delay);
      if (index === -1) throw new Error(`no timer scheduled with delay ${delay}`);
      const [timer] = timers.splice(index, 1);
      timer.callback();
    },
  };
}

function jpgItem(overrides = {}) {
  return {
    id: "item-1",
    name: "photo.jpg",
    ext: "jpg",
    width: 1600,
    height: 1000,
    size: 5_000_000,
    star: 0,
    tags: [],
    fileURL: "file:///fake/original.jpg",
    thumbnailURL: "file:///fake/thumb.jpg",
    ...overrides,
  };
}

test("a stalled original image load times out, offers retry, and recovers", async () => {
  const item = jpgItem();
  const plugin = buildPlugin(item);
  await plugin.start();

  const thumbnailImage = plugin.createdElements.find((el) => el.tagName === "img");
  assert.ok(thumbnailImage, "thumbnail <img> should have been created");
  const card = thumbnailImage.parentNode.parentNode;
  assert.equal(card.tagName, "article");

  thumbnailImage._fire("load");

  const originalImage = plugin.createdElements.filter((el) => el.tagName === "img")[1];
  assert.ok(originalImage, "original <img> should start loading right after the thumbnail");
  assert.equal(originalImage.getAttribute && originalImage.src, "file:///fake/original.jpg");
  assert.equal(card.dataset.mediaQuality, "loading-original");

  // The original never fires "load" or "error" (a stalled file:// request).
  // Only the watchdog timer can recover from this.
  plugin.fireTimer(ORIGINAL_IMAGE_LOAD_TIMEOUT);

  assert.equal(card.dataset.mediaQuality, "original-failed");
  const retryButton = plugin.createdElements.find((el) => el.tagName === "button");
  assert.ok(retryButton, "retry button should exist");
  assert.equal(retryButton.textContent, "原圖載入逾時，重試");

  retryButton.click();
  assert.equal(card.dataset.mediaQuality, "loading-original");

  const retriedImage = plugin.createdElements.filter((el) => el.tagName === "img").at(-1);
  assert.notEqual(retriedImage, originalImage);
  retriedImage._fire("load");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(card.dataset.mediaQuality, "original");
});

test("a thumbnail that never loads still times out the pending original request", async () => {
  const item = jpgItem({ id: "item-2" });
  const plugin = buildPlugin(item);
  await plugin.start();

  const thumbnailImage = plugin.createdElements.find((el) => el.tagName === "img");
  const card = thumbnailImage.parentNode.parentNode;

  // Simulate the thumbnail itself hanging: no "load" and no "error" ever fires.
  // The original quality request is still only "pending" at this point.
  assert.equal(card.dataset.mediaQuality, "loading-thumbnail");

  plugin.fireTimer(ORIGINAL_IMAGE_LOAD_TIMEOUT);

  assert.equal(card.dataset.mediaQuality, "original-failed");
  const retryButton = plugin.createdElements.find((el) => el.tagName === "button");
  assert.equal(retryButton.textContent, "原圖載入逾時，重試");
});

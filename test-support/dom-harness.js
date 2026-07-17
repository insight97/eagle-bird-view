"use strict";

const fs = require("node:fs");
const path = require("node:path");

const WINDOW_BUNDLE = path.resolve(__dirname, "../.test-cache/happy-dom-window.cjs");
let windowClassPromise;

const DOM_GLOBALS = [
  "window",
  "document",
  "Element",
  "HTMLElement",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
  "requestAnimationFrame",
  "cancelAnimationFrame",
];

async function withDom(run) {
  const Window = await loadWindowClass();
  const window = new Window({ url: "https://bird-view.test/" });
  const originals = new Map(
    DOM_GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(global, name)]),
  );

  Object.assign(global, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    requestAnimationFrame: (callback) => {
      callback(0);
      return 1;
    },
    cancelAnimationFrame() {},
  });

  try {
    return await run(window);
  } finally {
    await window.happyDOM.abort();
    window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(global, name, descriptor);
      else delete global[name];
    }
  }
}

function loadWindowClass() {
  if (!windowClassPromise) {
    windowClassPromise = fs.existsSync(WINDOW_BUNDLE)
      ? Promise.resolve(require(WINDOW_BUNDLE).default)
      : import("happy-dom").then((module) => module.Window);
  }
  return windowClassPromise;
}

module.exports = { withDom };

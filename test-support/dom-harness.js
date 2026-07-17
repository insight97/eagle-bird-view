"use strict";

const { parseHTML } = require("linkedom");

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
  const { window } = parseHTML("<!doctype html><html><body></body></html>");
  if (!window.KeyboardEvent) {
    window.KeyboardEvent = class KeyboardEvent extends window.Event {
      constructor(type, init = {}) {
        super(type, init);
        this.key = init.key || "";
      }
    };
  }
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
    PointerEvent: window.PointerEvent || window.Event,
    requestAnimationFrame: (callback) => {
      callback(0);
      return 1;
    },
    cancelAnimationFrame() {},
  });

  try {
    return await run(window);
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(global, name, descriptor);
      else delete global[name];
    }
  }
}

module.exports = { withDom };

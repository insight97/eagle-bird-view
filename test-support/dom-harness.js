"use strict";

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
  const { Window } = await import("happy-dom");
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

module.exports = { withDom };

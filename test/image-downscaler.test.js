"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createImageDownscaler } = require("../image-downscaler.js");

function createEnvironment({
  createImageBitmap,
  fetch,
  toBlob,
  getContext,
  offscreen = false,
} = {}) {
  const bitmaps = [];
  const canvases = [];
  const drawn = [];
  const fetched = [];
  const revoked = [];
  let urlCount = 0;

  const windowRef = {
    fetch:
      fetch ||
      (async (url) => {
        fetched.push(url);
        return { ok: true, async blob() { return { url, type: "image/jpeg" }; } };
      }),
    createImageBitmap:
      createImageBitmap ||
      (async (source, options) => {
        const bitmap = { source, options, closed: false };
        bitmap.close = () => {
          bitmap.closed = true;
        };
        bitmaps.push(bitmap);
        return bitmap;
      }),
    URL: {
      createObjectURL(blob) {
        urlCount += 1;
        return `blob:raster-${urlCount}:${blob.type}`;
      },
      revokeObjectURL(url) {
        revoked.push(url);
      },
    },
  };

  const contextFactory =
    getContext ||
    (() => ({
      drawImage(...args) {
        drawn.push(args);
      },
    }));
  const makeContext = () => contextFactory();

  if (offscreen) {
    windowRef.OffscreenCanvas = class {
      constructor(width, height) {
        this.width = width;
        this.height = height;
        this.isOffscreen = true;
        canvases.push(this);
      }
      getContext() {
        return makeContext();
      }
      async convertToBlob({ type, quality }) {
        return { type, quality };
      }
    };
  }

  const documentRef = {
    createElement(tag) {
      const canvas = {
        tagName: String(tag).toUpperCase(),
        width: 0,
        height: 0,
        isOffscreen: false,
        getContext: makeContext,
        toBlob:
          toBlob ||
          ((callback, type, quality) => {
            callback({ type, quality });
          }),
      };
      canvases.push(canvas);
      return canvas;
    },
  };

  return {
    bitmaps,
    canvases,
    drawn,
    fetched,
    revoked,
    downscaler: createImageDownscaler({ window: windowRef, document: documentRef }),
  };
}

test("rendering from a URL decodes straight to the bounded size", async () => {
  const environment = createEnvironment();

  const url = await environment.downscaler.renderFromURL("file:///painting.png", {
    width: 363,
    height: 512,
  });

  assert.equal(url, "blob:raster-1:image/webp");
  assert.deepEqual(environment.fetched, ["file:///painting.png"]);
  // The encoded bytes go to createImageBitmap, never a full-resolution bitmap.
  assert.deepEqual(environment.bitmaps[0].source, {
    url: "file:///painting.png",
    type: "image/jpeg",
  });
  assert.deepEqual(environment.bitmaps[0].options, {
    resizeWidth: 363,
    resizeHeight: 512,
    resizeQuality: "high",
  });
  assert.equal(environment.canvases[0].width, 363);
  assert.equal(environment.canvases[0].height, 512);
  assert.equal(environment.bitmaps[0].closed, true);
});

test("an OffscreenCanvas is preferred so the encode leaves the main thread", async () => {
  const environment = createEnvironment({ offscreen: true });

  const url = await environment.downscaler.renderFromURL("file:///painting.png", {
    width: 363,
    height: 512,
  });

  assert.equal(url, "blob:raster-1:image/webp");
  assert.equal(environment.canvases.length, 1);
  assert.equal(environment.canvases[0].isOffscreen, true);
});

test("rendering from an already decoded element is the fallback path", async () => {
  const environment = createEnvironment();
  const image = { naturalWidth: 5374, naturalHeight: 7589 };

  const url = await environment.downscaler.renderFromImage(image, {
    width: 363,
    height: 512,
  });

  assert.equal(url, "blob:raster-1:image/webp");
  assert.deepEqual(environment.fetched, [], "the element path must not refetch");
  assert.equal(environment.bitmaps[0].source, image);
  assert.equal(environment.bitmaps[0].closed, true);
});

test("a blocked fetch reports no raster instead of throwing", async () => {
  const blocked = createEnvironment({
    fetch: async () => {
      throw new Error("not allowed to load local resource");
    },
  });
  assert.equal(
    await blocked.downscaler.renderFromURL("file:///painting.png", { width: 10, height: 10 }),
    null,
  );

  const rejected = createEnvironment({ fetch: async () => ({ ok: false }) });
  assert.equal(
    await rejected.downscaler.renderFromURL("file:///painting.png", { width: 10, height: 10 }),
    null,
  );
});

test("the decoded bitmap is closed even when encoding fails", async () => {
  const environment = createEnvironment({
    toBlob(callback) {
      callback(null);
    },
  });

  assert.equal(
    await environment.downscaler.renderFromURL("file:///painting.png", {
      width: 10,
      height: 10,
    }),
    null,
  );
  assert.equal(environment.bitmaps[0].closed, true);
});

test("a failed decode degrades to no raster", async () => {
  const environment = createEnvironment({
    createImageBitmap: async () => {
      throw new Error("decode failed");
    },
  });

  assert.equal(
    await environment.downscaler.renderFromURL("file:///x.png", { width: 10, height: 10 }),
    null,
  );
  assert.equal(await environment.downscaler.renderFromImage({}, { width: 10, height: 10 }), null);
});

test("a canvas without a 2d context degrades to no raster", async () => {
  const environment = createEnvironment({ getContext: () => null });

  assert.equal(
    await environment.downscaler.renderFromURL("file:///x.png", { width: 10, height: 10 }),
    null,
  );
});

test("capabilities are reported separately for the URL and element paths", async () => {
  const noBitmap = createImageDownscaler({
    window: { fetch: async () => ({}), URL: { createObjectURL: () => "blob:x" } },
    document: { createElement: () => ({}) },
  });
  assert.equal(noBitmap.isSupported(), false);
  assert.equal(noBitmap.canRenderFromURL(), false);

  const noFetch = createImageDownscaler({
    window: { createImageBitmap: async () => ({}), URL: { createObjectURL: () => "blob:x" } },
    document: { createElement: () => ({}) },
  });
  assert.equal(noFetch.isSupported(), true);
  assert.equal(noFetch.canRenderFromURL(), false);
  assert.equal(await noFetch.renderFromURL("file:///x.png", { width: 5, height: 5 }), null);
});

test("invalid sizes are rejected before any work happens", async () => {
  const environment = createEnvironment();

  assert.equal(await environment.downscaler.renderFromURL("file:///x.png", { width: 0, height: 5 }), null);
  assert.equal(await environment.downscaler.renderFromURL("file:///x.png", {}), null);
  assert.equal(await environment.downscaler.renderFromURL(null, { width: 5, height: 5 }), null);
  assert.equal(await environment.downscaler.renderFromImage(null, { width: 5, height: 5 }), null);
  assert.deepEqual(environment.fetched, []);
  assert.equal(environment.bitmaps.length, 0);
});

test("revoking releases the URL and tolerates a missing one", () => {
  const environment = createEnvironment();

  environment.downscaler.revoke("blob:raster-1:image/webp");
  environment.downscaler.revoke(null);
  environment.downscaler.revoke(undefined);

  assert.deepEqual(environment.revoked, ["blob:raster-1:image/webp"]);
});

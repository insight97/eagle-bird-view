"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createImageDownscaler } = require("../image-downscaler.js");

function createEnvironment({ createImageBitmap, fetch } = {}) {
  const bitmaps = [];
  const fetched = [];

  const windowRef = {
    fetch:
      fetch ||
      (async (url) => {
        fetched.push(url);
        return {
          ok: true,
          async blob() {
            return { url, type: "image/jpeg" };
          },
        };
      }),
    createImageBitmap:
      createImageBitmap ||
      (async (source, options) => {
        const bitmap = {
          source,
          options,
          width: options.resizeWidth,
          height: options.resizeHeight,
          closed: false,
          close() {
            bitmap.closed = true;
          },
        };
        bitmaps.push(bitmap);
        return bitmap;
      }),
  };

  return { bitmaps, fetched, downscaler: createImageDownscaler({ window: windowRef }) };
}

test("rendering from a URL decodes straight to the bounded size", async () => {
  const environment = createEnvironment();

  const bitmap = await environment.downscaler.renderFromURL("file:///painting.png", {
    width: 363,
    height: 512,
  });

  assert.equal(bitmap, environment.bitmaps[0]);
  assert.deepEqual(environment.fetched, ["file:///painting.png"]);
  // The encoded bytes go to createImageBitmap, so no full-resolution bitmap is
  // ever built, and nothing is encoded on the way back out.
  assert.deepEqual(bitmap.source, { url: "file:///painting.png", type: "image/jpeg" });
  // EXIF rotation has to be baked into the bitmap: a canvas paints what it is
  // given, unlike an <img> honouring image-orientation.
  assert.deepEqual(bitmap.options, {
    resizeWidth: 363,
    resizeHeight: 512,
    resizeQuality: "high",
    imageOrientation: "from-image",
  });
  assert.equal(bitmap.closed, false, "the caller owns the bitmap");
});

test("rendering from an already decoded element is the fallback path", async () => {
  const environment = createEnvironment();
  const image = { naturalWidth: 5374, naturalHeight: 7589 };

  const bitmap = await environment.downscaler.renderFromImage(image, {
    width: 363,
    height: 512,
  });

  assert.equal(bitmap.source, image);
  assert.deepEqual(environment.fetched, [], "the element path must not refetch");
});

test("a blocked fetch reports no bitmap instead of throwing", async () => {
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

test("a failed decode degrades to no bitmap", async () => {
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

test("capabilities are reported separately for the URL and element paths", async () => {
  const noBitmap = createImageDownscaler({ window: { fetch: async () => ({}) } });
  assert.equal(noBitmap.isSupported(), false);
  assert.equal(noBitmap.canRenderFromURL(), false);

  const noFetch = createImageDownscaler({ window: { createImageBitmap: async () => ({}) } });
  assert.equal(noFetch.isSupported(), true);
  assert.equal(noFetch.canRenderFromURL(), false);
  assert.equal(await noFetch.renderFromURL("file:///x.png", { width: 5, height: 5 }), null);
});

test("invalid sizes are rejected before any work happens", async () => {
  const environment = createEnvironment();

  assert.equal(
    await environment.downscaler.renderFromURL("file:///x.png", { width: 0, height: 5 }),
    null,
  );
  assert.equal(await environment.downscaler.renderFromURL("file:///x.png", {}), null);
  assert.equal(await environment.downscaler.renderFromURL(null, { width: 5, height: 5 }), null);
  assert.equal(await environment.downscaler.renderFromImage(null, { width: 5, height: 5 }), null);
  assert.deepEqual(environment.fetched, []);
  assert.equal(environment.bitmaps.length, 0);
});

test("releasing closes the bitmap and tolerates one already transferred", () => {
  const environment = createEnvironment();
  const bitmap = { closed: false, close() { this.closed = true; } };

  environment.downscaler.release(bitmap);
  assert.equal(bitmap.closed, true);

  // Transferring into a canvas consumes the bitmap, so a later close throws.
  environment.downscaler.release({
    close() {
      throw new Error("already transferred");
    },
  });
  environment.downscaler.release(null);
  environment.downscaler.release(undefined);
});

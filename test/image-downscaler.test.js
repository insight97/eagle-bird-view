"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createImageDownscaler } = require("../image-downscaler.js");

function createEnvironment({ createImageBitmap, fetch, readFile, document } = {}) {
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
      (async (source, options = {}) => {
        const bitmap = {
          source,
          options,
          width: options.resizeWidth || source.width,
          height: options.resizeHeight || source.height,
          closed: false,
          close() {
            bitmap.closed = true;
          },
        };
        bitmaps.push(bitmap);
        return bitmap;
      }),
  };

  return {
    bitmaps,
    fetched,
    downscaler: createImageDownscaler({ window: windowRef, document, readFile }),
  };
}

// Without stored dimensions the decoder has no start-of-frame to read, which is
// how a source whose size is unknown reaches the plan.
function createJpegWithOrientation(orientation) {
  return new Blob([createTaggedJpeg(orientation)], { type: "image/jpeg" });
}

function createCanvasDocument() {
  const operations = [];
  let canvas = null;
  const context = {
    get canvas() {
      return canvas;
    },
    save() {
      operations.push(["save"]);
    },
    restore() {
      operations.push(["restore"]);
    },
    translate(x, y) {
      operations.push(["translate", x, y]);
    },
    rotate(radians) {
      operations.push(["rotate", radians]);
    },
    scale(x, y) {
      operations.push(["scale", x, y]);
    },
    drawImage(...args) {
      operations.push(["drawImage", ...args]);
    },
  };
  return {
    operations,
    document: {
      createElement(tag) {
        assert.equal(tag, "canvas");
        canvas = {
          width: 0,
          height: 0,
          getContext(kind) {
            return kind === "2d" ? context : null;
          },
        };
        return canvas;
      },
    },
    getCanvas: () => canvas,
  };
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
    resizeQuality: "medium",
    imageOrientation: "from-image",
  });
  assert.equal(bitmap.closed, false, "the caller owns the bitmap");
});

test("PNG and WebP URL decodes use medium resize quality", async () => {
  let mimeType = "image/png";
  const environment = createEnvironment({
    fetch: async (url) => ({
      ok: true,
      async blob() {
        return { url, type: mimeType };
      },
    }),
  });

  const png = await environment.downscaler.renderFromURL("file:///painting.png", {
    width: 363,
    height: 512,
  });
  mimeType = "image/webp";
  const webp = await environment.downscaler.renderFromURL("file:///painting.webp", {
    width: 363,
    height: 512,
  });

  assert.equal(png.options.resizeQuality, "medium");
  assert.equal(webp.options.resizeQuality, "medium");
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
  const failures = [];
  const blocked = createEnvironment({
    fetch: async () => {
      throw new Error("not allowed to load local resource");
    },
  });
  assert.equal(
    await blocked.downscaler.renderFromURL(
      "file:///painting.png",
      { width: 10, height: 10 },
      { onFailure: (failure) => failures.push(failure) },
    ),
    null,
  );
  assert.deepEqual(failures, [{ stage: "fetch", reason: "request-failed" }]);

  const rejected = createEnvironment({ fetch: async () => ({ ok: false }) });
  assert.equal(
    await rejected.downscaler.renderFromURL("file:///painting.png", { width: 10, height: 10 }),
    null,
  );
});

test("a blocked local fetch can use an injected file reader for bounded raster", async () => {
  const reads = [];
  const environment = createEnvironment({
    fetch: async () => {
      throw new Error("file access is blocked");
    },
    readFile: async (url) => {
      reads.push(url);
      return new Uint8Array([0xff, 0xd8, 0xff]);
    },
  });

  const bitmap = await environment.downscaler.renderFromURL("file:///painting.jpg", {
    width: 363,
    height: 512,
  });

  assert.ok(bitmap, "the bounded raster should survive a blocked fetch");
  assert.deepEqual(reads, ["file:///painting.jpg"]);
  assert.equal(bitmap.source.size, 3, "the reader bytes should become an image source");
  assert.equal(bitmap.width, 363);
  assert.equal(bitmap.height, 512);
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

// Some Eagle Chromium builds reject imageOrientation when it is combined with
// resize options. The fallback must still decode the EXIF-oriented source first;
// otherwise the canvas path turns portrait photos sideways as soon as the raster
// replaces the initial <img>.
test("a platform refusing combined orientation and resize still keeps orientation", async () => {
  const attempts = [];
  let orientedBitmap = null;
  const environment = createEnvironment({
    createImageBitmap: async (source, options) => {
      attempts.push({ source, options });
      if ("imageOrientation" in options && "resizeWidth" in options) {
        throw new TypeError("unsupported combination");
      }
      if ("imageOrientation" in options) {
        orientedBitmap = {
          source,
          options,
          width: 5374,
          height: 7589,
          closed: false,
          close() {
            this.closed = true;
          },
        };
        return orientedBitmap;
      }
      return { source, options, width: options.resizeWidth, height: options.resizeHeight };
    },
  });

  const bitmap = await environment.downscaler.renderFromURL("file:///x.jpg", {
    width: 363,
    height: 512,
  });

  assert.ok(bitmap, "the raster must survive the platform refusing the option");
  assert.equal(attempts.length, 3, "it should orient first, then resize the oriented bitmap");
  assert.equal("imageOrientation" in attempts[0].options, true);
  assert.equal("imageOrientation" in attempts[1].options, true);
  assert.equal("resizeWidth" in attempts[1].options, false);
  assert.equal(attempts[2].source, orientedBitmap);
  assert.equal("imageOrientation" in attempts[2].options, false);
  assert.equal(orientedBitmap.closed, true, "the temporary oriented bitmap is released");

  // Later decodes reuse the two-step fallback rather than retrying the rejected
  // option combination.
  await environment.downscaler.renderFromURL("file:///y.jpg", { width: 10, height: 10 });
  assert.equal(attempts.length, 5);
});

test("a platform without image orientation still returns a bounded raster", async () => {
  const attempts = [];
  const environment = createEnvironment({
    createImageBitmap: async (source, options) => {
      attempts.push(options);
      if ("imageOrientation" in options) throw new TypeError("unsupported option");
      return { source, options, width: options.resizeWidth, height: options.resizeHeight };
    },
  });

  const bitmap = await environment.downscaler.renderFromURL("file:///x.jpg", {
    width: 363,
    height: 512,
  });

  assert.ok(bitmap);
  assert.equal(attempts.length, 4, "it should retry with bounded options");
  assert.equal("imageOrientation" in attempts[0], true);
  assert.equal("imageOrientation" in attempts[1], true);
  assert.equal(attempts[2].imageOrientation, "none");
  assert.equal("imageOrientation" in attempts[3], false);
  assert.equal(bitmap.width, 363);
  assert.equal(bitmap.height, 512);
});

test("a JPEG EXIF quarter-turn is applied when native image orientation is unavailable", async () => {
  const canvasProbe = createCanvasDocument();
  const attempts = [];
  const environment = createEnvironment({
    document: canvasProbe.document,
    fetch: async () => {
      throw new Error("file access is blocked");
    },
    readFile: async () => createJpegWithOrientation(6),
    createImageBitmap: async (source, options = {}) => {
      attempts.push({ source, options });
      if ("imageOrientation" in options) throw new TypeError("unsupported option");
      if (source === canvasProbe.getCanvas()) {
        return { source, width: source.width, height: source.height };
      }
      return {
        source,
        options,
        width: options.resizeWidth,
        height: options.resizeHeight,
        close() {},
      };
    },
  });

  const bitmap = await environment.downscaler.renderFromURL("file:///portrait.jpg", {
    width: 363,
    height: 512,
  });

  assert.equal(bitmap.width, 363);
  assert.equal(bitmap.height, 512);
  assert.equal(attempts[0].options.imageOrientation, "none");
  // Both edges are stated in stored order: a derived edge would be the
  // platform's guess at which aspect ratio to preserve.
  const rawAttempt = attempts.find(
    ({ options }) => options.resizeWidth === 512 && !("imageOrientation" in options),
  );
  assert.deepEqual(rawAttempt?.options, {
    resizeWidth: 512,
    resizeHeight: 363,
    resizeQuality: "medium",
  });
  assert.deepEqual(canvasProbe.operations.slice(0, 3), [
    ["save"],
    ["translate", 363, 0],
    ["rotate", Math.PI / 2],
  ]);
  assert.equal(canvasProbe.operations[3][0], "drawImage");
  assert.equal(canvasProbe.operations[3][1].source, rawAttempt.source);
  assert.deepEqual(canvasProbe.operations[3].slice(2), [0, 0, 512, 363]);
  assert.deepEqual(canvasProbe.operations[4], ["restore"]);
});

test("an EXIF-tagged source never asks the platform to orient it", async () => {
  const canvasProbe = createCanvasDocument();
  const attempts = [];
  const environment = createEnvironment({
    document: canvasProbe.document,
    fetch: async () => ({
      ok: true,
      async blob() {
        return createJpegWithOrientation(6);
      },
    }),
    createImageBitmap: async (source, options = {}) => {
      attempts.push({ source, options });
      if (source === canvasProbe.getCanvas()) {
        return { source, width: source.width, height: source.height };
      }
      return {
        source,
        options,
        width: options.resizeWidth || 7589,
        height: options.resizeHeight || 5374,
        close() {},
      };
    },
  });

  const bitmap = await environment.downscaler.renderFromURL("file:///accepted-but-wrong.jpg", {
    width: 363,
    height: 512,
  });

  assert.equal(bitmap.source, canvasProbe.getCanvas());
  assert.equal(
    attempts.some(({ options }) => options.imageOrientation === "from-image"),
    false,
    "EXIF-oriented sources must not trust the native option",
  );
  assert.equal(bitmap.width, 363);
  assert.equal(bitmap.height, 512);
});

test("a source-specific orientation failure does not poison later images", async () => {
  const environment = createEnvironment({
    createImageBitmap: async (source, options) => {
      if (source.url === "file:///broken.jpg") throw new Error("unsupported image data");
      return { source, options, width: options.resizeWidth, height: options.resizeHeight };
    },
  });

  assert.equal(
    await environment.downscaler.renderFromURL("file:///broken.jpg", { width: 10, height: 10 }),
    null,
  );
  assert.ok(
    await environment.downscaler.renderFromURL("file:///healthy.jpg", {
      width: 10,
      height: 10,
    }),
    "a failed source must not disable later image decodes",
  );
});

test("a real decode failure is still reported once orientation is known good", async () => {
  let calls = 0;
  const environment = createEnvironment({
    createImageBitmap: async (source, options) => {
      calls += 1;
      if (calls === 1) return { source, options, width: 1, height: 1 };
      throw new Error("corrupt file");
    },
  });

  assert.ok(await environment.downscaler.renderFromURL("file:///ok.jpg", { width: 1, height: 1 }));
  assert.equal(
    await environment.downscaler.renderFromURL("file:///bad.jpg", { width: 1, height: 1 }),
    null,
  );
  assert.equal(calls, 2, "no pointless retry once the option is known to work");
});

// Op-by-op assertions on the canvas cannot tell a correct transform from one
// that draws off-canvas or not at all, so the orientation table below decodes a
// tagged picture end to end and checks where each pixel landed. The stored
// picture numbers its pixels row-major; the expected picture is the same numbers
// in the positions the EXIF direction defines.
function createOrientedProbe({ storedWidth, storedHeight, orientation, nativeOrientation }) {
  const stored = {
    width: storedWidth,
    height: storedHeight,
    pixels: Array.from({ length: storedWidth * storedHeight }, (unused, index) => index),
  };
  const upright = orientPixels(stored, orientation);

  function resample(image, width, height) {
    const pixels = new Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const u = Math.min(image.width - 1, Math.floor((x / width) * image.width));
        const v = Math.min(image.height - 1, Math.floor((y / height) * image.height));
        pixels[y * width + x] = image.pixels[v * image.width + u];
      }
    }
    return { width, height, pixels };
  }

  const source = new Blob([createTaggedJpeg(orientation, storedWidth, storedHeight)]);
  const decodeRequests = [];
  const windowRef = {
    Blob,
    async createImageBitmap(input, options = {}) {
      if (input === source) decodeRequests.push(options);
      if (nativeOrientation === "reject" && "imageOrientation" in options) {
        throw new TypeError("unsupported option");
      }
      // The measured Eagle build: its ImageOrientation enum has no "from-image"
      // at all, EXIF is applied whatever the option says, and the resize is
      // measured in stored pixels before the rotation — so the edges come back
      // swapped from what was asked for.
      if (nativeOrientation === "eagle") {
        if (options.imageOrientation === "from-image") {
          throw new TypeError(
            "Failed to read the 'imageOrientation' property from 'ImageBitmapOptions'",
          );
        }
        const encoded = input instanceof Blob;
        const image = encoded ? stored : input;
        const sized = resample(
          image,
          options.resizeWidth || image.width,
          options.resizeHeight || image.height,
        );
        // Only the untouched source still carries a direction; a neutralised
        // copy is a different blob and decodes upright.
        const tagged = input === source ? orientation : 1;
        return { ...(encoded ? orientPixels(sized, tagged) : sized), close() {} };
      }
      const encoded = input instanceof Blob;
      // Only the untouched source still carries a direction; a neutralised copy
      // is a different blob and decodes upright.
      const tagged = input === source ? orientation : 1;
      let image = encoded ? stored : input;
      const wants = options.imageOrientation ?? "from-image";
      if (encoded && tagged !== 1 && wants === "from-image" && nativeOrientation === "honest") {
        image = upright;
      }
      // A missing resize dimension is derived from the aspect ratio — and this
      // decoder derives it from the upright shape even when asked for the
      // stored one, which is why the decoder must never be given only one.
      let width = options.resizeWidth;
      let height = options.resizeHeight;
      const intrinsic = orientPixels(image, orientation);
      if (width && !height) height = Math.round((width / intrinsic.width) * intrinsic.height);
      if (height && !width) width = Math.round((height / intrinsic.height) * intrinsic.width);
      return { ...resample(image, width || image.width, height || image.height), close() {} };
    },
  };

  return {
    upright,
    decodeRequests,
    downscaler: createImageDownscaler({
      window: windowRef,
      document: { createElement: () => createPaintedCanvas() },
      readFile: async () => source,
    }),
  };
}

function orientPixels(stored, orientation) {
  const swaps = orientation >= 5 && orientation <= 8;
  const width = swaps ? stored.height : stored.width;
  const height = swaps ? stored.width : stored.height;
  const pixels = new Array(width * height).fill(null);
  for (let v = 0; v < stored.height; v += 1) {
    for (let u = 0; u < stored.width; u += 1) {
      const [x, y] = {
        2: [width - 1 - u, v],
        3: [width - 1 - u, height - 1 - v],
        4: [u, height - 1 - v],
        5: [v, u],
        6: [width - 1 - v, u],
        7: [width - 1 - v, height - 1 - u],
        8: [v, height - 1 - u],
      }[orientation] || [u, v];
      pixels[y * width + x] = stored.pixels[v * stored.width + u];
    }
  }
  return { width, height, pixels };
}

// A 2d context that keeps a real transform matrix, so drawImage puts pixels
// where the browser would put them.
function createPaintedCanvas() {
  const compose = (m, n) => ({
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  });
  let matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const stack = [];
  const canvas = {
    width: 0,
    height: 0,
    pixels: [],
    getContext: (kind) => (kind === "2d" ? context : null),
  };
  const context = {
    save: () => stack.push({ ...matrix }),
    restore: () => {
      matrix = stack.pop() || matrix;
    },
    translate: (x, y) => {
      matrix = compose(matrix, { a: 1, b: 0, c: 0, d: 1, e: x, f: y });
    },
    rotate: (radians) => {
      const cos = Math.round(Math.cos(radians));
      const sin = Math.round(Math.sin(radians));
      matrix = compose(matrix, { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 });
    },
    scale: (x, y) => {
      matrix = compose(matrix, { a: x, b: 0, c: 0, d: y, e: 0, f: 0 });
    },
    drawImage(bitmap, dx, dy, dw, dh) {
      const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
      const inverse = {
        a: matrix.d / determinant,
        b: -matrix.b / determinant,
        c: -matrix.c / determinant,
        d: matrix.a / determinant,
        e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant,
        f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant,
      };
      canvas.pixels = new Array(canvas.width * canvas.height).fill(null);
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          const px = x + 0.5;
          const py = y + 0.5;
          const sx = inverse.a * px + inverse.c * py + inverse.e;
          const sy = inverse.b * px + inverse.d * py + inverse.f;
          if (sx < dx || sy < dy || sx >= dx + dw || sy >= dy + dh) continue;
          const u = Math.floor(((sx - dx) / dw) * bitmap.width);
          const v = Math.floor(((sy - dy) / dh) * bitmap.height);
          canvas.pixels[y * canvas.width + x] = bitmap.pixels[v * bitmap.width + u];
        }
      }
    },
  };
  return canvas;
}

function createTaggedJpeg(orientation, storedWidth = 0, storedHeight = 0) {
  const hasFrame = storedWidth > 0 && storedHeight > 0;
  const bytes = new Uint8Array(hasFrame ? 51 : 38);
  bytes.set([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x22], 0);
  bytes.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 6);
  bytes.set([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08], 12);
  bytes.set([0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01], 20);
  bytes.set([0x00, orientation, 0x00, 0x00], 30);
  if (!hasFrame) return bytes;
  // Start of frame: precision, then the stored height and width.
  bytes.set(
    [
      0xff, 0xc0, 0x00, 0x0b, 0x08,
      (storedHeight >> 8) & 0xff, storedHeight & 0xff,
      (storedWidth >> 8) & 0xff, storedWidth & 0xff,
      0x01, 0x01, 0x11, 0x00,
    ],
    38,
  );
  return bytes;
}

// Whether the platform honours imageOrientation, ignores it, or refuses it, and
// whether Eagle reports the upright or the stored dimensions, the raster has to
// come out upright: a card that paints a sideways one appears to spin the photo
// the moment a zoom crosses the threshold where the raster replaces the <img>.
for (const nativeOrientation of ["honest", "ignored", "reject", "eagle"]) {
  for (const metadata of ["upright", "stored"]) {
    test(`EXIF directions survive a ${nativeOrientation} platform and ${metadata} metadata`, async () => {
      for (const [storedWidth, storedHeight] of [[4, 2], [2, 4], [3, 3]]) {
        for (let orientation = 1; orientation <= 8; orientation += 1) {
          const probe = createOrientedProbe({
            storedWidth,
            storedHeight,
            orientation,
            nativeOrientation,
          });
          const requested =
            metadata === "upright"
              ? { width: probe.upright.width, height: probe.upright.height }
              : { width: storedWidth, height: storedHeight };

          const bitmap = await probe.downscaler.renderFromURL("file:///photo.jpg", requested);

          const detail = `${storedWidth}x${storedHeight} orientation ${orientation}`;
          for (const request of probe.decodeRequests) {
            assert.ok(
              ("resizeWidth" in request && "resizeHeight" in request) ||
                !("resizeWidth" in request || "resizeHeight" in request),
              `both resize edges or neither for ${detail}: ${JSON.stringify(request)}`,
            );
          }
          assert.ok(bitmap, `a raster is required for ${detail}`);
          assert.equal(bitmap.width, probe.upright.width, `width for ${detail}`);
          assert.equal(bitmap.height, probe.upright.height, `height for ${detail}`);
          assert.deepEqual(bitmap.pixels, probe.upright.pixels, `pixels for ${detail}`);
        }
      }
    });
  }
}

// Blob.arrayBuffer() postdates the Chromium this runs on. Losing the byte read
// loses the EXIF direction with it, and the card paints an untagged picture
// sideways — silently, because every later branch behaves as though the photo
// were upright.
test("the EXIF direction is still read where Blob.arrayBuffer is unavailable", async () => {
  const jpeg = createTaggedJpeg(6, 4000, 3000);
  for (const supply of ["bytes", "legacy blob"]) {
    const profiles = [];
    const downscaler = createImageDownscaler({
      window: {
        Blob,
        FileReader: class {
          readAsArrayBuffer(blob) {
            blob
              .arrayBuffer()
              .then((buffer) => {
                this.result = buffer;
                this.onload();
              })
              .catch(() => this.onerror());
          }
        },
        createImageBitmap: async (source, options = {}) => ({
          source,
          options,
          width: options.resizeWidth || 1,
          height: options.resizeHeight || 1,
          close() {},
        }),
      },
      document: { createElement: () => null },
      readFile: async () =>
        supply === "bytes"
          ? jpeg
          : Object.assign(new Blob([jpeg]), { arrayBuffer: undefined }),
    });

    await downscaler.renderFromURL(
      "file:///portrait.jpg",
      { width: 384, height: 512 },
      { onProfile: (details) => profiles.push(details) },
    );

    assert.equal(profiles[0]?.orientation, 6, `orientation via ${supply}`);
    assert.equal(profiles[0]?.width, 4000, `stored width via ${supply}`);
    assert.equal(profiles[0]?.height, 3000, `stored height via ${supply}`);
  }
});

// Bytes that name the direction settle the question outright. Probing the
// platform anyway costs two rejected decodes per session on a build whose
// ImageOrientation enum has no "from-image" at all.
test("an upright picture never asks the platform about orientation", async () => {
  const requests = [];
  const downscaler = createImageDownscaler({
    window: {
      Blob,
      createImageBitmap: async (source, options = {}) => {
        requests.push(options);
        return { source, options, width: options.resizeWidth, height: options.resizeHeight };
      },
    },
    readFile: async () => createTaggedJpeg(1, 4000, 3000),
  });

  const bitmap = await downscaler.renderFromURL("file:///upright.jpg", {
    width: 512,
    height: 384,
  });

  assert.ok(bitmap);
  assert.equal(
    requests.some(({ imageOrientation }) => imageOrientation === "from-image"),
    false,
  );
  assert.equal(requests.length, 1, "one decode, at the requested size");
  assert.equal(requests[0].resizeWidth, 512);
  assert.equal(requests[0].resizeHeight, 384);
});

// PNG carries the direction in an eXIf chunk and the size in IHDR; WebP needs
// the extended header for either, so its size is the VP8X canvas fields. Both
// feed the same plan as JPEG, and a wrong offset there produces a correctly
// rotated picture at the wrong shape.
test("PNG and WebP report their direction and stored size", async () => {
  for (const [label, source, width, height] of [
    ["png", createTaggedPng(8, 900, 600), 900, 600],
    ["webp", createTaggedWebp(8, 900, 600), 900, 600],
  ]) {
    const profiles = [];
    const downscaler = createImageDownscaler({
      window: {
        Blob,
        createImageBitmap: async (input, options = {}) => ({
          input,
          options,
          width: options.resizeWidth,
          height: options.resizeHeight,
          close() {},
        }),
      },
      document: { createElement: () => createPaintedCanvas() },
      readFile: async () => source,
    });

    await downscaler.renderFromURL(
      `file:///photo.${label}`,
      { width: 341, height: 512 },
      { onProfile: (details) => profiles.push(details) },
    );

    assert.deepEqual(
      { orientation: profiles[0]?.orientation, width: profiles[0]?.width, height: profiles[0]?.height },
      { orientation: 8, width, height },
      `profile for ${label}`,
    );
  }
});

function createTaggedPng(orientation, storedWidth, storedHeight) {
  const exif = createExifPayload(orientation);
  const bytes = new Uint8Array(8 + 25 + 12 + exif.length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR: length, type, width, height, then the remaining five header bytes.
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  bytes.set(bigEndian32(storedWidth), 16);
  bytes.set(bigEndian32(storedHeight), 20);
  bytes.set(bigEndian32(exif.length), 33);
  bytes.set([0x65, 0x58, 0x49, 0x66], 37);
  bytes.set(exif, 41);
  return bytes;
}

function createTaggedWebp(orientation, storedWidth, storedHeight) {
  const exif = createExifPayload(orientation);
  const bytes = new Uint8Array(12 + 8 + 10 + 8 + exif.length);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  // VP8X: flags, then the canvas size as 24-bit values one less than the real one.
  bytes.set([0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00], 12);
  bytes.set(littleEndian24(storedWidth - 1), 24);
  bytes.set(littleEndian24(storedHeight - 1), 27);
  bytes.set([0x45, 0x58, 0x49, 0x46], 30);
  bytes.set([exif.length & 0xff, (exif.length >> 8) & 0xff, 0x00, 0x00], 34);
  bytes.set(exif, 38);
  return bytes;
}

// A big-endian TIFF header with one orientation entry.
function createExifPayload(orientation) {
  const bytes = new Uint8Array(26);
  bytes.set([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08], 0);
  bytes.set([0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01], 8);
  bytes.set([0x00, orientation, 0x00, 0x00], 18);
  return bytes;
}

function bigEndian32(value) {
  return [(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function littleEndian24(value) {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
}

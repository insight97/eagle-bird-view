"use strict";

(function exposeImageDownscaler(root, factory) {
  const downscaler = factory(root);
  if (typeof module === "object" && module.exports) module.exports = downscaler;
  root.BirdViewImageDownscaler = downscaler;
})(typeof globalThis === "object" ? globalThis : this, (root) => {
  // Produces bounded ImageBitmaps for cards to paint.
  //
  // These used to be encoded to WebP and handed over as object URLs so an <img>
  // could show them, but a CPU profile put convertToBlob at 1911ms of main
  // thread time: the encode does not run in parallel the way the spec's wording
  // suggests, at least for an OffscreenCanvas created on the main thread. The
  // bitmap goes straight into a canvas instead, which costs no encode, no second
  // decode, and no re-quantisation.
  function createImageDownscaler(options = {}) {
    const windowRef = options.window || root.window || root;
    const documentRef = options.document || windowRef?.document || root.document;
    const readFile = options.readFile || null;
    // Whether the platform takes `imageOrientation`, and whether it takes it
    // alongside a resize. Only sources whose bytes cannot be inspected rely on
    // it. Both stay null until a decode settles the question, because a failure
    // can belong to one corrupt source rather than to the platform.
    let orientationSupported = null;
    let orientationResizeSupported = null;

    function isSupported() {
      return typeof windowRef?.createImageBitmap === "function";
    }

    function canRenderFromURL() {
      return (
        isSupported() &&
        (typeof windowRef?.fetch === "function" || typeof readFile === "function")
      );
    }

    // Preferred path. Handing the encoded bytes to createImageBitmap lets the
    // browser decode straight to the requested size — for JPEG it scales during
    // the DCT pass — so the full-resolution bitmap never exists. That is the
    // difference between reading a 40 MP master and decoding one.
    async function renderFromURL(url, size, { onFailure, onProfile } = {}) {
      if (!url || !hasUsableSize(size)) {
        reportDetails(onFailure, { stage: "input", reason: "invalid-request" });
        return null;
      }
      if (!isSupported()) {
        reportDetails(onFailure, { stage: "capability", reason: "bitmap-api-unavailable" });
        return null;
      }
      let blob = null;
      let bytes = null;
      let fetchFailure = null;
      if (typeof windowRef?.fetch === "function") {
        let response;
        try {
          response = await windowRef.fetch(url);
          if (response && response.ok === false) {
            fetchFailure = { stage: "fetch", reason: "response-failed" };
          } else {
            blob = await response.blob();
          }
        } catch {
          fetchFailure = { stage: "fetch", reason: "request-failed" };
        }
      } else {
        fetchFailure = { stage: "capability", reason: "fetch-unavailable" };
      }
      if (!blob) {
        const local = await readLocalBlob(url);
        blob = local.blob;
        bytes = local.bytes || null;
        if (!blob) {
          reportDetails(onFailure, local.failure || fetchFailure || {
            stage: "fetch",
            reason: "request-failed",
          });
          return null;
        }
      }
      try {
        return await decodeBounded(blob, size, { onProfile, bytes });
      } catch {
        reportDetails(onFailure, { stage: "decode", reason: "bitmap-failed" });
        return null;
      }
    }

    async function readLocalBlob(url) {
      if (typeof readFile !== "function") return { blob: null };
      let bytes;
      try {
        bytes = await readFile(url);
      } catch {
        return { failure: { stage: "file-read", reason: "request-failed" }, blob: null };
      }
      if (bytes === null || bytes === undefined) {
        return { failure: { stage: "file-read", reason: "request-failed" }, blob: null };
      }
      const BlobConstructor = windowRef?.Blob || root.Blob;
      if (typeof BlobConstructor !== "function") {
        return { failure: { stage: "capability", reason: "blob-unavailable" }, blob: null };
      }
      try {
        // The bytes are already in hand, so they go to the profile reader
        // directly rather than back out through a Blob the platform may not be
        // able to read.
        return bytes instanceof BlobConstructor
          ? { blob: bytes, bytes: null }
          : { blob: new BlobConstructor([bytes]), bytes };
      } catch {
        return { failure: { stage: "file-read", reason: "blob-failed" }, blob: null };
      }
    }

    // Fallback for environments where fetch cannot read the media (a blocked
    // file:// request). The master has already been decoded by the <img> that
    // loaded it, so this only avoids the repeat decodes, not the first one.
    async function renderFromImage(image, size, { onFailure } = {}) {
      if (!image || !hasUsableSize(size)) {
        reportDetails(onFailure, { stage: "input", reason: "invalid-request" });
        return null;
      }
      if (!isSupported()) {
        reportDetails(onFailure, { stage: "capability", reason: "bitmap-api-unavailable" });
        return null;
      }
      try {
        return await decodeBounded(image, size);
      } catch {
        reportDetails(onFailure, { stage: "decode", reason: "bitmap-failed" });
        return null;
      }
    }

    // `.media-frame img` sets image-orientation: from-image, so an <img> honours
    // EXIF rotation. A canvas paints whatever the bitmap holds, so the rotation
    // has to be baked in here or portrait photos come out on their side.
    //
    // The direction is read from the encoded bytes, and baked in below. Native
    // imageOrientation is only for sources whose bytes cannot be read at all,
    // such as an already-loaded element.
    async function decodeBounded(source, { width, height }, { onProfile, bytes = null } = {}) {
      const options = {
        resizeWidth: Math.round(width),
        resizeHeight: Math.round(height),
        // Eagle traces associate high-quality ImageBitmap resize completion
        // with long renderer tasks across PNG and JPEG. Medium keeps every
        // format bounded while reducing that native handoff cost.
        resizeQuality: "medium",
      };
      const profile = await readSourceProfile(bytes || source);
      // What the bytes said drives every branch below, so a card that comes out
      // sideways is diagnosed from this alone: no EXIF found, or found and then
      // overridden by the platform.
      reportDetails(onProfile, profile);
      if (profile.orientation !== 1) {
        return decodeOriented(source, options, profile, bytes);
      }
      // Bytes that name the direction have already answered the question, so an
      // upright picture goes straight to the plain bounded decode. Only a source
      // whose bytes could not be read still needs the platform's own EXIF
      // handling, and that is the one this build cannot be trusted with.
      if (profile.inspected) return decodeRawBitmap(source, options);
      if (orientationResizeSupported !== false) {
        try {
          const bitmap = await windowRef.createImageBitmap(source, {
            ...options,
            imageOrientation: "from-image",
          });
          orientationSupported = true;
          orientationResizeSupported = true;
          return bitmap;
        } catch (error) {
          if (orientationSupported) throw error;
          orientationResizeSupported = false;
        }
      }
      if (orientationSupported !== false) {
        let orientedBitmap = null;
        try {
          orientedBitmap = await windowRef.createImageBitmap(source, {
            imageOrientation: "from-image",
          });
          orientationSupported = true;
          return await windowRef.createImageBitmap(orientedBitmap, options);
        } catch (error) {
          if (isOrientationOptionRejection(error)) orientationSupported = false;
          else if (orientationSupported) throw error;
        } finally {
          try {
            orientedBitmap?.close?.();
          } catch {
            // The temporary bitmap may already have been consumed by the resize.
          }
        }
      }
      return decodeRawBitmap(source, options);
    }

    // Bakes the EXIF direction into the raster. Both the decode size and the
    // canvas come from the pixel dimensions in the encoded bytes rather than the
    // requested size, which is derived from Eagle's metadata and need not agree
    // with the stored orientation. Taking it literally would squash a rotated
    // photo into the sideways aspect.
    async function decodeOriented(source, options, profile, bytes) {
      const { orientation } = profile;
      const plan = planOrientedDecode(options, profile);
      // No decoder rotates a picture that carries no direction, which is the
      // point of neutralising the tag first. Platforms disagree on whether
      // `imageOrientation` suppresses EXIF at all — Eagle's Chromium predates
      // the `from-image` enum value and applies EXIF whatever it is told — and
      // for the four orientations that do not swap the edges, nothing in the
      // reply reveals whether the platform already acted.
      const untagged = withoutOrientationTag(source, bytes, profile) || source;
      // Sized in stored order, with both edges always given: a missing edge asks
      // the platform to preserve "the aspect ratio", and for a rotated photo
      // that may mean either the stored one or the upright one.
      const rawBitmap = await decodeRawBitmap(untagged, {
        resizeQuality: options.resizeQuality,
        resizeWidth: plan.rawWidth,
        resizeHeight: plan.rawHeight,
      });
      const canvas = createOrientationCanvas(plan.outputWidth, plan.outputHeight);
      if (!canvas) {
        release(rawBitmap);
        return null;
      }
      try {
        const context = canvas.getContext?.("2d");
        if (
          !context?.drawImage ||
          typeof context.save !== "function" ||
          typeof context.restore !== "function"
        ) {
          return null;
        }
        drawWithOrientation(
          context,
          orientation,
          rawBitmap,
          plan.rawWidth,
          plan.rawHeight,
          plan.outputWidth,
          plan.outputHeight,
        );
        return await windowRef.createImageBitmap(canvas);
      } finally {
        release(rawBitmap);
        releaseCanvas(canvas);
      }
    }

    // Rewrites the EXIF direction to "upright" without touching the pixels, by
    // replacing the two bytes holding the tag's value. Returns null when the
    // tag's position is unknown, which leaves the source as it was.
    function withoutOrientationTag(source, bytes, profile) {
      const offset = profile.orientationOffset;
      if (!(offset >= 0)) return null;
      const BlobConstructor = windowRef?.Blob || root.Blob;
      if (typeof BlobConstructor !== "function") return null;
      const upright = profile.orientationLittleEndian
        ? new Uint8Array([1, 0])
        : new Uint8Array([0, 1]);
      try {
        const view = toByteView(bytes);
        if (view) {
          return new BlobConstructor([
            view.subarray(0, offset),
            upright,
            view.subarray(offset + 2),
          ]);
        }
        if (typeof source?.slice !== "function") return null;
        return new BlobConstructor([
          source.slice(0, offset),
          upright,
          source.slice(offset + 2),
        ]);
      } catch {
        return null;
      }
    }

    function toByteView(bytes) {
      if (!bytes) return null;
      if (ArrayBuffer.isView(bytes)) {
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      }
      return bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null;
    }

    // `output` is the upright picture bounded by the requested longest edge;
    // `raw` is the same rectangle in stored-pixel order, which is what the
    // decoder is asked for and what the orientation transform draws.
    function planOrientedDecode(options, profile) {
      const swapsDimensions = profile.orientation >= 5 && profile.orientation <= 8;
      const requestedWidth = Math.max(1, Math.round(Number(options.resizeWidth) || 1));
      const requestedHeight = Math.max(1, Math.round(Number(options.resizeHeight) || 1));
      const sourceWidth = Number(profile.width);
      const sourceHeight = Number(profile.height);
      let outputWidth = requestedWidth;
      let outputHeight = requestedHeight;
      if (sourceWidth > 0 && sourceHeight > 0) {
        const uprightWidth = swapsDimensions ? sourceHeight : sourceWidth;
        const uprightHeight = swapsDimensions ? sourceWidth : sourceHeight;
        const budget = Math.max(requestedWidth, requestedHeight);
        const scale = Math.min(1, budget / Math.max(uprightWidth, uprightHeight));
        outputWidth = Math.max(1, Math.round(uprightWidth * scale));
        outputHeight = Math.max(1, Math.round(uprightHeight * scale));
      }
      return {
        outputWidth,
        outputHeight,
        rawWidth: swapsDimensions ? outputHeight : outputWidth,
        rawHeight: swapsDimensions ? outputWidth : outputHeight,
      };
    }

    // `none` is redundant for a source whose tag was neutralised, and is kept
    // for the ones where that could not be done. Older platforms read it as the
    // unrelated "do not flip vertically", and some reject it outright.
    async function decodeRawBitmap(source, options) {
      try {
        return await windowRef.createImageBitmap(source, {
          ...options,
          imageOrientation: "none",
        });
      } catch (error) {
        if (!isOrientationOptionRejection(error)) throw error;
        return await windowRef.createImageBitmap(source, options);
      }
    }

    function createOrientationCanvas(width, height) {
      const OffscreenCanvasConstructor = windowRef?.OffscreenCanvas || root.OffscreenCanvas;
      if (typeof OffscreenCanvasConstructor === "function") {
        try {
          return new OffscreenCanvasConstructor(Math.round(width), Math.round(height));
        } catch {
          // Fall through to the document canvas when OffscreenCanvas is unavailable.
        }
      }
      try {
        const canvas = documentRef?.createElement?.("canvas");
        if (!canvas) return null;
        canvas.width = Math.round(width);
        canvas.height = Math.round(height);
        return canvas;
      } catch {
        return null;
      }
    }

    function drawWithOrientation(
      context,
      orientation,
      bitmap,
      width,
      height,
      outputWidth,
      outputHeight,
    ) {
      context.save();
      switch (orientation) {
        case 2:
          context.translate(outputWidth, 0);
          context.scale(-1, 1);
          break;
        case 3:
          context.translate(outputWidth, outputHeight);
          context.rotate(Math.PI);
          break;
        case 4:
          context.translate(0, outputHeight);
          context.scale(1, -1);
          break;
        case 5:
          context.rotate(Math.PI / 2);
          context.scale(1, -1);
          break;
        case 6:
          context.translate(outputWidth, 0);
          context.rotate(Math.PI / 2);
          break;
        case 7:
          context.translate(outputWidth, outputHeight);
          context.rotate(Math.PI / 2);
          context.scale(-1, 1);
          break;
        case 8:
          context.translate(0, outputHeight);
          context.rotate(-Math.PI / 2);
          break;
        default:
          break;
      }
      context.drawImage(bitmap, 0, 0, width, height);
      context.restore();
    }

    function releaseCanvas(canvas) {
      try {
        canvas.width = 0;
        canvas.height = 0;
      } catch {
        // The temporary canvas may be an immutable OffscreenCanvas adapter.
      }
    }

    function isOrientationOptionRejection(error) {
      return error?.name === "TypeError" || error?.name === "NotSupportedError";
    }

    // What the encoded bytes say about the picture: the EXIF direction, and the
    // stored pixel dimensions the decoder will hand back. A source whose bytes
    // cannot be read (an already-loaded element) reports an upright picture of
    // unknown size, which sends it down the native-orientation path.
    const UNKNOWN_PROFILE = Object.freeze({
      inspected: false,
      orientation: 1,
      width: null,
      height: null,
      orientationOffset: null,
      orientationLittleEndian: false,
    });

    async function readSourceProfile(source) {
      let bytes;
      try {
        if (typeof source?.slice === "function" && typeof source?.size === "number") {
          bytes = await readBlobBytes(source.slice(0, 256 * 1024));
        } else if (source instanceof ArrayBuffer) {
          bytes = new Uint8Array(source);
        } else if (ArrayBuffer.isView(source)) {
          bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
        }
      } catch {
        return UNKNOWN_PROFILE;
      }
      return parseSourceProfile(bytes);
    }

    // Blob.arrayBuffer() postdates the Chromium this runs on, and losing the
    // read means losing the EXIF direction with it: the decode would fall back
    // to an untagged picture and paint it sideways.
    async function readBlobBytes(blob) {
      if (typeof blob.arrayBuffer === "function") {
        return new Uint8Array(await blob.arrayBuffer());
      }
      const FileReaderConstructor = windowRef?.FileReader || root.FileReader;
      if (typeof FileReaderConstructor !== "function") return null;
      return new Promise((resolve) => {
        const reader = new FileReaderConstructor();
        reader.onload = () => resolve(new Uint8Array(reader.result));
        reader.onerror = () => resolve(null);
        reader.readAsArrayBuffer(blob);
      });
    }

    function parseSourceProfile(bytes) {
      if (!bytes || bytes.length < 8) return UNKNOWN_PROFILE;
      if (bytes[0] === 0xff && bytes[1] === 0xd8) {
        return parseJpegProfile(bytes);
      }
      if (
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47
      ) {
        return parsePngProfile(bytes);
      }
      if (
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      ) {
        return parseWebpProfile(bytes);
      }
      return UNKNOWN_PROFILE;
    }

    function parseJpegProfile(bytes) {
      const profile = { ...UNKNOWN_PROFILE, inspected: true };
      let offset = 2;
      while (offset + 4 <= bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        while (bytes[offset] === 0xff) offset += 1;
        const marker = bytes[offset++];
        if (marker === 0xda || marker === 0xd9) break;
        if (offset + 2 > bytes.length) break;
        const length = readBigEndian16(bytes, offset);
        if (length < 2 || offset + length > bytes.length) break;
        if (marker === 0xe1 && hasExifHeader(bytes, offset + 2)) {
          applyTiffOrientation(profile, bytes, offset + 8, offset + length);
        } else if (isJpegFrameMarker(marker) && length >= 7) {
          // Start of frame: precision, then the stored height and width.
          profile.height = readBigEndian16(bytes, offset + 3);
          profile.width = readBigEndian16(bytes, offset + 5);
          break;
        }
        offset += length;
      }
      return profile;
    }

    // Every start-of-frame marker except the huffman, arithmetic-coding, and
    // restart-interval definitions that share the same range.
    function isJpegFrameMarker(marker) {
      return (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      );
    }

    function parsePngProfile(bytes) {
      const profile = { ...UNKNOWN_PROFILE, inspected: true };
      let offset = 8;
      while (offset + 12 <= bytes.length) {
        const length = readBigEndian32(bytes, offset);
        const type = String.fromCharCode(
          bytes[offset + 4],
          bytes[offset + 5],
          bytes[offset + 6],
          bytes[offset + 7],
        );
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > bytes.length) break;
        if (type === "IHDR" && length >= 8) {
          profile.width = readBigEndian32(bytes, dataStart);
          profile.height = readBigEndian32(bytes, dataStart + 4);
        }
        if (type === "eXIf") {
          applyTiffOrientation(profile, bytes, dataStart, dataEnd);
          break;
        }
        offset = dataEnd + 4;
      }
      return profile;
    }

    function parseWebpProfile(bytes) {
      const profile = { ...UNKNOWN_PROFILE, inspected: true };
      let offset = 12;
      while (offset + 8 <= bytes.length) {
        const type = String.fromCharCode(
          bytes[offset],
          bytes[offset + 1],
          bytes[offset + 2],
          bytes[offset + 3],
        );
        const length = readLittleEndian32(bytes, offset + 4);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd > bytes.length) break;
        // EXIF metadata only exists in the extended format, whose VP8X header
        // carries the canvas size as two 24-bit values one less than the real
        // dimensions.
        if (type === "VP8X" && length >= 10) {
          profile.width = readLittleEndian24(bytes, dataStart + 4) + 1;
          profile.height = readLittleEndian24(bytes, dataStart + 7) + 1;
        }
        if (type === "EXIF") {
          applyTiffOrientation(profile, bytes, dataStart, dataEnd);
          break;
        }
        offset = dataEnd + (length % 2);
      }
      return profile;
    }

    function hasExifHeader(bytes, offset) {
      return (
        bytes[offset] === 0x45 &&
        bytes[offset + 1] === 0x78 &&
        bytes[offset + 2] === 0x69 &&
        bytes[offset + 3] === 0x66 &&
        bytes[offset + 4] === 0x00 &&
        bytes[offset + 5] === 0x00
      );
    }

    // Records the direction and where its two value bytes sit, so the tag can be
    // neutralised before the picture reaches a decoder.
    function applyTiffOrientation(profile, bytes, start, end) {
      if (start + 8 > end) return;
      const littleEndian = bytes[start] === 0x49 && bytes[start + 1] === 0x49;
      const bigEndian = bytes[start] === 0x4d && bytes[start + 1] === 0x4d;
      if (!littleEndian && !bigEndian) return;
      const read16 = (offset) =>
        littleEndian
          ? bytes[offset] | (bytes[offset + 1] << 8)
          : (bytes[offset] << 8) | bytes[offset + 1];
      const read32 = (offset) =>
        littleEndian
          ? bytes[offset] |
            (bytes[offset + 1] << 8) |
            (bytes[offset + 2] << 16) |
            (bytes[offset + 3] << 24)
          : ((bytes[offset] << 24) |
              (bytes[offset + 1] << 16) |
              (bytes[offset + 2] << 8) |
              bytes[offset + 3]) >>> 0;
      if (read16(start + 2) !== 42) return;
      const ifd = start + read32(start + 4);
      if (ifd < start || ifd + 2 > end) return;
      const count = read16(ifd);
      for (let index = 0; index < count; index += 1) {
        const entry = ifd + 2 + index * 12;
        if (entry + 12 > end) break;
        if (read16(entry) !== 0x0112 || read16(entry + 2) !== 3) continue;
        const value = read16(entry + 8);
        if (!(value >= 1 && value <= 8)) return;
        profile.orientation = value;
        profile.orientationOffset = entry + 8;
        profile.orientationLittleEndian = littleEndian;
        return;
      }
    }

    function readBigEndian16(bytes, offset) {
      return (bytes[offset] << 8) | bytes[offset + 1];
    }

    function readBigEndian32(bytes, offset) {
      return (
        (bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3]
      ) >>> 0;
    }

    function readLittleEndian24(bytes, offset) {
      return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
    }

    function readLittleEndian32(bytes, offset) {
      return (
        bytes[offset] |
        (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) |
        (bytes[offset + 3] << 24)
      ) >>> 0;
    }

    function hasUsableSize(size) {
      return Number(size?.width) > 0 && Number(size?.height) > 0;
    }

    function reportDetails(callback, details) {
      try {
        callback?.(details);
      } catch {
        // Diagnostics must never replace the thumbnail fallback with an error.
      }
    }

    function release(bitmap) {
      try {
        bitmap?.close?.();
      } catch {
        // Already transferred into a canvas, or already closed.
      }
    }

    return Object.freeze({
      canRenderFromURL,
      isSupported,
      release,
      renderFromImage,
      renderFromURL,
    });
  }

  return Object.freeze({ createImageDownscaler });
});

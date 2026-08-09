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
    const { window: windowRef = root.window || root } = options;
    // null until the first decode tells us whether this build accepts
    // imageOrientation alongside a resize.
    let orientationSupported = null;

    function isSupported() {
      return typeof windowRef?.createImageBitmap === "function";
    }

    function canRenderFromURL() {
      return isSupported() && typeof windowRef?.fetch === "function";
    }

    // Preferred path. Handing the encoded bytes to createImageBitmap lets the
    // browser decode straight to the requested size — for JPEG it scales during
    // the DCT pass — so the full-resolution bitmap never exists. That is the
    // difference between reading a 40 MP master and decoding one.
    async function renderFromURL(url, size, { onFailure } = {}) {
      if (!url || !hasUsableSize(size)) {
        reportFailure(onFailure, { stage: "input", reason: "invalid-request" });
        return null;
      }
      if (!isSupported()) {
        reportFailure(onFailure, { stage: "capability", reason: "bitmap-api-unavailable" });
        return null;
      }
      if (typeof windowRef?.fetch !== "function") {
        reportFailure(onFailure, { stage: "capability", reason: "fetch-unavailable" });
        return null;
      }
      let response;
      try {
        response = await windowRef.fetch(url);
      } catch {
        reportFailure(onFailure, { stage: "fetch", reason: "request-failed" });
        return null;
      }
      if (response && response.ok === false) {
        reportFailure(onFailure, { stage: "fetch", reason: "response-failed" });
        return null;
      }
      let blob;
      try {
        blob = await response.blob();
      } catch {
        reportFailure(onFailure, { stage: "fetch", reason: "blob-failed" });
        return null;
      }
      try {
        return await decodeBounded(blob, size, url);
      } catch {
        reportFailure(onFailure, { stage: "decode", reason: "bitmap-failed" });
        return null;
      }
    }

    // Fallback for environments where fetch cannot read the media (a blocked
    // file:// request). The master has already been decoded by the <img> that
    // loaded it, so this only avoids the repeat decodes, not the first one.
    async function renderFromImage(image, size, { onFailure } = {}) {
      if (!image || !hasUsableSize(size)) {
        reportFailure(onFailure, { stage: "input", reason: "invalid-request" });
        return null;
      }
      if (!isSupported()) {
        reportFailure(onFailure, { stage: "capability", reason: "bitmap-api-unavailable" });
        return null;
      }
      try {
        return await decodeBounded(image, size);
      } catch {
        reportFailure(onFailure, { stage: "decode", reason: "bitmap-failed" });
        return null;
      }
    }

    // `.media-frame img` sets image-orientation: from-image, so an <img> honours
    // EXIF rotation. A canvas paints whatever the bitmap holds, so the rotation
    // has to be baked in here or portrait photos come out on their side.
    //
    // Not every build accepts that option alongside a resize, and a rejection
    // here used to take the whole raster down with it, which is far worse than
    // an unrotated photo: the card fell back to painting the full-resolution
    // master. So it is requested, and dropped if the platform refuses it.
    async function decodeBounded(source, { width, height }, sourceURL = "") {
      const options = {
        resizeWidth: Math.round(width),
        resizeHeight: Math.round(height),
        // Eagle traces associate PNG ImageBitmap completion with long renderer
        // tasks. Medium isolates the suspected high-quality resize path for the
        // A/B without reducing JPEG or WebP quality; every decode stays bounded.
        resizeQuality: getResizeQuality(source, sourceURL),
      };
      if (orientationSupported !== false) {
        try {
          const bitmap = await windowRef.createImageBitmap(source, {
            ...options,
            imageOrientation: "from-image",
          });
          orientationSupported = true;
          return bitmap;
        } catch (error) {
          if (orientationSupported) throw error;
          orientationSupported = false;
        }
      }
      return windowRef.createImageBitmap(source, options);
    }

    function getResizeQuality(source, sourceURL) {
      const mimeType = String(source?.type || "").toLowerCase();
      if (mimeType) return mimeType === "image/png" ? "medium" : "high";
      const fallbackURL = String(sourceURL || source?.currentSrc || source?.src || "");
      return /\.png(?:$|[?#])/i.test(fallbackURL) ? "medium" : "high";
    }

    function hasUsableSize(size) {
      return Number(size?.width) > 0 && Number(size?.height) > 0;
    }

    function reportFailure(callback, details) {
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

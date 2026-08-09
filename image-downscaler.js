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
    async function renderFromURL(url, size) {
      if (!canRenderFromURL() || !url || !hasUsableSize(size)) return null;
      try {
        const response = await windowRef.fetch(url);
        if (response && response.ok === false) return null;
        return await decodeBounded(await response.blob(), size);
      } catch {
        return null;
      }
    }

    // Fallback for environments where fetch cannot read the media (a blocked
    // file:// request). The master has already been decoded by the <img> that
    // loaded it, so this only avoids the repeat decodes, not the first one.
    async function renderFromImage(image, size) {
      if (!isSupported() || !image || !hasUsableSize(size)) return null;
      try {
        return await decodeBounded(image, size);
      } catch {
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
    async function decodeBounded(source, { width, height }) {
      const options = {
        resizeWidth: Math.round(width),
        resizeHeight: Math.round(height),
        resizeQuality: "high",
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

    function hasUsableSize(size) {
      return Number(size?.width) > 0 && Number(size?.height) > 0;
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

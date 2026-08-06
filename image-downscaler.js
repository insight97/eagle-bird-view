"use strict";

(function exposeImageDownscaler(root, factory) {
  const downscaler = factory(root);
  if (typeof module === "object" && module.exports) module.exports = downscaler;
  root.BirdViewImageDownscaler = downscaler;
})(typeof globalThis === "object" ? globalThis : this, (root) => {
  // Re-encoding as lossy WebP keeps the bounded raster small enough that the
  // compositor's decode cache holds every visible card at once. The raster is
  // already capped well above its on-screen size, so the encoder's loss stays
  // below what the card can show.
  const RASTER_MIME_TYPE = "image/webp";
  const RASTER_QUALITY = 0.92;

  function createImageDownscaler(options = {}) {
    const {
      window: windowRef = root.window || root,
      document: documentRef = root.document,
    } = options;

    function isSupported() {
      return (
        typeof windowRef?.createImageBitmap === "function" &&
        typeof windowRef?.URL?.createObjectURL === "function" &&
        typeof documentRef?.createElement === "function"
      );
    }

    function canRenderFromURL() {
      return isSupported() && typeof windowRef?.fetch === "function";
    }

    // Preferred path. Handing the encoded bytes to createImageBitmap lets the
    // browser decode straight to the requested size — for JPEG it scales during
    // the DCT pass — so the full-resolution bitmap never exists. That is the
    // difference between reading a 40 MP master and decoding one.
    async function renderFromURL(url, size) {
      if (!canRenderFromURL() || !url) return null;
      if (!hasUsableSize(size)) return null;
      try {
        const response = await windowRef.fetch(url);
        if (response && response.ok === false) return null;
        const blob = await response.blob();
        return await renderBitmap(blob, size);
      } catch {
        return null;
      }
    }

    // Fallback for environments where fetch cannot read the media (a blocked
    // file:// request). The master has already been decoded by the <img> that
    // loaded it, so this only avoids the repeat decodes, not the first one.
    async function renderFromImage(image, size) {
      if (!isSupported() || !image) return null;
      if (!hasUsableSize(size)) return null;
      try {
        return await renderBitmap(image, size);
      } catch {
        return null;
      }
    }

    async function renderBitmap(source, { width, height }) {
      const targetWidth = Math.round(width);
      const targetHeight = Math.round(height);
      let bitmap = null;
      try {
        bitmap = await windowRef.createImageBitmap(source, {
          resizeWidth: targetWidth,
          resizeHeight: targetHeight,
          resizeQuality: "high",
        });
        const blob = await encode(bitmap, targetWidth, targetHeight);
        if (!blob) return null;
        return windowRef.URL.createObjectURL(blob);
      } finally {
        bitmap?.close?.();
      }
    }

    // OffscreenCanvas keeps the encode off the main thread, which matters when
    // several cards finish loading while the camera is moving.
    function encode(bitmap, width, height) {
      const offscreen = createOffscreenCanvas(width, height);
      if (offscreen) {
        const context = offscreen.getContext?.("2d");
        if (context) {
          context.drawImage(bitmap, 0, 0, width, height);
          return offscreen.convertToBlob({
            type: RASTER_MIME_TYPE,
            quality: RASTER_QUALITY,
          });
        }
      }

      const canvas = documentRef.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext?.("2d");
      if (!context || typeof canvas.toBlob !== "function") return Promise.resolve(null);
      context.drawImage(bitmap, 0, 0, width, height);
      return new Promise((resolve) => {
        canvas.toBlob(
          (blob) => resolve(blob || null),
          RASTER_MIME_TYPE,
          RASTER_QUALITY,
        );
      });
    }

    function createOffscreenCanvas(width, height) {
      if (typeof windowRef?.OffscreenCanvas !== "function") return null;
      try {
        const offscreen = new windowRef.OffscreenCanvas(width, height);
        return typeof offscreen.convertToBlob === "function" ? offscreen : null;
      } catch {
        return null;
      }
    }

    function hasUsableSize(size) {
      return Number(size?.width) > 0 && Number(size?.height) > 0;
    }

    function revoke(url) {
      if (!url) return;
      try {
        windowRef.URL?.revokeObjectURL?.(url);
      } catch {
        // The URL is already gone; nothing left to release.
      }
    }

    return Object.freeze({
      canRenderFromURL,
      isSupported,
      renderFromImage,
      renderFromURL,
      revoke,
    });
  }

  return Object.freeze({ createImageDownscaler });
});

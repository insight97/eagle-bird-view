"use strict";

(function exposeBirdViewMaterializer(root, factory) {
  const core =
    root.BirdViewCore ||
    (typeof module === "object" && typeof require === "function"
      ? require("./bird-view-core.js")
      : null);
  const media =
    root.BirdViewMedia ||
    (typeof module === "object" && typeof require === "function"
      ? require("./media-load-queue.js")
      : null);
  const video =
    root.BirdViewVideo ||
    (typeof module === "object" && typeof require === "function"
      ? require("./video-player.js")
      : null);
  const downscaler =
    root.BirdViewImageDownscaler ||
    (typeof module === "object" && typeof require === "function"
      ? require("./image-downscaler.js")
      : null);
  const materializer = factory(core, media, video, downscaler, root);
  if (typeof module === "object" && module.exports) module.exports = materializer;
  root.BirdViewMaterializer = materializer;
})(typeof globalThis === "object" ? globalThis : this, (core, media, video, downscaler, root) => {
  const {
    VIDEO_CONTROLS_HEIGHT,
    VIDEO_EXTENSIONS,
    canPaintMasterDirectly,
    getRasterDimensionBudget,
    getRasterTargetSize,
  } = core;
  const { MediaLoadQueue, waitForImageDecode } = media;
  const { startVideoPlayer } = video;
  const { createImageDownscaler } = downscaler;

  const MAX_CONCURRENT_IMAGE_LOADS = 4;
  const ORIGINAL_IMAGE_LOAD_TIMEOUT = 8000;
  const MEDIA_DEBUG_STORAGE_KEY = "bird-view-debug";

  function createMediaMaterializer(options = {}) {
    const {
      world,
      document: documentRef = root.document,
      window: windowRef = root.window || root,
      mediaLoadQueue = new MediaLoadQueue({ maxConcurrent: MAX_CONCURRENT_IMAGE_LOADS }),
      imageDownscaler = createImageDownscaler({ window: windowRef }),
      // Longest edge, in device pixels, that the card currently paints at.
      getNodeScreenLongEdge = () => 0,
      onPositionNode = () => {},
      onClickNode = () => {},
      onSelectNode = () => {},
      isNodeSelected = () => false,
      isNodeInMultipleSelection = () => false,
      onOpenContextMenu = () => {},
      onLayoutChange = () => {},
      getVideoControlsHeight = () => VIDEO_CONTROLS_HEIGHT,
      getVideoVolume = () => 1,
      onVolumeChange = () => {},
      showToast = () => {},
      debugLog = defaultDebugLog,
      startVideoPlayer: startVideoPlayerImpl = startVideoPlayer,
    } = options;

    if (!world || !documentRef?.createElement || !mediaLoadQueue) {
      throw new Error("Media materializer requires world, document, and media queue");
    }

    const mountedNodes = new Set();
    const materializedNodes = new Set();
    const requestMediaByNode = new WeakMap();
    const retryOriginalByNode = new WeakMap();
    const thumbnailImageByNode = new WeakMap();
    // The bounded raster a card is currently painting — the <canvas> holding it
    // and the budget it was built for, so a later zoom can tell whether it still
    // has enough pixels.
    const rasterByNode = new WeakMap();

    // A canvas keeps its pixels for as long as it is around, so handing one back
    // means zeroing it. Removing the element alone leaves the backing store.
    function releaseRasterCanvas(element) {
      if (!element || element.tagName !== "CANVAS") return;
      element.width = 0;
      element.height = 0;
    }

    // Re-renders the card's raster when its budget no longer matches what the
    // card paints. The existing raster stays on screen throughout.
    //
    // Growing has to be eager: the card is visibly soft until it happens.
    // Shrinking has to wait for the camera to settle, because a zoom gesture
    // asks for quality several times a second and would otherwise re-render on
    // every step. It cannot be skipped, though — a budget that only ever grows
    // leaves a zoomed-out board painting 4096px rasters into 180px cards, which
    // is the same decode cache thrash that bounding was meant to remove.
    function refreshRasterBudget(node, { allowShrink = false } = {}) {
      const raster = rasterByNode.get(node);
      if (!raster) return;
      const needed = getRasterDimensionBudget(getNodeScreenLongEdge(node));
      if (needed === raster.budget) return;
      if (needed < raster.budget && !allowShrink) return;
      if (mediaLoadQueue.snapshot(node)?.readyQuality !== "original") return;
      if (!mediaLoadQueue.invalidate(node, "original")) return;
      requestMediaByNode.get(node)?.("original");
    }

    // Zooming out far enough that the card no longer wants an original at all
    // has to give the raster back too. refreshRasterBudget() cannot do it: it
    // only runs for cards still asking for "original", so without this a card
    // that drops below the threshold keeps painting whatever raster it grew to.
    function dropOriginalRaster(node) {
      const raster = rasterByNode.get(node);
      if (!raster) return;
      const thumbnail = thumbnailImageByNode.get(node);
      const original = node.previewImage;
      if (!thumbnail || !original || thumbnail === original) return;
      const snapshot = mediaLoadQueue.snapshot(node);
      if (snapshot?.readyQuality !== "original" || snapshot.thumbnailFailed) return;
      if (!mediaLoadQueue.invalidate(node, "original")) return;

      thumbnail.style.visibility = "visible";
      original.remove();
      releaseRasterCanvas(original);
      rasterByNode.delete(node);
      node.previewImage = thumbnail;
      node.mediaElement = thumbnail;
      if (node.element) node.element.dataset.mediaQuality = "thumbnail";
      applyMediaRotation(node);
      debugLog(node.item, "bounded-raster-dropped", { budget: raster.budget });
    }

    function mount(node) {
      if (!node) return;
      if (!node.element) {
        node.element = createMediaCard(node);
        const isSelected = isNodeSelected(node);
        node.element.classList.toggle("is-selected", isSelected);
        node.element.classList.toggle(
          "is-multi-selected",
          isSelected && isNodeInMultipleSelection(node),
        );
        onPositionNode(node);
        materializedNodes.add(node);
      }
      if (!node.element.isConnected) world.append(node.element);
      mountedNodes.add(node);
    }

    function unmount(node) {
      node.videoElement?.pause();
      node.element?.remove();
      mountedNodes.delete(node);
    }

    function release(node) {
      node.mediaGeneration = (node.mediaGeneration || 0) + 1;
      mediaLoadQueue.dispose(node);
      node.stopVideoControls?.();

      if (node.videoElement) {
        node.videoElement.pause();
        node.videoElement.removeAttribute("src");
        node.videoElement.load();
      }
      node.preloadImage?.removeAttribute("src");
      node.previewImage?.removeAttribute("src");
      thumbnailImageByNode.get(node)?.removeAttribute("src");
      releaseRasterCanvas(rasterByNode.get(node)?.element);
      rasterByNode.delete(node);
      node.element?.remove();
      mountedNodes.delete(node);
      materializedNodes.delete(node);
      requestMediaByNode.delete(node);
      retryOriginalByNode.delete(node);

      node.element = null;
      node.previewImage = null;
      node.preloadImage = null;
      node.startPlayback = null;
      node.videoElement = null;
      node.togglePlayback = null;
      node.playPlayback = null;
      node.pausePlayback = null;
      node.stopVideoControls = null;
      node.revealVideoControls = null;
      node.mediaElement = null;
      thumbnailImageByNode.delete(node);
      node.height = node.mediaHeight;
    }

    function releaseAll() {
      for (const node of [...materializedNodes]) release(node);
    }

    function reposition() {
      for (const node of materializedNodes) onPositionNode(node);
    }

    function preloadSelected(node) {
      const snapshot = mediaLoadQueue.snapshot(node);
      if (!snapshot) return;
      if (!node.isVideo) {
        if (snapshot.readyQuality === "original" || snapshot.originalFailed) return;
        requestMediaByNode.get(node)?.("original");
        return;
      }
      if (snapshot.readyQuality || snapshot.loading || snapshot.queued || snapshot.pendingQuality) {
        return;
      }
      requestMediaByNode.get(node)?.("thumbnail");
    }

    function retryOriginal(node) {
      if (!node || node.isVideo || !node.item?.fileURL) return;
      const requested = retryOriginalByNode.get(node)?.() || false;
      if (!requested) return;
      node.element?.setAttribute("data-media-quality", "loading-original");
      debugLog(node.item, "original-load-retry-requested", { fileURL: node.item.fileURL });
      showToast("正在重新載入原圖。", false, 1000);
    }

    function sync({
      visibleNodes = [],
      retainedNodes = [],
      loadNodes = visibleNodes,
      selectedNode = null,
      getQuality = () => "thumbnail",
      deferOriginals = false,
    } = {}) {
      const visible = new Set(visibleNodes);
      const retained = new Set(retainedNodes);

      for (const node of materializedNodes) {
        if (getQuality(node) === "original") continue;
        mediaLoadQueue.cancel(node, "original");
        dropOriginalRaster(node);
      }

      for (const node of mountedNodes) {
        if (!visible.has(node) && node !== selectedNode) unmount(node);
      }
      for (const node of [...materializedNodes]) {
        if (!retained.has(node) && node !== selectedNode) release(node);
      }

      for (const node of visible) mount(node);
      for (const node of loadNodes) {
        const quality = getQuality(node);
        requestMediaByNode.get(node)?.(requestedQuality(node, quality, deferOriginals));
        if (quality === "original") refreshRasterBudget(node, { allowShrink: true });
      }
    }

    // Sweeping across a board crosses hundreds of cards that are on screen for a
    // moment each, and every original costs a full decode of the master to build
    // its raster. While the camera is moving, cards that have not earned one yet
    // settle for the thumbnail and pick the original up once it stops.
    //
    // This defers starting a load; it never takes back a raster a card already
    // has. Downgrading loaded cards during motion is a different thing, it made
    // the whole board blur while zooming, and it is not what this does.
    function requestedQuality(node, quality, deferOriginals) {
      if (!deferOriginals || quality !== "original") return quality;
      if (mediaLoadQueue.snapshot(node)?.readyQuality === "original") return quality;
      return "thumbnail";
    }

    function syncQuality({ loadNodes = [], getQuality = () => "thumbnail" } = {}) {
      for (const node of materializedNodes) {
        if (getQuality(node) !== "original") mediaLoadQueue.cancel(node, "original");
      }

      for (const node of loadNodes) {
        if (!materializedNodes.has(node)) continue;
        const quality = getQuality(node);
        requestMediaByNode.get(node)?.(quality);
        if (quality === "original") refreshRasterBudget(node);
      }
    }

    function rotate(node, degrees) {
      node.rotation = (node.rotation + degrees + 360) % 360;
      applyMediaRotation(node);
    }

    function play(node) {
      if (!node?.isVideo) return;
      if (node.videoElement) {
        if (node.videoElement.paused) node.playPlayback?.();
        return;
      }
      node.startPlayback?.();
    }

    function pause(node) {
      if (!node) return;
      if (node.pausePlayback) node.pausePlayback();
      else node.videoElement?.pause();
    }

    function createMediaCard(node) {
      const { item } = node;
      const extension = String(item.ext || "").toLowerCase();
      const isVideo = VIDEO_EXTENSIONS.has(extension);
      const card = documentRef.createElement("article");
      const frame = documentRef.createElement("div");
      const image = documentRef.createElement("img");
      const retryOriginalButton = !isVideo ? documentRef.createElement("button") : null;
      const mediaGeneration = (node.mediaGeneration || 0) + 1;
      let originalLoadTimeoutId = null;

      node.mediaGeneration = mediaGeneration;
      card.className = "media-card";
      card.dataset.itemId = item.id;
      card.dataset.mediaQuality = "idle";
      card.title = isVideo
        ? `${item.name || "未命名"}（雙擊播放或暫停）`
        : item.name || "未命名";
      frame.className = "media-frame";
      frame.style.height = `${node.mediaHeight}px`;
      const originalImageURL = !isVideo ? item.fileURL : null;
      const fallbackURL = item.thumbnailURL || item.fileURL;
      if (!isVideo && !originalImageURL) {
        debugLog(item, "card-created-without-fileURL", { fileURL: item.fileURL });
      }

      image.alt = item.name || "Eagle 素材";
      image.decoding = "async";
      image.draggable = false;
      image.style.visibility = "hidden";
      thumbnailImageByNode.set(node, image);
      if (retryOriginalButton) {
        retryOriginalButton.className = "original-retry-button";
        retryOriginalButton.type = "button";
        retryOriginalButton.textContent = "原圖載入失敗，重試";
        retryOriginalButton.setAttribute("aria-label", `重試載入 ${item.name || "素材"} 的原圖`);
        retryOriginalButton.addEventListener("pointerdown", (event) => event.stopPropagation());
        retryOriginalButton.addEventListener("click", (event) => {
          event.stopPropagation();
          retryOriginal(node);
        });
      }
      node.mediaElement = image;

      const clearOriginalLoadTimeout = () => {
        if (originalLoadTimeoutId === null) return;
        windowRef.clearTimeout(originalLoadTimeoutId);
        originalLoadTimeoutId = null;
      };
      const markOriginalLoadFailed = (reason = "error") => {
        const snapshot = mediaLoadQueue.snapshot(node);
        const isRequested =
          snapshot?.pendingQuality === "original" ||
          snapshot?.queuedQuality === "original" ||
          snapshot?.loadingQuality === "original";
        if (!isRequested) return;
        clearOriginalLoadTimeout();
        if (retryOriginalButton) {
          retryOriginalButton.textContent =
            reason === "timeout" ? "原圖載入逾時，重試" : "原圖載入失敗，重試";
        }
        if (!mediaLoadQueue.fail(node, "original")) return;
        card.dataset.mediaQuality = "original-failed";
        debugLog(item, "original-load-failed", { reason, fileURL: originalImageURL });
      };
      // An original load no longer belongs to one <img>: the preferred path
      // reads the file and paints a canvas without any element at all. A token
      // per attempt is what tells a late result that it has been superseded.
      let originalLoadToken = null;
      const beginOriginalLoad = () => {
        originalLoadToken = {};
        return originalLoadToken;
      };
      const isCurrentOriginalLoad = (token) =>
        node.mediaGeneration === mediaGeneration &&
        originalLoadToken === token &&
        mediaLoadQueue.snapshot(node)?.loadingQuality === "original";
      const failOriginalLoad = (reason = "error", token) => {
        if (!isCurrentOriginalLoad(token)) return;
        markOriginalLoadFailed(reason);
      };
      const watchOriginalLoad = () => {
        const snapshot = mediaLoadQueue.snapshot(node);
        const isRequested =
          snapshot?.pendingQuality === "original" ||
          snapshot?.queuedQuality === "original" ||
          snapshot?.loadingQuality === "original";
        if (!isRequested || originalLoadTimeoutId !== null) return;
        originalLoadTimeoutId = windowRef.setTimeout(() => {
          const latest = mediaLoadQueue.snapshot(node);
          const stillRequested =
            latest?.pendingQuality === "original" ||
            latest?.queuedQuality === "original" ||
            latest?.loadingQuality === "original";
          if (!stillRequested) {
            clearOriginalLoadTimeout();
            return;
          }
          debugLog(item, "original-load-watchdog-fired", {
            pendingQuality: latest.pendingQuality,
            queuedQuality: latest.queuedQuality,
            loadingQuality: latest.loadingQuality,
            fileURL: originalImageURL,
          });
          markOriginalLoadFailed("timeout");
        }, ORIGINAL_IMAGE_LOAD_TIMEOUT);
      };
      const requestMedia = (quality = "thumbnail") => {
        const requested = mediaLoadQueue.request(node, quality);
        if (quality === "original" && originalImageURL) watchOriginalLoad();
        return requested;
      };
      const retry = () => {
        const requested = mediaLoadQueue.retry(node, "original");
        watchOriginalLoad();
        return requested;
      };
      requestMediaByNode.set(node, requestMedia);
      retryOriginalByNode.set(node, retry);
      mediaLoadQueue.register(node, {
        hasOriginal: Boolean(originalImageURL),
        hasThumbnail: Boolean(fallbackURL),
        preferThumbnailFirst: Boolean(
          originalImageURL && fallbackURL && originalImageURL !== fallbackURL,
        ),
        cancel: (quality) => {
          if (quality !== "original") return;
          clearOriginalLoadTimeout();
          originalLoadToken = null;
          const originalImage = node.preloadImage;
          if (originalImage) {
            node.preloadImage = null;
            originalImage.removeAttribute("src");
            originalImage.remove();
          }
          card.dataset.mediaQuality = mediaLoadQueue.snapshot(node)?.readyQuality || "idle";
          debugLog(item, "original-load-canceled");
        },
        start: (quality) => {
          const mediaURL = quality === "original" ? originalImageURL : fallbackURL;
          if (!mediaURL) {
            mediaLoadQueue.complete(node, quality, false);
            return;
          }
          card.dataset.mediaQuality =
            quality === "original" ? "loading-original" : "loading-thumbnail";
          if (quality === "original") {
            void startOriginalLoad(mediaURL);
            return;
          }
          image.src = mediaURL;
        },
      });

      // Puts `element` on screen and retires whatever it replaces. The thumbnail
      // is kept — the card falls back to it if the original is handed back — but
      // a superseded raster or master is torn down.
      function showMedia(element) {
        const displaced = node.previewImage;
        if (displaced && displaced !== element) {
          displaced.style.visibility = "hidden";
          if (displaced !== image) {
            displaced.removeAttribute?.("src");
            displaced.remove();
            releaseRasterCanvas(displaced);
          }
        }
        element.style.visibility = "visible";
        element.removeAttribute("aria-hidden");
        node.previewImage = element;
        node.mediaElement = element;
      }

      // The bitmap goes into the canvas rather than through an encode and a
      // second decode. `bitmaprenderer` transfers it without copying, which is
      // why this path exists at all; the 2d context is only a fallback.
      function createRasterCanvas(bitmap) {
        const canvas = documentRef.createElement("canvas");
        canvas.className = "media-raster";
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.setAttribute("role", "img");
        canvas.setAttribute("aria-label", image.alt);
        canvas.style.visibility = "hidden";
        const transfer = canvas.getContext?.("bitmaprenderer");
        if (transfer?.transferFromImageBitmap) {
          transfer.transferFromImageBitmap(bitmap);
          return canvas;
        }
        const context = canvas.getContext?.("2d");
        if (!context?.drawImage) return null;
        context.drawImage(bitmap, 0, 0);
        imageDownscaler.release(bitmap);
        return canvas;
      }

      function showRaster(canvas, budget, source) {
        clearOriginalLoadTimeout();
        frame.append(canvas);
        showMedia(canvas);
        rasterByNode.set(node, { element: canvas, budget });
        card.dataset.mediaQuality = "original";
        applyMediaRotation(node);
        mediaLoadQueue.complete(node, "original", true);
        debugLog(item, "bounded-raster-built", {
          source,
          budget,
          width: canvas.width,
          height: canvas.height,
        });
      }

      async function startOriginalLoad(mediaURL) {
        debugLog(item, "original-load-started", { fileURL: mediaURL });
        const token = beginOriginalLoad();
        // Eagle's metadata already carries the master's dimensions, so the
        // bounded size is known before a single pixel is read. Decoding straight
        // from the file keeps the full-resolution bitmap from ever existing.
        const target = getRasterTargetSize(
          item.width,
          item.height,
          getNodeScreenLongEdge(node),
        );
        if (target) {
          const bitmap = await imageDownscaler.renderFromURL(mediaURL, target);
          if (!isCurrentOriginalLoad(token)) {
            imageDownscaler.release(bitmap);
            return;
          }
          if (bitmap) {
            const canvas = createRasterCanvas(bitmap);
            if (canvas) {
              showRaster(canvas, target.budget, "file");
              return;
            }
            imageDownscaler.release(bitmap);
          }
        }
        loadMasterElement(mediaURL, token);
      }

      // Only reached when the file itself could not be read, or the master is
      // already small enough to paint untouched. The element pays for decoding
      // the master at full size, which is exactly what the file path avoids.
      function loadMasterElement(mediaURL, token) {
        const originalImage = documentRef.createElement("img");
        originalImage.alt = image.alt;
        originalImage.decoding = "async";
        originalImage.draggable = false;
        originalImage.style.visibility = "hidden";
        originalImage.setAttribute("aria-hidden", "true");
        node.preloadImage = originalImage;
        frame.append(originalImage);
        originalImage.addEventListener("load", async () => {
          if (!isCurrentOriginalLoad(token)) return;
          const target = getRasterTargetSize(
            originalImage.naturalWidth || item.width,
            originalImage.naturalHeight || item.height,
            getNodeScreenLongEdge(node),
          );
          if (target) {
            // The watchdog stays armed across this: rendering the raster is
            // still part of the load, and a stall has to free the queue slot.
            const bitmap = await imageDownscaler.renderFromImage(originalImage, target);
            if (!isCurrentOriginalLoad(token)) {
              imageDownscaler.release(bitmap);
              return;
            }
            const canvas = bitmap ? createRasterCanvas(bitmap) : null;
            if (canvas) {
              node.preloadImage = null;
              originalImage.removeAttribute("src");
              originalImage.remove();
              showRaster(canvas, target.budget, "element");
              return;
            }
            imageDownscaler.release(bitmap);
            // Falling through to the master is only safe when it is close to
            // what the card displays. A trace of doing it unconditionally showed
            // 40 MP masters painted into 130px cards at over 1000x oversample,
            // with tile-worker decode back up at 282ms/s — the exact thrash this
            // feature exists to prevent. Past that, the thumbnail is the better
            // answer, so keep it and stop asking.
            if (
              !canPaintMasterDirectly(
                originalImage.naturalWidth || item.width,
                originalImage.naturalHeight || item.height,
                getNodeScreenLongEdge(node),
              )
            ) {
              clearOriginalLoadTimeout();
              node.preloadImage = null;
              originalImage.removeAttribute("src");
              originalImage.remove();
              card.dataset.mediaQuality =
                mediaLoadQueue.snapshot(node)?.readyQuality || "thumbnail";
              mediaLoadQueue.complete(node, "original", false);
              debugLog(item, "bounded-raster-unavailable", {
                budget: target.budget,
                fileURL: mediaURL,
              });
              return;
            }
            debugLog(item, "master-painted-unbounded", { budget: target.budget });
          }

          clearOriginalLoadTimeout();
          await waitForImageDecode(originalImage, undefined, windowRef);
          if (!isCurrentOriginalLoad(token)) return;
          node.preloadImage = null;
          showMedia(originalImage);
          rasterByNode.delete(node);
          card.dataset.mediaQuality = "original";
          applyMediaRotation(node);
          mediaLoadQueue.complete(node, "original", true);
          debugLog(item, "original-load-succeeded", { fileURL: mediaURL });
        });
        originalImage.addEventListener("error", () => {
          failOriginalLoad("error", token);
        });
        originalImage.src = mediaURL;
      }

      image.addEventListener("load", () => {
        if (
          node.mediaGeneration !== mediaGeneration ||
          mediaLoadQueue.snapshot(node)?.loadingQuality !== "thumbnail"
        ) {
          return;
        }
        // A raster may already be showing if the original won the race; the
        // thumbnail is still worth keeping loaded for when it is handed back.
        if (!node.previewImage || node.previewImage === image) {
          image.style.visibility = "visible";
          card.dataset.mediaQuality =
            mediaLoadQueue.snapshot(node)?.originalFailed ? "original-failed" : "thumbnail";
          applyMediaRotation(node);
        }
        mediaLoadQueue.complete(node, "thumbnail", true);
      });
      image.addEventListener("error", () => {
        if (
          node.mediaGeneration !== mediaGeneration ||
          mediaLoadQueue.snapshot(node)?.loadingQuality !== "thumbnail"
        ) {
          return;
        }
        image.alt = "無法顯示縮圖";
        card.dataset.mediaQuality = "thumbnail-failed";
        mediaLoadQueue.complete(node, "thumbnail", false);
      });

      frame.append(image);
      if (retryOriginalButton) frame.append(retryOriginalButton);
      card.append(frame);
      node.previewImage = image;

      if (isVideo) {
        const playButton = documentRef.createElement("button");
        playButton.className = "play-button";
        playButton.type = "button";
        playButton.textContent = "▶";
        playButton.setAttribute("aria-label", `播放 ${item.name || "影片"}`);
        playButton.addEventListener("pointerdown", (event) => event.stopPropagation());
        playButton.addEventListener("click", (event) => {
          event.stopPropagation();
          onSelectNode(node);
          startVideo(frame, image, playButton, item, node);
        });
        node.startPlayback = () => startVideo(frame, image, playButton, item, node);
        frame.append(playButton);
      }

      card.addEventListener("dblclick", (event) => {
        if (!node.isVideo || event.target.closest("button, input")) return;
        event.preventDefault();
        onSelectNode(node);
        if (node.togglePlayback) node.togglePlayback();
        else node.startPlayback?.();
      });
      card.addEventListener("click", (event) => {
        if (event.target.closest("button, input")) return;
        onClickNode(node, {
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
        });
      });
      card.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenContextMenu(node);
      });

      return card;
    }

    function startVideo(frame, image, playButton, item, node) {
      startVideoPlayerImpl({
        frame,
        image,
        playButton,
        item,
        node,
        controlsHeight: getVideoControlsHeight(),
        initialVolume: getVideoVolume(),
        onVolumeChange,
        applyRotation: () => applyMediaRotation(node),
        onLayoutChange: () => {
          onPositionNode(node);
          onLayoutChange();
        },
        showToast,
      });
    }

    function applyMediaRotation(node) {
      if (!node.mediaElement) return;
      if (node.rotation === 0) {
        node.mediaElement.style.transform = "none";
        return;
      }
      const frame = node.element?.querySelector(".media-frame");
      const frameWidth = frame?.clientWidth || node.width;
      const frameHeight = frame?.clientHeight || node.mediaHeight;
      const radians = (node.rotation * Math.PI) / 180;
      const rotatedWidth =
        Math.abs(frameWidth * Math.cos(radians)) +
        Math.abs(frameHeight * Math.sin(radians));
      const rotatedHeight =
        Math.abs(frameWidth * Math.sin(radians)) +
        Math.abs(frameHeight * Math.cos(radians));
      const fitScale = Math.min(frameWidth / rotatedWidth, frameHeight / rotatedHeight);
      node.mediaElement.style.transform = `rotate(${node.rotation}deg) scale(${fitScale})`;
    }

    return Object.freeze({
      mount,
      preloadSelected,
      pause,
      play,
      releaseAll,
      reposition,
      rotate,
      retryOriginal,
      sync,
      syncQuality,
    });
  }

  function defaultDebugLog(item, event, details = {}) {
    let enabled = false;
    try {
      enabled = root.localStorage?.getItem(MEDIA_DEBUG_STORAGE_KEY) === "1";
    } catch {
      enabled = false;
    }
    if (!enabled) return;
    root.console?.log?.(`[bird-view] ${new Date().toISOString()} ${event}`, {
      name: item?.name,
      id: item?.id,
      ...details,
    });
  }

  return Object.freeze({ createMediaMaterializer });
});

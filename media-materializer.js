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
    getRasterDimensionBudget,
    getRasterTargetSize,
  } = core;
  const { MediaLoadQueue, waitForImageDecode } = media;
  const { startVideoPlayer } = video;
  const { createImageDownscaler } = downscaler;

  const MAX_CONCURRENT_IMAGE_LOADS = 4;
  const MAX_BACKGROUND_ORIGINAL_LOADS = 1;
  const ORIGINAL_IMAGE_LOAD_TIMEOUT = 8000;
  const MEDIA_DEBUG_STORAGE_KEY = "bird-view-debug";
  const MAX_ELEMENT_FALLBACK_SCALE = 4;
  const MAX_ELEMENT_FALLBACK_PIXELS = 4_000_000;

  function createMediaMaterializer(options = {}) {
    const {
      world,
      document: documentRef = root.document,
      window: windowRef = root.window || root,
      mediaLoadQueue = new MediaLoadQueue({
        maxConcurrent: MAX_CONCURRENT_IMAGE_LOADS,
        maxBackgroundOriginals: MAX_BACKGROUND_ORIGINAL_LOADS,
      }),
      imageDownscaler = createImageDownscaler({ window: windowRef }),
      now = () => (windowRef.performance || root.performance || Date).now(),
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
    const resizeRasterByNode = new WeakMap();
    const thumbnailImageByNode = new WeakMap();
    const deferredElementFallbackNodes = new WeakSet();
    let shouldDeferElementFallback = () => false;
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
    // Shrinking waits for the camera to settle, then copies the existing canvas
    // into a smaller one. Reading the master again for fewer pixels wastes a
    // queue slot and caused the zoom-out burst captured by the timing log.
    function refreshRasterBudget(
      node,
      {
        allowShrink = false,
        targetBudget = null,
        prewarmed = false,
        priority = "normal",
      } = {},
    ) {
      const raster = rasterByNode.get(node);
      if (!raster) return;
      const screenLongEdge = getNodeScreenLongEdge(node);
      const actualBudget = getRasterDimensionBudget(screenLongEdge);
      const needed = Number(targetBudget) > 0 ? Number(targetBudget) : actualBudget;
      if (needed === raster.budget) return;
      if (needed < raster.budget && !allowShrink) return;
      if (mediaLoadQueue.snapshot(node)?.readyQuality !== "original") return;
      if (
        needed < raster.budget &&
        raster.prewarmed &&
        getNextRasterBudget(actualBudget) === raster.budget
      ) {
        return;
      }
      debugLog(node.item, "raster-budget-change-requested", {
        atMs: readNow(now),
        screenLongEdge,
        currentBudget: raster.budget,
        requestedBudget: needed,
        direction: needed > raster.budget ? "grow" : "shrink",
      });
      if (needed < raster.budget) {
        resizeRasterByNode.get(node)?.(needed);
        return;
      }
      if (!mediaLoadQueue.invalidate(node, "original")) return;
      requestMediaByNode.get(node)?.("original", { budget: needed, prewarmed, priority });
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
      resizeRasterByNode.delete(node);

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
        requestMediaByNode.get(node)?.("original", { priority: "high" });
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
      deferOriginals = () => false,
      deferElementFallback = () => false,
      prioritizeOriginal = () => false,
      preserveOriginals = false,
    } = {}) {
      shouldDeferElementFallback = normalizePredicate(deferElementFallback);
      const visible = new Set(visibleNodes);
      const retained = new Set(retainedNodes);

      if (!preserveOriginals) {
        for (const node of materializedNodes) {
          if (getQuality(node) === "original") continue;
          mediaLoadQueue.cancel(node, "original");
          dropOriginalRaster(node);
        }
      }

      for (const node of mountedNodes) {
        if (!visible.has(node) && node !== selectedNode) unmount(node);
      }
      for (const node of [...materializedNodes]) {
        if (!retained.has(node) && node !== selectedNode) release(node);
      }

      for (const node of visible) mount(node);
      for (const node of loadNodes) {
        const deferFallback = shouldDeferElementFallback();
        if (!deferFallback) deferredElementFallbackNodes.delete(node);
        const quality = getQuality(node);
        const requested = requestedQuality(node, quality, deferOriginals);
        if (
          requested === "original" &&
          deferFallback &&
          deferredElementFallbackNodes.has(node)
        ) {
          continue;
        }
        const priority = prioritizeOriginal(node) ? "high" : "normal";
        requestMediaByNode.get(node)?.(
          requested,
          requested === "original" ? { priority } : null,
        );
        if (quality === "original") {
          refreshRasterBudget(node, {
            allowShrink: !preserveOriginals,
            priority,
          });
        }
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
      if (quality !== "original" || !deferOriginals(node)) return quality;
      if (mediaLoadQueue.snapshot(node)?.readyQuality === "original") return quality;
      return "thumbnail";
    }

    function syncQuality({
      loadNodes = [],
      getQuality = () => "thumbnail",
      deferOriginals = () => false,
      prewarmRaster = () => false,
      prioritizeOriginal = () => false,
      deferElementFallback = () => false,
    } = {}) {
      shouldDeferElementFallback = normalizePredicate(deferElementFallback);
      for (const node of materializedNodes) {
        if (getQuality(node) !== "original") mediaLoadQueue.cancel(node, "original");
      }

      for (const node of loadNodes) {
        if (!materializedNodes.has(node)) continue;
        const deferFallback = shouldDeferElementFallback();
        if (!deferFallback) deferredElementFallbackNodes.delete(node);
        const quality = getQuality(node);
        if (quality !== "original") {
          requestMediaByNode.get(node)?.(quality);
          continue;
        }
        if (deferOriginals(node)) continue;
        if (deferFallback && deferredElementFallbackNodes.has(node)) continue;
        const screenLongEdge = getNodeScreenLongEdge(node);
        const actualBudget = getRasterDimensionBudget(screenLongEdge);
        const shouldPrewarm = prewarmRaster(node);
        const targetBudget = shouldPrewarm
          ? getNextRasterBudget(actualBudget)
          : actualBudget;
        const priority = prioritizeOriginal(node) ? "high" : "normal";
        requestMediaByNode.get(node)?.("original", {
          budget: targetBudget,
          prewarmed: shouldPrewarm && targetBudget > actualBudget,
          priority,
        });
        refreshRasterBudget(node, {
          targetBudget,
          prewarmed: shouldPrewarm && targetBudget > actualBudget,
          priority,
        });
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
      let originalRequestedAt = null;
      let requestedOriginalBudget = null;
      let requestedOriginalPrewarmed = false;
      let requestedOriginalPriority = "normal";
      const beginOriginalLoad = () => {
        const startedAt = readNow(now);
        originalLoadToken = {
          requestedAt: originalRequestedAt ?? startedAt,
          startedAt,
          budget: requestedOriginalBudget,
          prewarmed: requestedOriginalPrewarmed,
          priority: requestedOriginalPriority,
        };
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
      const requestMedia = (quality = "thumbnail", rasterRequest = null) => {
        if (quality === "original") {
          requestedOriginalBudget =
            Number(rasterRequest?.budget) > 0
              ? Number(rasterRequest.budget)
              : getRasterDimensionBudget(getNodeScreenLongEdge(node));
          requestedOriginalPrewarmed = Boolean(rasterRequest?.prewarmed);
          requestedOriginalPriority =
            rasterRequest?.priority === "high" ? "high" : "normal";
        }
        if (quality === "original" && originalImageURL) traceOriginalQualityRequest();
        const requested = mediaLoadQueue.request(node, quality, {
          priority: quality === "original" ? requestedOriginalPriority : "normal",
        });
        if (quality === "original" && originalImageURL) watchOriginalLoad();
        return requested;
      };
      const retry = () => {
        requestedOriginalBudget = getRasterDimensionBudget(getNodeScreenLongEdge(node));
        requestedOriginalPrewarmed = false;
        requestedOriginalPriority = "high";
        traceOriginalQualityRequest({ force: true });
        const requested = mediaLoadQueue.retry(node, "original", { priority: "high" });
        watchOriginalLoad();
        return requested;
      };

      function traceOriginalQualityRequest({ force = false } = {}) {
        const snapshot = mediaLoadQueue.snapshot(node);
        if (!force && !shouldTraceOriginalRequest(snapshot)) return;
        originalRequestedAt = readNow(now);
        const screenLongEdge = getNodeScreenLongEdge(node);
        const target = getRasterTargetSize(
          item.width,
          item.height,
          requestedOriginalBudget || screenLongEdge,
        );
        debugLog(item, "original-quality-requested", {
          atMs: originalRequestedAt,
          screenLongEdge,
          requestedBudget:
            target?.budget || Math.max(Number(item.width) || 0, Number(item.height) || 0),
          queueState: describeQueueState(snapshot),
          priority: requestedOriginalPriority,
        });
      }

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
          originalRequestedAt = null;
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

      function resizeRaster(targetBudget) {
        const raster = rasterByNode.get(node);
        const source = raster?.element;
        if (!source || source.tagName !== "CANVAS") return false;
        const sourceLongEdge = Math.max(source.width, source.height);
        if (!(sourceLongEdge > 0) || !(targetBudget > 0) || targetBudget >= sourceLongEdge) {
          return false;
        }
        const ratio = targetBudget / sourceLongEdge;
        const canvas = documentRef.createElement("canvas");
        canvas.className = "media-raster";
        canvas.width = Math.max(1, Math.round(source.width * ratio));
        canvas.height = Math.max(1, Math.round(source.height * ratio));
        canvas.setAttribute("role", "img");
        canvas.setAttribute("aria-label", image.alt);
        canvas.style.visibility = "hidden";
        const context = canvas.getContext?.("2d");
        if (!context?.drawImage) return false;
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        frame.append(canvas);
        showMedia(canvas);
        rasterByNode.set(node, { element: canvas, budget: targetBudget, prewarmed: false });
        card.dataset.mediaQuality = "original";
        applyMediaRotation(node);
        debugLog(item, "bounded-raster-resized", {
          sourceBudget: raster.budget,
          budget: targetBudget,
          width: canvas.width,
          height: canvas.height,
        });
        return true;
      }
      resizeRasterByNode.set(node, resizeRaster);

      function showRaster(canvas, budget, source, token) {
        clearOriginalLoadTimeout();
        deferredElementFallbackNodes.delete(node);
        frame.append(canvas);
        showMedia(canvas);
        rasterByNode.set(node, { element: canvas, budget, prewarmed: token.prewarmed });
        card.dataset.mediaQuality = "original";
        applyMediaRotation(node);
        mediaLoadQueue.complete(node, "original", true);
        debugLog(item, "bounded-raster-built", {
          ...getTimingDetails(token, now),
          source,
          priority: token.priority,
          budget,
          width: canvas.width,
          height: canvas.height,
        });
        originalRequestedAt = null;
        refreshRasterBudget(node, {
          targetBudget: requestedOriginalBudget,
          prewarmed: requestedOriginalPrewarmed,
          priority: requestedOriginalPriority,
        });
      }

      function failBoundedRaster(target, token, failure = {}, originalImage = null) {
        clearOriginalLoadTimeout();
        if (originalImage) {
          node.preloadImage = null;
          originalImage.removeAttribute("src");
          originalImage.remove();
        }
        mediaLoadQueue.complete(node, "original", false);
        card.dataset.mediaQuality = "original-failed";
        debugLog(item, "bounded-raster-unavailable", {
          ...getTimingDetails(token, now),
          source: failure.source || "file",
          stage: failure.stage || "decode",
          reason: failure.reason || "unavailable",
          budget: target.budget,
          fileURL: originalImageURL,
        });
      }

      async function startOriginalLoad(mediaURL) {
        const token = beginOriginalLoad();
        // Eagle's metadata already carries the master's dimensions, so the
        // bounded size is known before a single pixel is read. Decoding straight
        // from the file keeps the full-resolution bitmap from ever existing.
        const screenLongEdge = getNodeScreenLongEdge(node);
        const target = getRasterTargetSize(
          item.width,
          item.height,
          token.budget || screenLongEdge,
        );
        let failure = null;
        debugLog(item, "original-load-started", {
          atMs: token.startedAt,
          queueWaitMs: elapsedMs(token.requestedAt, token.startedAt),
          screenLongEdge,
          requestedBudget:
            target?.budget || Math.max(Number(item.width) || 0, Number(item.height) || 0),
          priority: token.priority,
          fileURL: mediaURL,
        });
        if (target) {
          const bitmap = await imageDownscaler.renderFromURL(mediaURL, target, {
            onFailure: (details) => {
              failure = details;
            },
          });
          if (!isCurrentOriginalLoad(token)) {
            imageDownscaler.release(bitmap);
            return;
          }
          if (bitmap) {
            const canvas = createRasterCanvas(bitmap);
            if (canvas) {
              showRaster(canvas, target.budget, "file", token);
              return;
            }
            imageDownscaler.release(bitmap);
            failBoundedRaster(target, token, {
              source: "file",
              stage: "canvas",
              reason: "context-unavailable",
            });
            return;
          }
          if (!canUseElementFallback(item, target)) {
            failBoundedRaster(target, token, { source: "file", ...failure });
            return;
          }
        }
        if (deferOriginalElementFallback(token, { source: "file", ...failure })) return;
        loadMasterElement(mediaURL, token);
      }

      function deferOriginalElementFallback(token, failure = {}) {
        if (!shouldDeferElementFallback()) return false;
        clearOriginalLoadTimeout();
        deferredElementFallbackNodes.add(node);
        debugLog(item, "original-element-fallback-deferred", {
          ...getTimingDetails(token, now),
          source: failure.source || "file",
          stage: failure.stage || "element",
          reason: failure.reason || "camera-moving",
          fileURL: originalImageURL,
        });
        mediaLoadQueue.cancel(node, "original");
        return true;
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
            let failure = null;
            const bitmap = await imageDownscaler.renderFromImage(originalImage, target, {
              onFailure: (details) => {
                failure = details;
              },
            });
            if (!isCurrentOriginalLoad(token)) {
              imageDownscaler.release(bitmap);
              return;
            }
            const canvas = bitmap ? createRasterCanvas(bitmap) : null;
            if (canvas) {
              node.preloadImage = null;
              originalImage.removeAttribute("src");
              originalImage.remove();
              showRaster(canvas, target.budget, "element", token);
              return;
            }
            imageDownscaler.release(bitmap);
            failBoundedRaster(
              target,
              token,
              {
                source: "element",
                ...(bitmap
                  ? { stage: "canvas", reason: "context-unavailable" }
                  : failure),
              },
              originalImage,
            );
            return;
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
          debugLog(item, "original-load-succeeded", {
            ...getTimingDetails(token, now),
            fileURL: mediaURL,
          });
          originalRequestedAt = null;
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

  // The element fallback decodes the full master before bounding it. Keep that
  // compatibility route for unknown or moderately oversized sources, but do not
  // let a failed file decode turn a 40 MP master into a main-thread decode spike.
  function canUseElementFallback(item, target) {
    if (!target) return true;
    const width = Number(item?.width) || 0;
    const height = Number(item?.height) || 0;
    const sourceLongEdge = Math.max(width, height);
    if (!(sourceLongEdge > 0)) return true;
    return (
      width * height <= MAX_ELEMENT_FALLBACK_PIXELS &&
      sourceLongEdge <= target.budget * MAX_ELEMENT_FALLBACK_SCALE
    );
  }

  function normalizePredicate(predicate) {
    return typeof predicate === "function" ? predicate : () => Boolean(predicate);
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

  function getNextRasterBudget(screenLongEdge) {
    const current = getRasterDimensionBudget(screenLongEdge);
    return getRasterDimensionBudget(current + 1);
  }

  function shouldTraceOriginalRequest(snapshot) {
    if (!snapshot || snapshot.originalFailed || snapshot.readyQuality === "original") return false;
    return ![
      snapshot.loadingQuality,
      snapshot.queuedQuality,
      snapshot.pendingQuality,
    ].includes("original");
  }

  function describeQueueState(snapshot) {
    if (!snapshot) return "unregistered";
    if (snapshot.loadingQuality) return `loading-${snapshot.loadingQuality}`;
    if (snapshot.queuedQuality) return `queued-${snapshot.queuedQuality}`;
    if (snapshot.pendingQuality) return `pending-${snapshot.pendingQuality}`;
    if (snapshot.readyQuality) return `ready-${snapshot.readyQuality}`;
    return "idle";
  }

  function getTimingDetails(token, now) {
    const atMs = readNow(now);
    const requestedAt = Number(token?.requestedAt);
    const startedAt = Number(token?.startedAt);
    return {
      atMs,
      queueWaitMs: elapsedMs(requestedAt, startedAt),
      buildMs: elapsedMs(startedAt, atMs),
      totalMs: elapsedMs(requestedAt, atMs),
    };
  }

  function elapsedMs(start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return Math.round(Math.max(0, end - start) * 10) / 10;
  }

  function readNow(now) {
    const value = Number(now());
    return Number.isFinite(value) ? value : 0;
  }

  return Object.freeze({ createMediaMaterializer });
});

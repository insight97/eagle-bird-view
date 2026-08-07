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
  const ORIGINAL_IMAGE_LOAD_TIMEOUT = 8000;
  const MEDIA_DEBUG_STORAGE_KEY = "bird-view-debug";

  function createMediaMaterializer(options = {}) {
    const {
      world,
      document: documentRef = root.document,
      window: windowRef = root.window || root,
      mediaLoadQueue = new MediaLoadQueue({ maxConcurrent: MAX_CONCURRENT_IMAGE_LOADS }),
      imageDownscaler = createImageDownscaler({
        window: windowRef,
        document: documentRef,
      }),
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
    // The bounded raster a card is currently painting, so a later zoom-in can
    // tell whether it still has enough pixels.
    const rasterByNode = new WeakMap();
    // Marks an <img> as already carrying its bounded raster, so the load event
    // that the swap re-fires is not mistaken for a fresh master.
    const rasterByImage = new WeakMap();

    // Eagle hands out full-resolution masters with no intermediate size, so a
    // 40 MP painting would otherwise be decoded and downsampled on the raster
    // path every time the compositor needs the card. Render it once at a bounded
    // size and paint that instead. Returns null when the master is already small
    // enough, or when the platform cannot downscale.
    async function buildBoundedRaster(node, sourceImage, item) {
      const target = getRasterTargetSize(
        sourceImage.naturalWidth || item?.width,
        sourceImage.naturalHeight || item?.height,
        getNodeScreenLongEdge(node),
      );
      if (!target) return null;
      const url = await imageDownscaler.renderFromImage(sourceImage, target);
      if (!url) {
        // Falling back to the master still shows the right picture, but it puts
        // the decode cost back on the raster path, so make it visible.
        debugLog(item, "bounded-raster-unavailable", {
          budget: target.budget,
          fileURL: item?.fileURL,
        });
        return null;
      }
      debugLog(item, "bounded-raster-built", {
        source: "element",
        budget: target.budget,
        width: target.width,
        height: target.height,
        sourceWidth: sourceImage.naturalWidth,
        sourceHeight: sourceImage.naturalHeight,
      });
      return { url, budget: target.budget };
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
      original.removeAttribute("src");
      original.remove();
      rasterByImage.delete(original);
      rasterByNode.delete(node);
      imageDownscaler.revoke(raster.url);
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
      imageDownscaler.revoke(rasterByNode.get(node)?.url);
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
      const failOriginalLoad = (reason = "error", originalImage) => {
        if (
          node.mediaGeneration !== mediaGeneration ||
          node.preloadImage !== originalImage ||
          mediaLoadQueue.snapshot(node)?.loadingQuality !== "original"
        ) {
          return;
        }
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
          if (latest.loadingQuality === "original" && node.preloadImage) {
            failOriginalLoad("timeout", node.preloadImage);
          } else {
            markOriginalLoadFailed("timeout");
          }
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
          if (!node.preloadImage) return;
          const originalImage = node.preloadImage;
          node.preloadImage = null;
          originalImage.removeAttribute("src");
          originalImage.remove();
          const abandonedRaster = rasterByImage.get(originalImage);
          rasterByImage.delete(originalImage);
          if (abandonedRaster && abandonedRaster.url !== rasterByNode.get(node)?.url) {
            imageDownscaler.revoke(abandonedRaster.url);
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
            debugLog(item, "original-load-started", { fileURL: mediaURL });
            const originalImage = documentRef.createElement("img");
            originalImage.alt = image.alt;
            originalImage.decoding = "async";
            originalImage.draggable = false;
            originalImage.style.visibility = "hidden";
            originalImage.setAttribute("aria-hidden", "true");
            node.preloadImage = originalImage;
            frame.append(originalImage);
            const isCurrentOriginalLoad = () =>
              node.mediaGeneration === mediaGeneration &&
              node.preloadImage === originalImage &&
              mediaLoadQueue.snapshot(node)?.loadingQuality === "original";
            originalImage.addEventListener("load", async () => {
              if (!isCurrentOriginalLoad()) return;

              // Reaching here without a recorded raster means the element loaded
              // the master itself, because the file could not be read directly.
              // Bound it from the decoded element instead and let the swap
              // re-fire load. The watchdog stays armed across that swap: it is
              // still part of the load, and a stall there has to free the slot.
              if (!rasterByImage.has(originalImage)) {
                const raster = await buildBoundedRaster(node, originalImage, item);
                if (!isCurrentOriginalLoad()) {
                  imageDownscaler.revoke(raster?.url);
                  return;
                }
                rasterByImage.set(originalImage, raster);
                if (raster) {
                  originalImage.src = raster.url;
                  return;
                }
              }

              clearOriginalLoadTimeout();
              await waitForImageDecode(originalImage, undefined, windowRef);
              if (!isCurrentOriginalLoad()) return;
              // A re-raster at a sharper budget replaces an earlier original, so
              // the element it displaced has to go.
              const displacedImage = node.previewImage;
              const staleOriginal =
                displacedImage && displacedImage !== originalImage && displacedImage !== image
                  ? displacedImage
                  : null;
              originalImage.style.visibility = "visible";
              originalImage.removeAttribute("aria-hidden");
              if (displacedImage && displacedImage !== originalImage) {
                displacedImage.style.visibility = "hidden";
              }
              node.previewImage = originalImage;
              node.preloadImage = null;
              node.mediaElement = originalImage;
              const raster = rasterByImage.get(originalImage) || null;
              const previousRaster = rasterByNode.get(node) || null;
              if (raster) rasterByNode.set(node, raster);
              else rasterByNode.delete(node);
              if (staleOriginal) {
                staleOriginal.removeAttribute("src");
                staleOriginal.remove();
                rasterByImage.delete(staleOriginal);
              }
              if (previousRaster && previousRaster.url !== raster?.url) {
                imageDownscaler.revoke(previousRaster.url);
              }
              card.dataset.mediaQuality = "original";
              applyMediaRotation(node);
              mediaLoadQueue.complete(node, "original", true);
              debugLog(item, "original-load-succeeded", { fileURL: mediaURL });
            });
            originalImage.addEventListener("error", () => {
              failOriginalLoad("error", originalImage);
            });

            // Eagle's metadata already carries the master's dimensions, so the
            // bounded size is known before a single pixel is read. Rendering the
            // raster straight from the file keeps the full-resolution bitmap from
            // ever existing; only if that is unavailable does the element load
            // the master and pay for decoding it.
            const target = getRasterTargetSize(
              item.width,
              item.height,
              getNodeScreenLongEdge(node),
            );
            if (target) {
              imageDownscaler
                .renderFromURL(mediaURL, target)
                .then((url) => {
                  if (!isCurrentOriginalLoad()) {
                    imageDownscaler.revoke(url);
                    return;
                  }
                  if (url) {
                    rasterByImage.set(originalImage, { url, budget: target.budget });
                    debugLog(item, "bounded-raster-built", {
                      source: "file",
                      budget: target.budget,
                      width: target.width,
                      height: target.height,
                    });
                    originalImage.src = url;
                    return;
                  }
                  originalImage.src = mediaURL;
                })
                .catch(() => {
                  if (isCurrentOriginalLoad()) originalImage.src = mediaURL;
                });
              return;
            }
            originalImage.src = mediaURL;
            return;
          }
          image.src = mediaURL;
        },
      });
      image.addEventListener("load", () => {
        if (
          node.mediaGeneration !== mediaGeneration ||
          mediaLoadQueue.snapshot(node)?.loadingQuality !== "thumbnail"
        ) {
          return;
        }
        image.style.visibility = "visible";
        card.dataset.mediaQuality =
          mediaLoadQueue.snapshot(node)?.originalFailed ? "original-failed" : "thumbnail";
        applyMediaRotation(node);
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

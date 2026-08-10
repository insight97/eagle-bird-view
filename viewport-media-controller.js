"use strict";

(function exposeBirdViewViewportMedia(root, factory) {
  const core =
    root.BirdViewCore ||
    (typeof module === "object" && typeof require === "function"
      ? require("./bird-view-core.js")
      : null);
  const viewportWork =
    root.BirdViewViewportWork ||
    (typeof module === "object" && typeof require === "function"
      ? require("./viewport-work-scheduler.js")
      : null);
  const controller = factory(core, viewportWork, root);
  if (typeof module === "object" && module.exports) module.exports = controller;
  root.BirdViewViewportMedia = controller;
})(typeof globalThis === "object" ? globalThis : this, (core, viewportWork, root) => {
  const {
    findNearestNodeToPoint,
    findNodesNearViewport,
    getPreloadMargins,
    getViewportWorldCenter,
    isPlayableNode,
  } = core;
  const { createViewportWorkScheduler } = viewportWork;

  const CAMERA_MOTION_IDLE = 180;
  const ORIGINAL_IMAGE_MIN_HEIGHT = 320;
  const PRELOAD_MARGIN = 120;
  const RESOURCE_RELEASE_VIEWPORTS = 2;
  const MOTIONS = new Set(["focus", "pan", "zoom"]);

  // Owns the complete viewport-media lifecycle. The caller reports camera
  // motion; classification, idle settling, scheduling, media planning, and
  // materializer synchronization stay inside this implementation.
  function createViewportMediaController(options = {}) {
    const {
      window: windowRef = root.window || root,
      now = () => (root.performance || Date).now(),
      getSnapshot,
      materializer,
      onSettled = () => {},
      requestRender = () => {},
    } = options;
    if (
      typeof getSnapshot !== "function" ||
      typeof materializer?.sync !== "function" ||
      typeof materializer?.syncQuality !== "function"
    ) {
      throw new Error("Viewport media controller requires a snapshot and materializer");
    }

    const activeMotions = new Map();
    let lastCameraChange = -Infinity;
    let lastCameraMotion = "settled";
    let pendingMotion = null;
    let restartDiscreteZoom = false;
    let lastCoverageCamera = null;
    let previousZoomQualityScale = null;

    const scheduler = createViewportWorkScheduler({
      window: windowRef,
      now,
      getCameraMotion,
      onPanMedia: syncCoverage,
      onZoomQuality: syncQuality,
      onSettled: () => {
        syncCoverage();
        onSettled();
      },
    });

    function beginMotion(motion) {
      assertMotion(motion);
      activeMotions.set(motion, (activeMotions.get(motion) || 0) + 1);
      lastCameraChange = now();
      lastCameraMotion = motion;
      pendingMotion = null;
      if (motion === "zoom") {
        previousZoomQualityScale = getSnapshot()?.camera?.scale ?? null;
        scheduler.restartZoomQuality();
      }
      else scheduler.reschedule();
    }

    function noteMotion(motion) {
      assertMotion(motion);
      restartDiscreteZoom = motion === "zoom" && getCameraMotion() !== "zoom";
      if (restartDiscreteZoom) {
        previousZoomQualityScale = getSnapshot()?.camera?.scale ?? null;
      }
      pendingMotion = motion;
      lastCameraChange = now();
      lastCameraMotion = motion;
    }

    function cameraChanged() {
      const activeMotion = getActiveMotion();
      const motion = activeMotion || pendingMotion;
      pendingMotion = null;
      if (motion) {
        lastCameraChange = now();
        lastCameraMotion = motion;
      }
      if (restartDiscreteZoom && motion === "zoom") {
        restartDiscreteZoom = false;
        scheduler.restartZoomQuality();
        return;
      }
      restartDiscreteZoom = false;
      scheduler.schedule();
    }

    function endMotion(motion) {
      assertMotion(motion);
      const count = activeMotions.get(motion) || 0;
      if (!count) return;
      if (count === 1) activeMotions.delete(motion);
      else activeMotions.set(motion, count - 1);
      if (motion === "zoom") {
        scheduler.stopZoomQuality();
        previousZoomQualityScale = null;
      }
      if (getActiveMotion()) {
        scheduler.reschedule();
        return;
      }
      pendingMotion = null;
      restartDiscreteZoom = false;
      lastCameraChange = -Infinity;
      lastCameraMotion = "settled";
      scheduler.flush();
      requestRender();
    }

    function getCameraMotion() {
      const activeMotion = getActiveMotion();
      if (activeMotion) return activeMotion;
      if (now() - lastCameraChange < CAMERA_MOTION_IDLE) return lastCameraMotion;
      return "settled";
    }

    function getActiveMotion() {
      if (activeMotions.has("focus")) return "focus";
      if (activeMotions.has("zoom")) return "zoom";
      if (activeMotions.has("pan")) return "pan";
      return null;
    }

    function syncCoverage() {
      materializer.sync(planCoverage());
    }

    function syncQuality() {
      materializer.syncQuality(planQuality());
    }

    function planCoverage() {
      const snapshot = normalizeSnapshot(getSnapshot(), getCameraMotion());
      const travel = lastCoverageCamera
        ? {
            x: snapshot.camera.x - lastCoverageCamera.x,
            y: snapshot.camera.y - lastCoverageCamera.y,
          }
        : null;
      lastCoverageCamera = { x: snapshot.camera.x, y: snapshot.camera.y };
      return buildPlan(snapshot, snapshot.motion === "pan" ? travel : null);
    }

    // Zoom revisits quality for cards already covered. It neither advances the
    // directional preload window nor changes mount ownership.
    function planQuality() {
      const snapshot = normalizeSnapshot(getSnapshot(), getCameraMotion());
      const zoomingIn =
        previousZoomQualityScale !== null &&
        snapshot.camera.scale > previousZoomQualityScale;
      previousZoomQualityScale = snapshot.camera.scale;
      const plan = buildPlan(snapshot, null);
      const prewarmNode = zoomingIn ? getPriorityRasterNode(plan, snapshot) : null;
      return {
        loadNodes: plan.loadNodes,
        getQuality: plan.getQuality,
        deferOriginals: plan.deferOriginals,
        prewarmRaster: (node) => node === prewarmNode,
        prioritizeOriginal: plan.prioritizeOriginal,
        deferElementFallback: plan.deferElementFallback,
      };
    }

    function getPriorityRasterNode(plan, snapshot) {
      if (
        snapshot.selectedNode &&
        !isPlayableNode(snapshot.selectedNode) &&
        plan.loadNodes.includes(snapshot.selectedNode)
      ) {
        return snapshot.selectedNode;
      }
      return findNearestNodeToPoint(
        plan.loadNodes.filter((node) => !isPlayableNode(node)),
        getViewportWorldCenter(snapshot.camera, snapshot.viewport),
      );
    }

    function buildPlan(snapshot, travel) {
      const { camera, viewport } = snapshot;
      const mountMargin = Math.max(viewport.width, viewport.height);
      const visibleNodes = findNodesNearViewport(
        snapshot.rows,
        camera,
        viewport,
        mountMargin,
      );
      const retainedNodes = new Set(
        findNodesNearViewport(
          snapshot.rows,
          camera,
          viewport,
          mountMargin * RESOURCE_RELEASE_VIEWPORTS,
        ),
      );
      const margins = getPreloadMargins(travel, PRELOAD_MARGIN, mountMargin);
      const standing = getPreloadMargins(null, PRELOAD_MARGIN, mountMargin);
      const loadNodes = [];
      const sharpNodes = new Set();

      for (const node of visibleNodes) {
        if (!isWithinBand(node, camera, viewport, margins)) continue;
        loadNodes.push(node);
        if (isWithinBand(node, camera, viewport, standing)) sharpNodes.add(node);
      }

      const moving = snapshot.motion !== "settled";
      const priorityNode = getPriorityRasterNode({ loadNodes }, snapshot);
      return {
        visibleNodes,
        retainedNodes,
        loadNodes,
        selectedNode: snapshot.selectedNode,
        preserveOriginals: moving,
        deferOriginals: (node) => moving || !sharpNodes.has(node),
        // This stays live after the plan is built. A bounded file decode may
        // finish after motion ends, and in that case its compatibility fallback
        // is safe to continue without waiting for another pass.
        deferElementFallback: () => getCameraMotion() !== "settled",
        prioritizeOriginal: (node) => node === priorityNode,
        getQuality: (node) => {
          if (node === snapshot.selectedNode && !isPlayableNode(node)) return "original";
          if (isPlayableNode(node)) return "thumbnail";
          return node.mediaHeight * camera.scale >= ORIGINAL_IMAGE_MIN_HEIGHT
            ? "original"
            : "thumbnail";
        },
      };
    }

    function assertMotion(motion) {
      if (!MOTIONS.has(motion)) throw new Error(`Unknown camera motion: ${motion}`);
    }

    return Object.freeze({ beginMotion, cameraChanged, endMotion, noteMotion });
  }

  function normalizeSnapshot(snapshot = {}, motion) {
    return {
      rows: Array.isArray(snapshot.rows) ? snapshot.rows : [],
      camera: snapshot.camera || { x: 0, y: 0, scale: 1 },
      viewport: snapshot.viewport || { width: 0, height: 0 },
      selectedNode: snapshot.selectedNode || null,
      motion,
    };
  }

  function isWithinBand(node, camera, viewport, band) {
    const left = camera.x + node.x * camera.scale;
    const top = camera.y + node.y * camera.scale;
    const right = left + node.width * camera.scale;
    const bottom = top + node.mediaHeight * camera.scale;
    return (
      right >= -band.left &&
      left <= viewport.width + band.right &&
      bottom >= -band.top &&
      top <= viewport.height + band.bottom
    );
  }

  return Object.freeze({ createViewportMediaController });
});

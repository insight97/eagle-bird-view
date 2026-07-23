"use strict";

(function exposeBirdViewCamera(root, factory) {
  const core =
    root.BirdViewCore ||
    (typeof module === "object" && typeof require === "function"
      ? require("./bird-view-core.js")
      : null);
  const camera = factory(core, root);
  if (typeof module === "object" && module.exports) module.exports = camera;
  root.BirdViewCamera = camera;
})(typeof globalThis === "object" ? globalThis : this, (core, root) => {
  const {
    centerCameraAtPoint,
    clamp,
    directionFor,
    getCrossRowFocusDuration,
    getRowFocusScale,
    getViewportPanDelta,
    interpolateCamera,
    zoomCameraAtPoint,
  } = core;

  const CAMERA_FOCUS_DURATION = 180;
  const MIN_ZOOM = 0.08;
  const MAX_ZOOM = 8;
  const DEFAULT_VIEWPORT_PAN_FRACTION = 2 / 3;
  const DEFAULT_FOCUS_ROW_EMPHASIS = 0.9;
  const DEFAULT_CAMERA_FIT_PADDING = 64;
  const DEFAULT_VIDEO_CONTROLS_HEIGHT = 10;
  const DEFAULT_SMOOTH_PAN_SPEED = 480;
  const DEFAULT_SMOOTH_ZOOM_SPEED = 1.5;

  function createCameraNavigation(options = {}) {
    const {
      state,
      elements,
      getBaseScale,
      updateCamera,
      selectNodeAtViewportCenter,
      requestAnimationFrame = root.requestAnimationFrame?.bind(root),
      cancelAnimationFrame = root.cancelAnimationFrame?.bind(root),
      now = () => root.performance.now(),
      viewportPanFraction = DEFAULT_VIEWPORT_PAN_FRACTION,
      focusRowEmphasis = DEFAULT_FOCUS_ROW_EMPHASIS,
      cameraFitPadding = DEFAULT_CAMERA_FIT_PADDING,
      videoControlsHeight = DEFAULT_VIDEO_CONTROLS_HEIGHT,
      minZoom = MIN_ZOOM,
      maxZoom = MAX_ZOOM,
    } = options;

    if (!state || !elements?.viewport || !getBaseScale || !updateCamera) {
      throw new Error("Camera navigation requires state, viewport, scale, and camera callbacks");
    }

    function cancelCameraFocus() {
      if (state.cameraFocusFrame === null) return;
      cancelAnimationFrame?.(state.cameraFocusFrame);
      state.cameraFocusFrame = null;
    }

    function animateCameraTo(target, { animate = true, duration = CAMERA_FOCUS_DURATION } = {}) {
      cancelCameraFocus();
      if (
        Math.abs(state.camera.x - target.x) < 0.1 &&
        Math.abs(state.camera.y - target.y) < 0.1 &&
        Math.abs(state.camera.scale - target.scale) < 0.0001
      ) {
        updateCamera();
        return;
      }
      if (!animate) {
        state.camera = { ...state.camera, ...target };
        updateCamera();
        return;
      }

      const start = { ...state.camera };
      const startedAt = now();
      const transitionDuration = Math.max(1, Number(duration) || CAMERA_FOCUS_DURATION);
      const step = (timestamp) => {
        const progress = clamp((timestamp - startedAt) / transitionDuration, 0, 1);
        Object.assign(state.camera, interpolateCamera(start, target, progress));
        updateCamera();
        if (progress < 1) state.cameraFocusFrame = requestAnimationFrame?.(step);
        else state.cameraFocusFrame = null;
      };
      state.cameraFocusFrame = requestAnimationFrame?.(step) ?? null;
    }

    function focusSelectedNodeAtRowScale(node = state.selectedNode, { crossRow = false } = {}) {
      if (!node) return;
      stopSmoothKeyboardPan();
      stopSmoothKeyboardZoom();
      const row = state.rows.find((candidate) => candidate.nodes.includes(node));
      const rowHeight = row ? row.bottom - row.top : node.mediaHeight;
      const scale = clamp(
        getRowFocusScale(getBaseScale(), rowHeight, { emphasis: focusRowEmphasis }),
        getBaseScale() * minZoom,
        getBaseScale() * maxZoom,
      );
      const displayHeight = node.mediaHeight + (node.isVideo ? videoControlsHeight : 0);
      const target = centerCameraAtPoint(
        { ...state.camera, scale },
        { x: node.x + node.width / 2, y: node.y + displayHeight / 2 },
        { width: elements.viewport.clientWidth, height: elements.viewport.clientHeight },
      );
      animateCameraTo(target, {
        duration: crossRow
          ? getCrossRowFocusDuration(state.camera, target)
          : CAMERA_FOCUS_DURATION,
      });
    }

    function fitSelectedRowInViewport() {
      const selectedNode = state.selectedNode;
      if (!selectedNode) return;
      const row = state.rows.find((candidate) => candidate.nodes.includes(selectedNode));
      if (!row?.nodes.length) return;

      const bounds = row.nodes.reduce(
        (result, node) => {
          const displayHeight = node.mediaHeight + (node.isVideo ? videoControlsHeight : 0);
          return {
            left: Math.min(result.left, node.x),
            top: Math.min(result.top, node.y),
            right: Math.max(result.right, node.x + node.width),
            bottom: Math.max(result.bottom, node.y + displayHeight),
          };
        },
        { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
      );
      const width = bounds.right - bounds.left;
      const height = bounds.bottom - bounds.top;
      if (!(width > 0 && height > 0)) return;

      stopSmoothKeyboardPan();
      stopSmoothKeyboardZoom();
      const viewportWidth = elements.viewport.clientWidth;
      const viewportHeight = elements.viewport.clientHeight;
      const availableWidth = Math.max(viewportWidth - cameraFitPadding * 2, 1);
      const availableHeight = Math.max(viewportHeight - cameraFitPadding * 2, 1);
      const scale = clamp(
        Math.min(availableWidth / width, availableHeight / height),
        getBaseScale() * minZoom,
        getBaseScale() * maxZoom,
      );
      const target = centerCameraAtPoint(
        { ...state.camera, scale },
        {
          x: (bounds.left + bounds.right) / 2,
          y: (bounds.top + bounds.bottom) / 2,
        },
        { width: viewportWidth, height: viewportHeight },
      );
      animateCameraTo(target);
    }

    function panBy(dx, dy) {
      state.camera.x += dx;
      state.camera.y += dy;
      updateCamera();
    }

    function getKeyboardPanStep() {
      return Math.round(Number(state.smoothPanSpeed || DEFAULT_SMOOTH_PAN_SPEED) / 2);
    }

    function panOneViewport(key) {
      const delta = getViewportPanDelta(
        key,
        { width: elements.viewport.clientWidth, height: elements.viewport.clientHeight },
        viewportPanFraction,
      );
      if (delta) panBy(delta.x, delta.y);
    }

    function zoomAtPoint(pointerX, pointerY, factor) {
      cancelCameraFocus();
      state.camera = zoomCameraAtPoint(
        state.camera,
        { x: pointerX, y: pointerY },
        factor,
        getBaseScale(),
        minZoom,
        maxZoom,
      );
      updateCamera();
    }

    function startSmoothKeyboardPan(key) {
      state.smoothPanKeys.add(key);
      if (state.smoothPanFrame !== null) return;

      state.smoothPanLastTimestamp = now();
      const step = (timestamp) => {
        if (!state.smoothPanEnabled || !state.smoothPanKeys.size) {
          stopSmoothKeyboardPan();
          return;
        }

        const elapsed = Math.min(Math.max(timestamp - state.smoothPanLastTimestamp, 0), 50) / 1000;
        state.smoothPanLastTimestamp = timestamp;
        let x = 0;
        let y = 0;
        for (const pressedKey of state.smoothPanKeys) {
          const direction = directionFor(pressedKey);
          if (!direction) continue;
          x += direction[0];
          y += direction[1];
        }
        const length = Math.hypot(x, y);
        if (length) {
          const speed = Number(state.smoothPanSpeed || DEFAULT_SMOOTH_PAN_SPEED);
          panBy((-x / length) * speed * elapsed, (-y / length) * speed * elapsed);
        }
        state.smoothPanFrame = requestAnimationFrame?.(step) ?? null;
      };
      state.smoothPanFrame = requestAnimationFrame?.(step) ?? null;
    }

    function stopSmoothKeyboardPan() {
      state.smoothPanKeys.clear();
      if (state.smoothPanFrame !== null) cancelAnimationFrame?.(state.smoothPanFrame);
      state.smoothPanFrame = null;
      state.smoothPanLastTimestamp = null;
    }

    function startSmoothKeyboardZoom(key) {
      state.smoothZoomKeys.add(key.toLowerCase());
      if (state.smoothZoomFrame !== null) return;

      state.smoothZoomLastTimestamp = now();
      const step = (timestamp) => {
        if (!state.smoothZoomEnabled || !state.smoothZoomKeys.size) {
          stopSmoothKeyboardZoom();
          return;
        }

        const elapsed = Math.min(Math.max(timestamp - state.smoothZoomLastTimestamp, 0), 50) / 1000;
        state.smoothZoomLastTimestamp = timestamp;
        let direction = 0;
        for (const pressedKey of state.smoothZoomKeys) {
          direction += pressedKey === "pageup" ? 1 : -1;
        }
        if (direction) {
          const speed = Number(state.smoothZoomSpeed || DEFAULT_SMOOTH_ZOOM_SPEED);
          const factor = Math.pow(speed, direction * elapsed);
          zoomAtPoint(
            elements.viewport.clientWidth / 2,
            elements.viewport.clientHeight / 2,
            factor,
          );
        }
        state.smoothZoomFrame = requestAnimationFrame?.(step) ?? null;
      };
      state.smoothZoomFrame = requestAnimationFrame?.(step) ?? null;
    }

    function stopSmoothKeyboardZoom() {
      state.smoothZoomKeys.clear();
      if (state.smoothZoomFrame !== null) cancelAnimationFrame?.(state.smoothZoomFrame);
      state.smoothZoomFrame = null;
      state.smoothZoomLastTimestamp = null;
    }

    function handleKeyUp(key) {
      const normalizedKey = String(key || "").toLowerCase();
      if (state.smoothPanKeys.has(normalizedKey)) {
        state.smoothPanKeys.delete(normalizedKey);
        if (!state.smoothPanKeys.size) {
          stopSmoothKeyboardPan();
          if (state.smoothPanEnabled) selectNodeAtViewportCenter?.();
        }
      }
      if (state.smoothZoomKeys.has(normalizedKey)) {
        state.smoothZoomKeys.delete(normalizedKey);
        if (!state.smoothZoomKeys.size) stopSmoothKeyboardZoom();
      }
    }

    function handleWindowBlur() {
      stopSmoothKeyboardPan();
      stopSmoothKeyboardZoom();
    }

    return Object.freeze({
      animateCameraTo,
      cancelCameraFocus,
      fitSelectedRowInViewport,
      focusSelectedNodeAtRowScale,
      getKeyboardPanStep,
      handleKeyUp,
      handleWindowBlur,
      panBy,
      panOneViewport,
      startSmoothKeyboardPan,
      startSmoothKeyboardZoom,
      stopSmoothKeyboardPan,
      stopSmoothKeyboardZoom,
      zoomAtPoint,
    });
  }

  return Object.freeze({ createCameraNavigation });
});

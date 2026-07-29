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
    TARGET_ROW_HEIGHT,
    zoomCameraAtPoint,
  } = core;

  const CAMERA_FOCUS_DURATION = 180;
  const MIN_ZOOM = 0.08;
  const MAX_ZOOM = 8;
  const VIEWPORT_PAN_FRACTION = 2 / 3;
  const CAMERA_FIT_PADDING = 64;
  const DEFAULT_FOCUS_ROW_EMPHASIS = 0.9;
  const DEFAULT_VIDEO_CONTROLS_HEIGHT = 8;
  const DEFAULT_SMOOTH_PAN_SPEED = 480;
  const DEFAULT_SMOOTH_ZOOM_SPEED = 1.5;
  const DEFAULT_SMOOTH_ZOOM_ACCELERATION = 16;
  const SMOOTH_ZOOM_DECELERATION = 14;
  const SMOOTH_ZOOM_VELOCITY_EPSILON = 0.001;

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
      getFocusRowEmphasis = () => DEFAULT_FOCUS_ROW_EMPHASIS,
      getFocusTargetHeight = () => TARGET_ROW_HEIGHT,
      getVideoControlsHeight = () => DEFAULT_VIDEO_CONTROLS_HEIGHT,
      onFocusStart = () => {},
      onFocusEnd = () => {},
      onSmoothZoomStart = () => {},
      onSmoothZoomEnd = () => {},
    } = options;
    const getRows = options.getRows || (() => state.rows);

    if (!state || !elements?.viewport || !getBaseScale || !updateCamera) {
      throw new Error("Camera navigation requires state, viewport, scale, and camera callbacks");
    }

    let focusActive = false;
    let smoothZoomActive = false;

    function beginSmoothZoom() {
      if (smoothZoomActive) return;
      smoothZoomActive = true;
      onSmoothZoomStart();
    }

    function finishSmoothZoom() {
      if (!smoothZoomActive) return;
      smoothZoomActive = false;
      onSmoothZoomEnd();
    }

    function finishCameraFocus() {
      if (!focusActive) return;
      focusActive = false;
      onFocusEnd();
    }

    function cancelCameraFocus() {
      if (state.cameraFocusFrame === null) return;
      cancelAnimationFrame?.(state.cameraFocusFrame);
      state.cameraFocusFrame = null;
      finishCameraFocus();
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
      focusActive = true;
      onFocusStart();
      const step = (timestamp) => {
        const progress = clamp((timestamp - startedAt) / transitionDuration, 0, 1);
        Object.assign(state.camera, interpolateCamera(start, target, progress));
        updateCamera();
        if (progress < 1) state.cameraFocusFrame = requestAnimationFrame?.(step);
        else {
          state.cameraFocusFrame = null;
          finishCameraFocus();
        }
      };
      state.cameraFocusFrame = requestAnimationFrame?.(step) ?? null;
      if (state.cameraFocusFrame === null) finishCameraFocus();
    }

    function focusSelectedNodeAtRowScale(node = state.selectedNode, { crossRow = false } = {}) {
      if (!node) return;
      stopSmoothKeyboardPan();
      stopSmoothKeyboardZoom();
      const row = getRows().find((candidate) => candidate.nodes.includes(node));
      const rowHeight = row ? row.bottom - row.top : node.mediaHeight;
      const scale = clamp(
        getRowFocusScale(getBaseScale(), rowHeight, {
          targetHeight: getFocusTargetHeight(),
          emphasis: getFocusRowEmphasis(),
        }),
        getBaseScale() * MIN_ZOOM,
        getBaseScale() * MAX_ZOOM,
      );
      const displayHeight =
        node.mediaHeight + (node.isVideo ? getVideoControlsHeight() : 0);
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
      const row = getRows().find((candidate) => candidate.nodes.includes(selectedNode));
      if (!row?.nodes.length) return;

      const bounds = row.nodes.reduce(
        (result, node) => {
          const displayHeight =
            node.mediaHeight + (node.isVideo ? getVideoControlsHeight() : 0);
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
      const availableWidth = Math.max(viewportWidth - CAMERA_FIT_PADDING * 2, 1);
      const availableHeight = Math.max(viewportHeight - CAMERA_FIT_PADDING * 2, 1);
      const scale = clamp(
        Math.min(availableWidth / width, availableHeight / height),
        getBaseScale() * MIN_ZOOM,
        getBaseScale() * MAX_ZOOM,
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
        VIEWPORT_PAN_FRACTION,
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
        MIN_ZOOM,
        MAX_ZOOM,
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

      beginSmoothZoom();
      state.smoothZoomLastTimestamp = now();
      const step = (timestamp) => {
        if (!state.smoothZoomEnabled || !state.smoothZoomKeys.size) {
          if (!state.smoothZoomEnabled) {
            stopSmoothKeyboardZoom();
            return;
          }
        }

        const elapsed = Math.min(Math.max(timestamp - state.smoothZoomLastTimestamp, 0), 50) / 1000;
        state.smoothZoomLastTimestamp = timestamp;
        let direction = 0;
        for (const pressedKey of state.smoothZoomKeys) {
          direction += pressedKey === "pageup" ? 1 : -1;
        }

        const speed = Math.max(
          1.000001,
          Number(state.smoothZoomSpeed || DEFAULT_SMOOTH_ZOOM_SPEED),
        );
        const targetVelocity = direction * Math.log(speed);
        const acceleration = Math.max(
          1,
          Number(state.smoothZoomAcceleration || DEFAULT_SMOOTH_ZOOM_ACCELERATION),
        );
        const responseRate = direction ? acceleration : SMOOTH_ZOOM_DECELERATION;
        const response = 1 - Math.exp(-responseRate * elapsed);
        const currentVelocity = Number(state.smoothZoomVelocity) || 0;
        state.smoothZoomVelocity =
          currentVelocity + (targetVelocity - currentVelocity) * response;

        if (Math.abs(state.smoothZoomVelocity) <= SMOOTH_ZOOM_VELOCITY_EPSILON) {
          state.smoothZoomVelocity = 0;
        } else {
          const factor = Math.exp(state.smoothZoomVelocity * elapsed);
          zoomAtPoint(
            elements.viewport.clientWidth / 2,
            elements.viewport.clientHeight / 2,
            factor,
          );
        }

        if (state.smoothZoomKeys.size || state.smoothZoomVelocity !== 0) {
          state.smoothZoomFrame = requestAnimationFrame?.(step) ?? null;
        } else {
          state.smoothZoomFrame = null;
          state.smoothZoomLastTimestamp = null;
          finishSmoothZoom();
        }
      };
      state.smoothZoomFrame = requestAnimationFrame?.(step) ?? null;
    }

    function stopSmoothKeyboardZoom() {
      state.smoothZoomKeys.clear();
      if (state.smoothZoomFrame !== null) cancelAnimationFrame?.(state.smoothZoomFrame);
      state.smoothZoomFrame = null;
      state.smoothZoomLastTimestamp = null;
      state.smoothZoomVelocity = 0;
      finishSmoothZoom();
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

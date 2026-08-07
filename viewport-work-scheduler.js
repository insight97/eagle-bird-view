"use strict";

(function exposeViewportWorkScheduler(root, factory) {
  const core =
    root.BirdViewCore ||
    (typeof module === "object" && typeof require === "function"
      ? require("./bird-view-core.js")
      : null);
  const scheduler = factory(core, root);
  if (typeof module === "object" && module.exports) module.exports = scheduler;
  root.BirdViewViewportWork = scheduler;
})(typeof globalThis === "object" ? globalThis : this, (core, root) => {
  const { getViewportWorkInterval } = core;

  const SMOOTH_ZOOM_QUALITY_INTERVAL = 120;

  // Decides when viewport maintenance runs, and which parts of it.
  //
  // The camera has three modes and they do not want the same work. Dragging
  // needs media coverage to keep up — suspending it for the whole gesture means
  // the pan arrives somewhere with nothing loaded and only then starts fetching
  // — but it does not need labels, centre selection or auto-exploring, which are
  // main-thread work with nothing the user can see riding on them. Zooming needs
  // only the quality decision, at a faster cadence, because scale is what
  // changes. Everything else waits for the camera to settle.
  function createViewportWorkScheduler(options = {}) {
    const {
      window: windowRef = root.window || root,
      now = () => (root.performance || Date).now(),
      smoothZoomQualityInterval = SMOOTH_ZOOM_QUALITY_INTERVAL,
      isPanning = () => false,
      isSmoothZooming = () => false,
      isCameraFocusing = () => false,
      onPanMedia = () => {},
      onZoomQuality = () => {},
      onSettled = () => {},
    } = options;

    let settledTimer = null;
    let panTimer = null;
    let zoomTimer = null;
    let lastSettledWork = -Infinity;
    let lastZoomQualityWork = -Infinity;

    function schedule() {
      if (isPanning()) {
        schedulePan();
        return;
      }
      if (isSmoothZooming()) {
        scheduleZoomQuality();
        return;
      }
      scheduleSettled();
    }

    function scheduleSettled() {
      if (settledTimer !== null) return;
      settledTimer = windowRef.setTimeout(
        runSettled,
        remainingDelay(lastSettledWork, getViewportWorkInterval(false)),
      );
    }

    function runSettled() {
      settledTimer = null;
      if (isPanning() || isSmoothZooming() || isCameraFocusing()) return;
      lastSettledWork = now();
      onSettled();
    }

    function schedulePan() {
      if (!isPanning() || panTimer !== null) return;
      panTimer = windowRef.setTimeout(
        runPan,
        // Panning shares the settled clock: both are coverage passes, so one
        // should not fire immediately after the other.
        remainingDelay(lastSettledWork, getViewportWorkInterval(true)),
      );
    }

    function runPan() {
      panTimer = null;
      if (!isPanning()) return;
      lastSettledWork = now();
      onPanMedia();
      schedulePan();
    }

    function scheduleZoomQuality() {
      if (!isSmoothZooming() || isPanning() || zoomTimer !== null) return;
      zoomTimer = windowRef.setTimeout(
        runZoomQuality,
        remainingDelay(lastZoomQualityWork, smoothZoomQualityInterval),
      );
    }

    function runZoomQuality() {
      zoomTimer = null;
      if (!isSmoothZooming() || isPanning()) return;
      lastZoomQualityWork = now();
      onZoomQuality();
      scheduleZoomQuality();
    }

    function remainingDelay(last, interval) {
      return Math.max(0, interval - (now() - last));
    }

    function clearTimer(timer) {
      if (timer !== null) windowRef.clearTimeout(timer);
      return null;
    }

    // Drops any pending pass and schedules whichever one the current mode wants.
    function reschedule() {
      settledTimer = clearTimer(settledTimer);
      panTimer = clearTimer(panTimer);
      schedule();
    }

    // Runs the full settled pass now, whatever was pending. Callers use this the
    // moment a gesture ends, so the board catches up without waiting a tick.
    function flush() {
      settledTimer = clearTimer(settledTimer);
      panTimer = clearTimer(panTimer);
      runSettled();
    }

    // Enters smooth zoom: nothing that was queued for another mode should fire,
    // and the first quality pass should not wait out a stale throttle.
    function restartZoomQuality() {
      settledTimer = clearTimer(settledTimer);
      panTimer = clearTimer(panTimer);
      zoomTimer = clearTimer(zoomTimer);
      lastZoomQualityWork = -Infinity;
      scheduleZoomQuality();
    }

    function stopZoomQuality() {
      zoomTimer = clearTimer(zoomTimer);
      lastZoomQualityWork = -Infinity;
    }

    return Object.freeze({
      flush,
      reschedule,
      restartZoomQuality,
      schedule,
      stopZoomQuality,
    });
  }

  return Object.freeze({ SMOOTH_ZOOM_QUALITY_INTERVAL, createViewportWorkScheduler });
});

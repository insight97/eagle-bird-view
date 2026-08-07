"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createViewportWorkScheduler } = require("../viewport-work-scheduler.js");

function createHarness({ panning = false, smoothZooming = false, focusing = false } = {}) {
  const timers = new Map();
  const ran = [];
  let nextId = 0;
  let clock = 0;
  const mode = { panning, smoothZooming, focusing };

  const scheduler = createViewportWorkScheduler({
    window: {
      setTimeout(callback, delay) {
        nextId += 1;
        timers.set(nextId, { callback, delay });
        return nextId;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
    now: () => clock,
    isPanning: () => mode.panning,
    isSmoothZooming: () => mode.smoothZooming,
    isCameraFocusing: () => mode.focusing,
    onPanMedia: () => ran.push("pan-media"),
    onZoomQuality: () => ran.push("zoom-quality"),
    onSettled: () => ran.push("settled"),
  });

  return {
    mode,
    ran,
    scheduler,
    get pending() {
      return [...timers.values()].map(({ delay }) => delay);
    },
    advance(ms) {
      clock += ms;
    },
    fire() {
      const [id] = timers.keys();
      if (id === undefined) throw new Error("nothing scheduled");
      const { callback } = timers.get(id);
      timers.delete(id);
      callback();
    },
  };
}

test("a settled camera runs the full maintenance pass", () => {
  const harness = createHarness();

  harness.scheduler.schedule();
  harness.fire();

  assert.deepEqual(harness.ran, ["settled"]);
});

test("the settled pass does not repeat itself", () => {
  const harness = createHarness();

  harness.scheduler.schedule();
  harness.fire();

  assert.deepEqual(harness.pending, [], "settled work is one-shot");
});

// Suspending coverage for a whole drag means the pan arrives somewhere with
// nothing loaded and only then starts fetching.
test("dragging keeps running media coverage, and only that", () => {
  const harness = createHarness({ panning: true });

  harness.scheduler.schedule();
  harness.advance(250);
  harness.fire();
  harness.advance(250);
  harness.fire();
  harness.advance(250);
  harness.fire();

  assert.deepEqual(harness.ran, ["pan-media", "pan-media", "pan-media"]);
});

test("media coverage stops repeating once the drag ends", () => {
  const harness = createHarness({ panning: true });

  harness.scheduler.schedule();
  harness.advance(250);
  harness.fire();
  assert.deepEqual(harness.ran, ["pan-media"]);

  harness.mode.panning = false;
  harness.fire();

  assert.deepEqual(harness.ran, ["pan-media"], "the queued pass should bail");
  assert.deepEqual(harness.pending, []);
});

test("panning and settled passes share one throttle clock", () => {
  const harness = createHarness({ panning: true });

  harness.scheduler.schedule();
  harness.advance(250);
  harness.fire();

  // A coverage pass just ran, so the next one waits the full interval rather
  // than firing immediately.
  assert.deepEqual(harness.pending, [250]);
});

test("smooth zoom runs quality passes at its own faster cadence", () => {
  const harness = createHarness({ smoothZooming: true });

  harness.scheduler.schedule();
  assert.deepEqual(harness.pending, [0], "the first quality pass should not wait");
  harness.fire();
  assert.deepEqual(harness.pending, [120]);

  harness.advance(120);
  harness.fire();

  assert.deepEqual(harness.ran, ["zoom-quality", "zoom-quality"]);
});

test("panning wins over smooth zoom", () => {
  const harness = createHarness({ panning: true, smoothZooming: true });

  harness.scheduler.schedule();
  harness.advance(250);
  harness.fire();

  assert.deepEqual(harness.ran, ["pan-media"]);
});

test("restarting zoom quality drops other pending work and runs immediately", () => {
  const harness = createHarness();
  harness.scheduler.schedule();
  assert.equal(harness.pending.length, 1, "a settled pass should be queued");

  harness.mode.smoothZooming = true;
  harness.scheduler.restartZoomQuality();

  assert.deepEqual(harness.pending, [0]);
  harness.fire();
  assert.deepEqual(harness.ran, ["zoom-quality"]);
});

test("stopping zoom quality cancels it and resets its throttle", () => {
  const harness = createHarness({ smoothZooming: true });
  harness.scheduler.restartZoomQuality();
  harness.fire();
  harness.advance(10);

  harness.scheduler.stopZoomQuality();
  assert.deepEqual(harness.pending, []);

  // The reset matters: re-entering zoom must not wait out the old throttle.
  harness.scheduler.restartZoomQuality();
  assert.deepEqual(harness.pending, [0]);
});

test("flushing runs the settled pass now and clears what was pending", () => {
  const harness = createHarness({ panning: true });
  harness.scheduler.schedule();

  harness.mode.panning = false;
  harness.scheduler.flush();

  assert.deepEqual(harness.ran, ["settled"]);
  assert.deepEqual(harness.pending, []);
});

test("flushing mid-gesture does nothing, so a gesture cannot be undercut", () => {
  const harness = createHarness({ panning: true });

  harness.scheduler.flush();

  assert.deepEqual(harness.ran, []);
});

test("a focusing camera defers its settled pass", () => {
  const harness = createHarness({ focusing: true });

  harness.scheduler.schedule();
  harness.fire();

  assert.deepEqual(harness.ran, []);
});

test("rescheduling replaces pending work with what the current mode wants", () => {
  const harness = createHarness();
  harness.scheduler.schedule();

  harness.mode.panning = true;
  harness.scheduler.reschedule();
  harness.advance(250);
  harness.fire();

  assert.deepEqual(harness.ran, ["pan-media"]);
  assert.deepEqual(harness.pending, [250], "and it keeps repeating");
});

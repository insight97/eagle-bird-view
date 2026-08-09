"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MediaLoadQueue, waitForImageDecode } = require("../media-load-queue.js");

function register(queue, starts, options = {}) {
  const node = {};
  queue.register(node, {
    hasOriginal: true,
    hasThumbnail: true,
    preferThumbnailFirst: true,
    ...options,
    start: (quality) => starts.push({ node, quality }),
  });
  return node;
}

test("an original request loads the thumbnail first", () => {
  const starts = [];
  const queue = new MediaLoadQueue();
  const node = register(queue, starts);

  queue.request(node, "original");
  assert.deepEqual(starts.map(({ quality }) => quality), ["thumbnail"]);
  assert.equal(queue.snapshot(node).pendingQuality, "original");

  queue.complete(node, "thumbnail", true);
  assert.deepEqual(starts.map(({ quality }) => quality), ["thumbnail", "original"]);
  queue.complete(node, "original", true);
  assert.equal(queue.snapshot(node).readyQuality, "original");
});

test("no more than four loads run concurrently", () => {
  const starts = [];
  const queue = new MediaLoadQueue({ maxConcurrent: 4 });
  const nodes = Array.from({ length: 5 }, () =>
    register(queue, starts, { hasOriginal: false, preferThumbnailFirst: false }),
  );

  for (const node of nodes) queue.request(node, "thumbnail");
  assert.equal(starts.length, 4);
  assert.equal(queue.activeCount, 4);

  queue.complete(nodes[0], "thumbnail", true);
  assert.equal(starts.length, 5);
  assert.equal(queue.activeCount, 4);
});

test("the default queue runs only one background original at a time", () => {
  const starts = [];
  const queue = new MediaLoadQueue({ maxConcurrent: 4 });
  const nodes = Array.from({ length: 3 }, () =>
    register(queue, starts, { hasThumbnail: false, preferThumbnailFirst: false }),
  );

  for (const node of nodes) queue.request(node, "original");

  assert.deepEqual(starts.map(({ node }) => node), nodes.slice(0, 1));
  assert.equal(queue.activeCount, 1);
});

test("background originals use only two of the four load slots", () => {
  const starts = [];
  const queue = new MediaLoadQueue({ maxConcurrent: 4, maxBackgroundOriginals: 2 });
  const nodes = Array.from({ length: 4 }, () =>
    register(queue, starts, { hasThumbnail: false, preferThumbnailFirst: false }),
  );

  for (const node of nodes) queue.request(node, "original");

  assert.deepEqual(starts.map(({ node }) => node), nodes.slice(0, 2));
  assert.equal(queue.activeCount, 2);

  queue.complete(nodes[0], "original", true);
  assert.deepEqual(starts.map(({ node }) => node), nodes.slice(0, 3));
  assert.equal(queue.activeCount, 2);
});

test("queued background originals do not reserve the remaining slots from thumbnails", () => {
  const starts = [];
  const queue = new MediaLoadQueue({ maxConcurrent: 4, maxBackgroundOriginals: 2 });
  const originals = Array.from({ length: 3 }, () =>
    register(queue, starts, { hasThumbnail: false, preferThumbnailFirst: false }),
  );
  const thumbnails = Array.from({ length: 2 }, () =>
    register(queue, starts, { hasOriginal: false, preferThumbnailFirst: false }),
  );

  for (const node of originals) queue.request(node, "original");
  for (const node of thumbnails) queue.request(node, "thumbnail");

  assert.deepEqual(starts.slice(2).map(({ node }) => node), thumbnails);
  assert.equal(queue.activeCount, 4);
  assert.equal(queue.snapshot(originals[2]).queuedQuality, "original");
});

test("a priority original can use a slot reserved from background decoding", () => {
  const starts = [];
  const queue = new MediaLoadQueue({ maxConcurrent: 4, maxBackgroundOriginals: 2 });
  const backgrounds = Array.from({ length: 4 }, () =>
    register(queue, starts, { hasThumbnail: false, preferThumbnailFirst: false }),
  );
  const priority = register(queue, starts, {
    hasThumbnail: false,
    preferThumbnailFirst: false,
  });

  for (const node of backgrounds) queue.request(node, "original");
  queue.request(priority, "original", { priority: "high" });

  assert.equal(starts.at(-1).node, priority);
  assert.equal(queue.activeCount, 3);
});

test("promoting a queued background original starts it through a reserved slot", () => {
  const starts = [];
  const queue = new MediaLoadQueue({ maxConcurrent: 4, maxBackgroundOriginals: 2 });
  const backgrounds = Array.from({ length: 3 }, () =>
    register(queue, starts, { hasThumbnail: false, preferThumbnailFirst: false }),
  );

  for (const node of backgrounds) queue.request(node, "original");
  assert.equal(queue.snapshot(backgrounds[2]).queuedPriority, "normal");

  queue.request(backgrounds[2], "original", { priority: "high" });

  assert.equal(starts.at(-1).node, backgrounds[2]);
  assert.equal(queue.snapshot(backgrounds[2]).loadingPriority, "high");
  assert.equal(queue.activeCount, 3);
});

test("priority survives the thumbnail-first handoff to the original", () => {
  const starts = [];
  const queue = new MediaLoadQueue({ maxConcurrent: 4, maxBackgroundOriginals: 2 });
  const backgrounds = Array.from({ length: 2 }, () =>
    register(queue, starts, { hasThumbnail: false, preferThumbnailFirst: false }),
  );
  const priority = register(queue, starts);

  for (const node of backgrounds) queue.request(node, "original");
  queue.request(priority, "original", { priority: "high" });
  assert.equal(starts.at(-1).quality, "thumbnail");

  queue.complete(priority, "thumbnail", true);

  assert.equal(starts.at(-1).node, priority);
  assert.equal(starts.at(-1).quality, "original");
  assert.equal(queue.snapshot(priority).loadingPriority, "high");
});

test("a queued priority original starts before background work when a slot opens", () => {
  const starts = [];
  const queue = new MediaLoadQueue({ maxConcurrent: 4, maxBackgroundOriginals: 2 });
  const thumbnails = Array.from({ length: 4 }, () =>
    register(queue, starts, { hasOriginal: false, preferThumbnailFirst: false }),
  );
  const background = register(queue, starts, {
    hasThumbnail: false,
    preferThumbnailFirst: false,
  });
  const priority = register(queue, starts, {
    hasThumbnail: false,
    preferThumbnailFirst: false,
  });

  for (const node of thumbnails) queue.request(node, "thumbnail");
  queue.request(background, "original");
  queue.request(priority, "original", { priority: "high" });
  queue.complete(thumbnails[0], "thumbnail", true);

  assert.equal(starts.at(-1).node, priority);
  assert.equal(queue.snapshot(background).queuedQuality, "original");
});

test("the slot remains active until the adapter reports decoded completion", () => {
  const starts = [];
  const queue = new MediaLoadQueue({ maxConcurrent: 1 });
  const first = register(queue, starts, { hasThumbnail: false, preferThumbnailFirst: false });
  const second = register(queue, starts, { hasOriginal: false, preferThumbnailFirst: false });

  queue.request(first, "original");
  queue.request(second, "thumbnail");
  assert.equal(starts.length, 1);

  queue.complete(first, "original", true);
  assert.equal(starts.length, 2);
});

test("an original failure preserves the thumbnail until manually retried", () => {
  const starts = [];
  const queue = new MediaLoadQueue();
  const node = register(queue, starts);

  queue.request(node, "thumbnail");
  queue.complete(node, "thumbnail", true);
  queue.request(node, "original");
  queue.complete(node, "original", false);
  queue.request(node, "original");

  assert.deepEqual(starts.map(({ quality }) => quality), ["thumbnail", "original"]);
  assert.equal(queue.snapshot(node).readyQuality, "thumbnail");
  assert.equal(queue.snapshot(node).originalFailed, true);

  queue.retry(node, "original");
  assert.deepEqual(starts.map(({ quality }) => quality), ["thumbnail", "original", "original"]);
  assert.equal(queue.snapshot(node).originalFailed, false);
});

test("failing a queued original releases it without blocking the thumbnail", () => {
  const starts = [];
  const queue = new MediaLoadQueue();
  const node = register(queue, starts);

  queue.request(node, "original");
  assert.equal(queue.fail(node, "original"), true);
  queue.complete(node, "thumbnail", true);

  assert.deepEqual(starts.map(({ quality }) => quality), ["thumbnail"]);
  assert.equal(queue.snapshot(node).pendingQuality, null);
  assert.equal(queue.snapshot(node).originalFailed, true);
});

test("disposing an active node frees its slot and ignores stale completion", () => {
  const starts = [];
  const canceled = [];
  const queue = new MediaLoadQueue({ maxConcurrent: 1 });
  const first = register(queue, starts, {
    hasOriginal: false,
    preferThumbnailFirst: false,
    cancel: (quality) => canceled.push(quality),
  });
  const second = register(queue, starts, { hasOriginal: false, preferThumbnailFirst: false });

  queue.request(first, "thumbnail");
  queue.request(second, "thumbnail");
  queue.dispose(first);

  assert.equal(queue.activeCount, 1);
  assert.deepEqual(canceled, ["thumbnail"]);
  assert.equal(starts[1].node, second);
  assert.equal(queue.complete(first, "thumbnail", true), false);
});

test("canceling a pending original keeps the thumbnail without starting the follow-up", () => {
  const starts = [];
  const queue = new MediaLoadQueue({ maxConcurrent: 1 });
  const node = register(queue, starts);

  queue.request(node, "original");
  assert.equal(queue.cancel(node, "original"), true);
  queue.complete(node, "thumbnail", true);

  assert.deepEqual(starts.map(({ quality }) => quality), ["thumbnail"]);
  assert.equal(queue.snapshot(node).readyQuality, "thumbnail");
});

test("canceling an active original frees its slot and allows a later retry", () => {
  const starts = [];
  const canceled = [];
  const queue = new MediaLoadQueue({ maxConcurrent: 1 });
  const original = register(queue, starts, {
    hasThumbnail: false,
    preferThumbnailFirst: false,
    cancel: (quality) => canceled.push(quality),
  });
  const thumbnail = register(queue, starts, {
    hasOriginal: false,
    preferThumbnailFirst: false,
  });

  queue.request(original, "original");
  queue.request(thumbnail, "thumbnail");
  assert.equal(queue.cancel(original, "original"), true);

  assert.deepEqual(canceled, ["original"]);
  assert.equal(starts[1].node, thumbnail);
  assert.equal(queue.snapshot(original).originalFailed, false);
  assert.equal(queue.complete(original, "original", true), false);

  queue.complete(thumbnail, "thumbnail", true);
  queue.request(original, "original");
  assert.equal(starts.at(-1).node, original);
  assert.equal(starts.at(-1).quality, "original");
});

test("image decoding stops waiting when the timeout wins", async () => {
  const cleared = [];
  const timers = {
    setTimeout(callback) {
      callback();
      return 7;
    },
    clearTimeout(id) {
      cleared.push(id);
    },
  };
  const image = { decode: () => new Promise(() => {}) };

  await waitForImageDecode(image, 1500, timers);
  assert.deepEqual(cleared, [7]);
});

test("image decoding clears its timeout after decoding succeeds", async () => {
  const cleared = [];
  const timers = {
    setTimeout() {
      return 11;
    },
    clearTimeout(id) {
      cleared.push(id);
    },
  };

  await waitForImageDecode({ decode: () => Promise.resolve() }, 1500, timers);
  assert.deepEqual(cleared, [11]);
});

test("invalidating a ready original lets it be requested again", () => {
  const starts = [];
  const queue = new MediaLoadQueue();
  const node = register(queue, starts);

  queue.request(node, "original");
  queue.complete(node, "thumbnail", true);
  queue.complete(node, "original", true);
  starts.length = 0;

  // A second request is a no-op while the original is still considered ready.
  assert.equal(queue.request(node, "original"), false);
  assert.deepEqual(starts, []);

  assert.equal(queue.invalidate(node, "original"), true);
  // The card falls back to the thumbnail it still has, so it never blanks.
  assert.equal(queue.snapshot(node).readyQuality, "thumbnail");

  assert.equal(queue.request(node, "original"), true);
  assert.deepEqual(starts.map(({ quality }) => quality), ["original"]);
});

test("invalidating drops to nothing when there is no thumbnail to fall back on", () => {
  const starts = [];
  const queue = new MediaLoadQueue();
  const node = register(queue, starts, { hasThumbnail: false, preferThumbnailFirst: false });

  queue.request(node, "original");
  queue.complete(node, "original", true);

  assert.equal(queue.invalidate(node, "original"), true);
  assert.equal(queue.snapshot(node).readyQuality, null);
});

test("invalidating a quality that is not ready changes nothing", () => {
  const starts = [];
  const queue = new MediaLoadQueue();
  const node = register(queue, starts);

  assert.equal(queue.invalidate(node, "original"), false);

  queue.request(node, "original");
  queue.complete(node, "thumbnail", true);
  // The original is loading, not ready, so it must not be dropped underneath.
  assert.equal(queue.invalidate(node, "original"), false);
  assert.equal(queue.snapshot(node).readyQuality, "thumbnail");

  assert.equal(queue.invalidate({}, "original"), false);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MediaLoadQueue } = require("../media-load-queue.js");

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

test("an original failure preserves the ready thumbnail and is not retried", () => {
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
});

test("disposing an active node frees its slot and ignores stale completion", () => {
  const starts = [];
  const queue = new MediaLoadQueue({ maxConcurrent: 1 });
  const first = register(queue, starts, { hasOriginal: false, preferThumbnailFirst: false });
  const second = register(queue, starts, { hasOriginal: false, preferThumbnailFirst: false });

  queue.request(first, "thumbnail");
  queue.request(second, "thumbnail");
  queue.dispose(first);

  assert.equal(queue.activeCount, 1);
  assert.equal(starts[1].node, second);
  assert.equal(queue.complete(first, "thumbnail", true), false);
});

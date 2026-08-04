"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createFolderContentIntake } = require("../folder-content-intake.js");
const { createRowLoadCoordinator } = require("../row-load-coordinator.js");

function createHarness(source, options = {}) {
  const batches = [];
  const states = [];
  const intake = createFolderContentIntake({
    source,
    loadCoordinator: createRowLoadCoordinator(),
    initialDisplayMinItems: 3,
    batchSize: 2,
    onBatch(items, metadata) {
      batches.push({ items, metadata });
    },
    onStateChange(snapshot) {
      states.push(snapshot);
    },
    ...options,
  });
  return { batches, intake, states };
}

function summary(id) {
  return { id, name: `${id}.jpg`, ext: "jpg" };
}

function hydrated(item) {
  return { ...item, fileURL: `file:///${item.id}.jpg`, thumbnailURL: `file:///${item.id}-thumb.jpg` };
}

test("folder content intake releases the initial threshold and hydrates batches", async () => {
  const source = {
    async loadFolders(folders, { onItems }) {
      await onItems([summary("a"), summary("b"), summary("c")]);
      await onItems([summary("d")]);
      return { folders, items: [summary("a"), summary("b"), summary("c"), summary("d")] };
    },
    async hydrate(items) {
      return items.map(hydrated);
    },
  };
  const harness = createHarness(source);

  const first = await harness.intake.start({ folders: [{ id: "root" }], includeSubfolders: true });

  assert.deepEqual(harness.batches[0].items.map(({ id }) => id), ["a", "b"]);
  assert.equal(harness.batches[0].metadata.initial, true);
  assert.equal(first.status, "ready");
  assert.equal(first.itemCount, 4);
  assert.equal(first.loadedCount, 2);
  assert.equal(first.remaining, 2);

  const second = await harness.intake.loadMore();

  assert.deepEqual(harness.batches[1].items.map(({ id }) => id), ["c", "d"]);
  assert.equal(second.loadedCount, 4);
  assert.equal(second.remaining, 0);
});

test("a newer folder content session discards late results from the previous session", async () => {
  let releaseFirst;
  const firstDone = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const source = {
    async loadFolders(folders, { onItems }) {
      if (folders[0].id === "first") await firstDone;
      await onItems([summary(folders[0].id)]);
      return { folders, items: [summary(folders[0].id)] };
    },
    async hydrate(items) {
      return items.map(hydrated);
    },
  };
  const harness = createHarness(source, { initialDisplayMinItems: 1, batchSize: 1 });

  const first = harness.intake.start({ folders: [{ id: "first" }] });
  await new Promise((resolve) => setImmediate(resolve));
  const second = harness.intake.start({ folders: [{ id: "second" }] });
  await second;
  releaseFirst();
  await first;

  assert.deepEqual(harness.batches.map(({ items }) => items.map(({ id }) => id)), [["second"]]);
  assert.equal(harness.intake.snapshot().folders[0].id, "second");
});

test("a partial folder query retries the failed work and releases new items", async () => {
  let attempts = 0;
  const source = {
    async loadFolders(folders, { onItems }) {
      attempts += 1;
      await onItems([summary("a"), summary("b"), summary("c")]);
      if (attempts === 1) {
        return {
          folders,
          items: [summary("a"), summary("b"), summary("c")],
          failures: [{ folderId: "child", error: new Error("child unavailable") }],
        };
      }
      await onItems([summary("d")]);
      return { folders, items: [summary("a"), summary("b"), summary("c"), summary("d")] };
    },
    async hydrate(items) {
      return items.map(hydrated);
    },
  };
  const harness = createHarness(source, { initialDisplayMinItems: 3, batchSize: 3 });

  const partial = await harness.intake.start({ folders: [{ id: "root" }] });

  assert.equal(partial.status, "partial");
  assert.equal(partial.failureCount, 1);
  assert.deepEqual(harness.batches[0].items.map(({ id }) => id), ["a", "b", "c"]);

  const recovered = await harness.intake.loadMore();

  assert.equal(attempts, 2);
  assert.equal(recovered.status, "ready");
  assert.deepEqual(harness.batches[1].items.map(({ id }) => id), ["d"]);
});

test("a hydration failure keeps the same batch available for retry", async () => {
  let hydrateAttempts = 0;
  const source = {
    async loadFolders(folders, { onItems }) {
      await onItems([summary("a")]);
      return { folders, items: [summary("a")] };
    },
    async hydrate(items) {
      hydrateAttempts += 1;
      if (hydrateAttempts === 1) throw new Error("hydration unavailable");
      return items.map(hydrated);
    },
  };
  const harness = createHarness(source, { initialDisplayMinItems: 1, batchSize: 1 });

  const failed = await harness.intake.start({ folders: [{ id: "root" }] });

  assert.equal(failed.status, "error");
  assert.equal(failed.loadedCount, 0);

  const recovered = await harness.intake.loadMore();

  assert.equal(recovered.status, "ready");
  assert.deepEqual(harness.batches[0].items.map(({ id }) => id), ["a"]);
  assert.equal(recovered.loadedCount, 1);
});

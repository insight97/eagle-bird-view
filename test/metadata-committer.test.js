"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMetadataCommitter } = require("../metadata-committer.js");

function createNode(id, property, value, save) {
  return {
    item: {
      id,
      [property]: value,
      save,
    },
    isSaving: false,
  };
}

function createHarness(options = {}) {
  const events = [];
  let invalidations = 0;
  const committer = createMetadataCommitter({
    maxConcurrent: options.maxConcurrent || 4,
    onChange: (node, property) => events.push(["change", node.item.id, property]),
    onSavingChange: (node, isSaving) =>
      events.push(["saving", node.item.id, isSaving]),
    invalidateSources: () => {
      invalidations += 1;
    },
    onComplete: (result) => events.push(["complete", result.status]),
  });
  return {
    committer,
    events,
    get invalidations() {
      return invalidations;
    },
  };
}

test("a commit applies optimistically and owns the saving lifecycle", async () => {
  let releaseSave;
  const savePending = new Promise((resolve) => {
    releaseSave = resolve;
  });
  const node = createNode("a", "star", 1, () => savePending);
  const harness = createHarness();

  const committing = harness.committer.commit({
    property: "star",
    changes: new Map([[node, 4]]),
  });

  assert.equal(node.item.star, 4);
  assert.equal(node.isSaving, true);
  assert.equal(harness.invalidations, 1);
  assert.deepEqual(harness.events, [
    ["saving", "a", true],
    ["change", "a", "star"],
  ]);

  releaseSave(true);
  const result = await committing;

  assert.equal(result.status, "saved");
  assert.deepEqual(result.succeeded, [node]);
  assert.deepEqual(result.failed, []);
  assert.equal(node.item.star, 4);
  assert.equal(node.isSaving, false);
  assert.deepEqual(harness.events.slice(-2), [
    ["saving", "a", false],
    ["complete", "saved"],
  ]);
});

test("a partial failure rolls back only failed nodes and limits concurrency", async () => {
  let active = 0;
  let peakActive = 0;
  const save = async function save() {
    active += 1;
    peakActive = Math.max(peakActive, active);
    await Promise.resolve();
    active -= 1;
    if (this.id === "b") throw new Error("failed");
    return true;
  };
  const nodes = [
    createNode("a", "tags", ["old-a"], save),
    createNode("b", "tags", ["old-b"], save),
    createNode("c", "tags", ["old-c"], save),
  ];
  const harness = createHarness({ maxConcurrent: 2 });

  const result = await harness.committer.commit({
    property: "tags",
    changes: new Map(nodes.map((node) => [node, [`new-${node.item.id}`]])),
  });

  assert.equal(peakActive, 2);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.succeeded.map((node) => node.item.id), ["a", "c"]);
  assert.deepEqual(result.failed.map(({ node }) => node.item.id), ["b"]);
  assert.deepEqual(nodes[0].item.tags, ["new-a"]);
  assert.deepEqual(nodes[1].item.tags, ["old-b"]);
  assert.deepEqual(nodes[2].item.tags, ["new-c"]);
  assert.ok(nodes.every((node) => node.isSaving === false));
  assert.deepEqual(
    harness.events.filter(([type, id]) => type === "change" && id === "b"),
    [
      ["change", "b", "tags"],
      ["change", "b", "tags"],
    ],
    "the failed node should refresh once when applied and once when rolled back",
  );
});

test("an explicit false save result is a failure and restores the previous value", async () => {
  const node = createNode("a", "folders", ["old"], async () => false);
  const harness = createHarness();

  const result = await harness.committer.commit({
    property: "folders",
    changes: new Map([[node, ["new"]]]),
  });

  assert.equal(result.status, "failed");
  assert.match(result.failed[0].error.message, /拒絕/);
  assert.deepEqual(node.item.folders, ["old"]);
});

test("busy or unsupported changes abort before optimistic mutation", async () => {
  const busy = createNode("busy", "star", 1, async () => true);
  busy.isSaving = true;
  const unsupported = createNode("unsupported", "star", 2, undefined);
  const harness = createHarness();

  const busyResult = await harness.committer.commit({
    property: "star",
    changes: new Map([[busy, 5]]),
  });
  const unsupportedResult = await harness.committer.commit({
    property: "star",
    changes: new Map([[unsupported, 5]]),
  });

  assert.equal(busyResult.status, "busy");
  assert.equal(unsupportedResult.status, "unsupported");
  assert.equal(busy.item.star, 1);
  assert.equal(unsupported.item.star, 2);
  assert.equal(harness.invalidations, 0);
  assert.deepEqual(harness.events, []);
});

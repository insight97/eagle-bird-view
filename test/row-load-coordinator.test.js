"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRowLoadCoordinator } = require("../row-load-coordinator.js");

test("load hydrates selected candidates and reports loading transitions", async () => {
  const transitions = [];
  const coordinator = createRowLoadCoordinator({
    onLoadingChange(channel, isLoading) {
      transitions.push([channel, isLoading]);
    },
  });

  const result = await coordinator.load("related", {
    find: async () => [{ id: "candidate" }],
    select: (candidates) => candidates,
    hydrate: async (candidates) => candidates.map((item) => ({ ...item, hydrated: true })),
  });

  assert.equal(result.status, "success");
  assert.deepEqual(result.value.items, [{ id: "candidate", hydrated: true }]);
  assert.deepEqual(transitions, [["related", true], ["related", false]]);
  assert.equal(coordinator.isLoading("related"), false);
});

test("a stale result cannot commit after its channel is invalidated", async () => {
  let resolveFind;
  const coordinator = createRowLoadCoordinator();
  const pending = coordinator.load("unrated", {
    find: () => new Promise((resolve) => {
      resolveFind = resolve;
    }),
    hydrate: async (items) => items,
  });

  assert.equal(coordinator.isLoading("unrated"), true);
  coordinator.invalidate("unrated");
  resolveFind([{ id: "stale" }]);

  assert.deepEqual(await pending, { status: "stale" });
  assert.equal(coordinator.isLoading("unrated"), false);
});

test("busy channels reject duplicate work while other channels remain independent", async () => {
  let resolveFirst;
  const coordinator = createRowLoadCoordinator();
  const first = coordinator.run("folder", () => new Promise((resolve) => {
    resolveFirst = resolve;
  }));

  assert.deepEqual(await coordinator.run("folder", async () => "ignored"), { status: "busy" });

  const other = await coordinator.run("related", async () => "related");
  assert.deepEqual(other, { status: "success", value: "related" });

  resolveFirst("folder");
  assert.deepEqual(await first, { status: "success", value: "folder" });
});

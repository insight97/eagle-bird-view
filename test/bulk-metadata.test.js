"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createBulkMetadataService } = require("../bulk-metadata.js");

test("bulk metadata saving limits concurrency and keeps partial successes", async () => {
  const service = createBulkMetadataService({ maxConcurrent: 2 });
  const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const active = [];
  const saved = [];
  const rolledBack = [];

  const result = await service.save(nodes, {
    async save(node) {
      active.push(node.id);
      assert.ok(active.length <= 2);
      await Promise.resolve();
      active.splice(active.indexOf(node.id), 1);
      if (node.id === "b") throw new Error("failed");
      saved.push(node.id);
    },
    rollback(node) {
      rolledBack.push(node.id);
    },
  });

  assert.deepEqual(result.succeeded.map(({ id }) => id), ["a", "c"]);
  assert.deepEqual(result.failed.map(({ node }) => node.id), ["b"]);
  assert.deepEqual(saved, ["a", "c"]);
  assert.deepEqual(rolledBack, ["b"]);
});

test("bulk metadata saving treats an explicit false result as a failure", async () => {
  const service = createBulkMetadataService();
  const node = { id: "a" };
  const result = await service.save([node], {
    async save() {
      return false;
    },
  });

  assert.equal(result.succeeded.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error.message, /拒絕/);
});

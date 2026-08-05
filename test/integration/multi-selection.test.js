"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPluginHarness } = require("../../test-support/plugin-harness.js");

function imageItem(id) {
  return {
    id,
    name: `${id}.jpg`,
    ext: "jpg",
    width: 1000,
    height: 700,
    fileURL: `file:///${id}.jpg`,
    thumbnailURL: `file:///${id}-thumb.jpg`,
    tags: [],
    folders: [],
    star: 0,
    async save() {
      return true;
    },
  };
}

async function startPlugin() {
  const plugin = createPluginHarness({
    selectedItems: [imageItem("one"), imageItem("two"), imageItem("three")],
    navigationProbe: true,
    runAnimationFrames: true,
  });
  plugin.start();
  await new Promise((resolve) => setImmediate(resolve));
  plugin.flushTimers();
  return plugin;
}

function selectedIds(plugin) {
  return [...plugin.state.selectedNodes].map((node) => node.item.id);
}

test("media card clicks support single, ctrl toggle, and shift range selection", async () => {
  const plugin = await startPlugin();
  const cards = plugin.elements
    .get("#world")
    .children.filter((element) => element.classList.contains("media-card"));
  assert.equal(cards.length, 3);

  cards[0].emit("click");
  assert.equal(cards[0].classList.contains("is-multi-selected"), false);
  cards[2].emit("click", { shiftKey: true });
  assert.deepEqual(selectedIds(plugin), ["one", "two", "three"]);
  assert.equal(cards[0].classList.contains("is-selected"), true);
  assert.equal(cards[1].classList.contains("is-selected"), true);
  assert.equal(cards[2].classList.contains("is-selected"), true);
  assert.equal(cards[0].classList.contains("is-multi-selected"), true);
  assert.equal(cards[1].classList.contains("is-multi-selected"), true);
  assert.equal(cards[2].classList.contains("is-multi-selected"), true);
  assert.equal(cards[2].classList.contains("is-active"), true);

  cards[1].emit("click", { ctrlKey: true });
  assert.deepEqual(selectedIds(plugin), ["one", "three"]);
  assert.equal(cards[1].classList.contains("is-selected"), false);

  cards[1].emit("click");
  assert.deepEqual(selectedIds(plugin), ["two"]);
  assert.equal(plugin.state.selectedNode.item.id, "two");
  assert.equal(cards[1].classList.contains("is-active"), true);
  assert.equal(cards[1].classList.contains("is-multi-selected"), false);
});

test("viewport center maintenance leaves multiple selection intact", async () => {
  const plugin = await startPlugin();
  const cards = plugin.elements
    .get("#world")
    .children.filter((element) => element.classList.contains("media-card"));
  cards[0].emit("click");
  cards[1].emit("click", { ctrlKey: true });

  plugin.flushTimers();
  assert.deepEqual(selectedIds(plugin), ["one", "two"]);
});

test("Escape clears the multiple selection", async () => {
  const plugin = await startPlugin();
  const cards = plugin.elements
    .get("#world")
    .children.filter((element) => element.classList.contains("media-card"));
  cards[0].emit("click");
  cards[1].emit("click", { ctrlKey: true });
  plugin.elements.get("#auto-explore-settings-panel").hidden = true;

  plugin.keyDown({
    key: "Escape",
    target: null,
    preventDefault() {},
  });

  assert.deepEqual(selectedIds(plugin), []);
  assert.equal(plugin.elements.get("#selection-details").hidden, true);
});

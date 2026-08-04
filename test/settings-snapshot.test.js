"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_SETTINGS_SNAPSHOT,
  createSettingsSnapshotStore,
} = require("../settings-snapshot.js");

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    value(key) {
      return values.get(key) ?? null;
    },
  };
}

test("settings snapshot captures canonical values and clones filters", () => {
  const store = createSettingsSnapshotStore();
  const source = {
    unratedEnabled: true,
    board: {
      layoutWidth: "9999",
      layoutWidthUnlimited: true,
      maxExplorationItems: "18.9",
      aiExplorationRatio: "37",
      aiSimilarityMax: "53",
      focusMediaSize: "123",
      keyboardAcceleration: "24",
    },
    autoExploreFilter: { tags: ["UI"] },
  };

  const snapshot = store.capture(source);
  source.autoExploreFilter.tags.push("mutated");

  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.unratedEnabled, true);
  assert.equal(snapshot.board.layoutWidth, 2400);
  assert.equal(snapshot.board.maxExplorationItems, 18);
  assert.equal(snapshot.board.aiExplorationRatio, 25);
  assert.equal(snapshot.board.aiSimilarityMax, 55);
  assert.equal(snapshot.board.focusMediaSize, 120);
  assert.equal(snapshot.board.keyboardAcceleration, 24);
  assert.deepEqual(snapshot.autoExploreFilter.tags, ["UI"]);
});

test("settings snapshot migrates legacy AI item limits", () => {
  const store = createSettingsSnapshotStore();

  const snapshot = store.normalize({
    board: {
      maxExplorationItems: 12,
      aiExplorationEnabled: true,
      maxAiExplorationItems: 6,
    },
  });

  assert.equal(snapshot.board.aiExplorationRatio, 50);
  assert.equal(snapshot.board.aiExplorationEnabled, true);
});

test("settings snapshot persists canonical values and survives a new store", () => {
  const storage = createStorage();
  const first = createSettingsSnapshotStore({ storage });
  const snapshot = first.capture({
    activePresetName: "Focus view",
    board: { layoutWidth: 1600 },
  });

  assert.equal(first.write(snapshot), true);
  const second = createSettingsSnapshotStore({ storage });

  assert.deepEqual(second.read(), snapshot);
  assert.equal(JSON.parse(storage.value("bird-view-settings")).version, 1);
});

test("settings snapshot falls back to defaults for malformed storage", () => {
  const storage = createStorage({ "bird-view-settings": "not-json" });
  const store = createSettingsSnapshotStore({ storage });

  assert.equal(store.read(), null);
  assert.deepEqual(store.defaults, DEFAULT_SETTINGS_SNAPSHOT);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createSettingsPresetStore,
  normalizePresetName,
  normalizePresets,
} = require("../settings-presets.js");

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

test("preset store saves, reloads, and updates named settings", () => {
  const storage = createStorage();
  const firstStore = createSettingsPresetStore({ storage });
  const settings = { board: { layoutWidth: 1200 } };

  assert.equal(firstStore.save("  Focus view  ", settings).ok, true);
  settings.board.layoutWidth = 1600;
  assert.equal(firstStore.get("focus view").settings.board.layoutWidth, 1200);

  const secondStore = createSettingsPresetStore({ storage });
  assert.deepEqual(secondStore.list().map(({ name }) => name), ["Focus view"]);
  assert.equal(secondStore.update("Focus view", settings).ok, true);
  assert.equal(secondStore.get("FOCUS VIEW").settings.board.layoutWidth, 1600);
});

test("preset store keeps duplicate names from overwriting existing presets", () => {
  const store = createSettingsPresetStore();

  assert.equal(store.save("Default", { value: 1 }).ok, true);
  assert.equal(store.save(" default ", { value: 2 }).error, "duplicate-name");
  assert.deepEqual(store.get("Default").settings, { value: 1 });
  assert.equal(store.remove("Default").ok, true);
  assert.equal(store.get("Default"), null);
});

test("preset input and malformed stored entries are normalized", () => {
  assert.equal(normalizePresetName("  hello  "), "hello");
  assert.equal(normalizePresetName(""), "");
  assert.deepEqual(
    normalizePresets([
      { name: "Good", settings: { value: 1 } },
      { name: " good ", settings: { value: 2 } },
      { name: "", settings: { value: 3 } },
      { name: "No settings" },
    ]),
    [{ name: "Good", settings: { value: 1 } }],
  );
});

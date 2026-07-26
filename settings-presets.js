"use strict";

(function exposeBirdViewSettingsPresets(root, factory) {
  const presets = factory();
  if (typeof module === "object" && module.exports) module.exports = presets;
  root.BirdViewSettingsPresets = presets;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const DEFAULT_STORAGE_KEY = "bird-view-presets";
  const MAX_PRESET_NAME_LENGTH = 80;
  const MAX_PRESETS = 100;

  function normalizePresetName(name) {
    return String(name ?? "").trim().slice(0, MAX_PRESET_NAME_LENGTH);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizePresets(value) {
    const entries = Array.isArray(value)
      ? value
      : Array.isArray(value?.presets)
        ? value.presets
        : [];
    const names = new Set();
    const presets = [];

    for (const entry of entries) {
      const name = normalizePresetName(entry?.name);
      if (!name || names.has(name.toLocaleLowerCase())) continue;
      if (!entry?.settings || typeof entry.settings !== "object") continue;
      names.add(name.toLocaleLowerCase());
      presets.push({ name, settings: clone(entry.settings) });
      if (presets.length >= MAX_PRESETS) break;
    }
    return presets;
  }

  function createSettingsPresetStore({
    storage,
    storageKey = DEFAULT_STORAGE_KEY,
  } = {}) {
    let presets = readPresets();

    function readPresets() {
      if (!storage || typeof storage.getItem !== "function") return [];
      try {
        return normalizePresets(JSON.parse(storage.getItem(storageKey) || "[]"));
      } catch {
        return [];
      }
    }

    function persist() {
      if (!storage || typeof storage.setItem !== "function") return true;
      try {
        storage.setItem(storageKey, JSON.stringify({ version: 1, presets }));
        return true;
      } catch {
        return false;
      }
    }

    function findIndex(name) {
      const normalizedName = normalizePresetName(name).toLocaleLowerCase();
      return presets.findIndex((preset) => preset.name.toLocaleLowerCase() === normalizedName);
    }

    function list() {
      return clone(presets);
    }

    function get(name) {
      const index = findIndex(name);
      return index === -1 ? null : clone(presets[index]);
    }

    function save(name, settings) {
      const normalizedName = normalizePresetName(name);
      if (!normalizedName) return { ok: false, error: "invalid-name" };
      if (!settings || typeof settings !== "object") {
        return { ok: false, error: "invalid-settings" };
      }
      if (findIndex(normalizedName) !== -1) return { ok: false, error: "duplicate-name" };
      if (presets.length >= MAX_PRESETS) return { ok: false, error: "limit-reached" };

      const preset = { name: normalizedName, settings: clone(settings) };
      presets = [...presets, preset];
      if (!persist()) {
        presets = presets.slice(0, -1);
        return { ok: false, error: "storage" };
      }
      return { ok: true, preset: clone(preset) };
    }

    function update(name, settings) {
      const index = findIndex(name);
      if (index === -1) return { ok: false, error: "not-found" };
      if (!settings || typeof settings !== "object") {
        return { ok: false, error: "invalid-settings" };
      }

      const previous = presets;
      presets = presets.map((preset, presetIndex) =>
        presetIndex === index ? { ...preset, settings: clone(settings) } : preset,
      );
      if (!persist()) {
        presets = previous;
        return { ok: false, error: "storage" };
      }
      return { ok: true, preset: clone(presets[index]) };
    }

    function remove(name) {
      const index = findIndex(name);
      if (index === -1) return { ok: false, error: "not-found" };

      const previous = presets;
      presets = presets.filter((_, presetIndex) => presetIndex !== index);
      if (!persist()) {
        presets = previous;
        return { ok: false, error: "storage" };
      }
      return { ok: true, preset: clone(previous[index]) };
    }

    return Object.freeze({ get, list, remove, save, update });
  }

  return Object.freeze({
    DEFAULT_STORAGE_KEY,
    MAX_PRESET_NAME_LENGTH,
    MAX_PRESETS,
    createSettingsPresetStore,
    normalizePresetName,
    normalizePresets,
  });
});

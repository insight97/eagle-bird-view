"use strict";

(function exposeBirdViewSettingsSnapshot(root, factory) {
  const core =
    root.BirdViewCore ||
    (typeof module === "object" && typeof require === "function"
      ? require("./bird-view-core.js")
      : null);
  const exploration =
    root.BirdViewExploration ||
    (typeof module === "object" && typeof require === "function"
      ? require("./exploration-source.js")
      : null);
  const snapshot = factory(core, exploration);
  if (typeof module === "object" && module.exports) module.exports = snapshot;
  root.BirdViewSettingsSnapshot = snapshot;
})(typeof globalThis === "object" ? globalThis : this, (core, exploration) => {
  const {
    DEFAULT_MAX_EXPLORATION_ITEMS,
    LAYOUT_WIDTH,
    MAX_LAYOUT_WIDTH,
    MAX_EXPLORATION_ITEMS,
    MIN_EXPLORATION_ITEMS,
    MIN_LAYOUT_WIDTH,
    TARGET_ROW_HEIGHT,
    clamp,
    normalizeAiExplorationRatio,
    normalizeExplorationDiversityStrength,
  } = core;
  const {
    DEFAULT_UNRATED_FILTER,
    normalizeUnratedFilter,
  } = exploration;

  const SETTINGS_VERSION = 1;
  const DEFAULT_STORAGE_KEY = "bird-view-settings";
  const DEFAULT_SMOOTH_PAN_SPEED = 480;
  const MIN_SMOOTH_PAN_SPEED = 120;
  const MAX_SMOOTH_PAN_SPEED = 6000;
  const DEFAULT_SMOOTH_ZOOM_SPEED = 1.5;
  const MIN_SMOOTH_ZOOM_SPEED = 1.05;
  const MAX_SMOOTH_ZOOM_SPEED = 60;
  const KEYBOARD_ACCELERATION_LEVELS = Object.freeze([6, 16, 24]);
  const DEFAULT_KEYBOARD_ACCELERATION = 16;
  const DEFAULT_FOCUS_MEDIA_SIZE = TARGET_ROW_HEIGHT;
  const MIN_FOCUS_MEDIA_SIZE = 80;
  const MAX_FOCUS_MEDIA_SIZE = 400;
  const DEFAULT_LAYOUT_DIRECTION = "ltr";
  const DEFAULT_AI_EXPLORATION_RATIO = 0;
  const DEFAULT_AI_SIMILARITY_MAX = 100;
  const DEFAULT_EXPLORATION_DIVERSITY_STRENGTH = 0;
  const MIN_AI_SIMILARITY_MAX = 0;
  const MAX_AI_SIMILARITY_MAX = 100;
  const MAX_PRESET_NAME_LENGTH = 80;

  const SETTINGS_LIMITS = Object.freeze({
    maxLayoutWidth: MAX_LAYOUT_WIDTH,
    maxAiSimilarity: MAX_AI_SIMILARITY_MAX,
  });

  const DEFAULT_SETTINGS_SNAPSHOT = deepFreeze({
    version: SETTINGS_VERSION,
    unratedEnabled: false,
    board: {
      layoutDirection: DEFAULT_LAYOUT_DIRECTION,
      layoutWidth: LAYOUT_WIDTH,
      layoutWidthUnlimited: false,
      seamlessMode: false,
      maxExplorationItems: DEFAULT_MAX_EXPLORATION_ITEMS,
      aiExplorationEnabled: false,
      aiExplorationRatio: DEFAULT_AI_EXPLORATION_RATIO,
      aiSimilarityMax: DEFAULT_AI_SIMILARITY_MAX,
      explorationDiversityStrength: DEFAULT_EXPLORATION_DIVERSITY_STRENGTH,
      smoothPanEnabled: false,
      smoothPanSpeed: DEFAULT_SMOOTH_PAN_SPEED,
      smoothZoomEnabled: false,
      smoothZoomSpeed: DEFAULT_SMOOTH_ZOOM_SPEED,
      keyboardAcceleration: DEFAULT_KEYBOARD_ACCELERATION,
      focusMediaSize: DEFAULT_FOCUS_MEDIA_SIZE,
      videoAutoplayEnabled: false,
    },
    autoExploreFilter: normalizeUnratedFilter(DEFAULT_UNRATED_FILTER),
  });

  function createSettingsSnapshotStore({
    storage,
    storageKey = DEFAULT_STORAGE_KEY,
  } = {}) {
    function capture(values = {}) {
      return normalize(values);
    }

    function normalize(values = {}) {
      const source = values && typeof values === "object" ? values : {};
      const sourceBoard = source.board && typeof source.board === "object" ? source.board : {};
      const maxExplorationItems = normalizeMaxExplorationItems(
        sourceBoard.maxExplorationItems,
      );
      const hasAiExplorationRatio = Object.prototype.hasOwnProperty.call(
        sourceBoard,
        "aiExplorationRatio",
      );
      const legacyMaxAiExplorationItems = normalizeLegacyMaxAiExplorationItems(
        sourceBoard.maxAiExplorationItems,
      );
      const aiExplorationRatio = hasAiExplorationRatio
        ? normalizeAiExplorationRatio(sourceBoard.aiExplorationRatio)
        : sourceBoard.aiExplorationEnabled === false
          ? DEFAULT_AI_EXPLORATION_RATIO
          : ratioFromLegacyMaxAiItems(legacyMaxAiExplorationItems, maxExplorationItems);
      const normalized = {
        version: SETTINGS_VERSION,
        unratedEnabled:
          typeof source.unratedEnabled === "boolean"
            ? source.unratedEnabled
            : DEFAULT_SETTINGS_SNAPSHOT.unratedEnabled,
        board: {
          layoutDirection: normalizeLayoutDirection(sourceBoard.layoutDirection),
          layoutWidth: normalizeBoardLayoutWidth(sourceBoard.layoutWidth),
          layoutWidthUnlimited: Boolean(sourceBoard.layoutWidthUnlimited),
          seamlessMode: Boolean(sourceBoard.seamlessMode),
          maxExplorationItems,
          aiExplorationEnabled: aiExplorationRatio > 0,
          aiExplorationRatio,
          aiSimilarityMax: normalizeAiSimilarityMax(sourceBoard.aiSimilarityMax),
          explorationDiversityStrength: normalizeExplorationDiversityStrength(
            sourceBoard.explorationDiversityStrength,
          ),
          smoothPanEnabled: Boolean(sourceBoard.smoothPanEnabled),
          smoothPanSpeed: normalizeStoredSettingNumber(
            sourceBoard.smoothPanSpeed,
            MIN_SMOOTH_PAN_SPEED,
            MAX_SMOOTH_PAN_SPEED,
            DEFAULT_SMOOTH_PAN_SPEED,
          ),
          smoothZoomEnabled: Boolean(sourceBoard.smoothZoomEnabled),
          smoothZoomSpeed: normalizeStoredSettingNumber(
            sourceBoard.smoothZoomSpeed,
            MIN_SMOOTH_ZOOM_SPEED,
            MAX_SMOOTH_ZOOM_SPEED,
            DEFAULT_SMOOTH_ZOOM_SPEED,
          ),
          keyboardAcceleration: normalizeKeyboardAcceleration(
            sourceBoard.keyboardAcceleration ?? sourceBoard.smoothZoomAcceleration,
          ),
          focusMediaSize: normalizeFocusMediaSize(sourceBoard.focusMediaSize),
          videoAutoplayEnabled: Boolean(sourceBoard.videoAutoplayEnabled),
        },
        autoExploreFilter: normalizeUnratedFilter(
          source.autoExploreFilter && typeof source.autoExploreFilter === "object"
            ? source.autoExploreFilter
            : DEFAULT_UNRATED_FILTER,
        ),
      };
      const activePresetName = normalizeActivePresetName(source.activePresetName);
      if (activePresetName) normalized.activePresetName = activePresetName;
      return normalized;
    }

    function read() {
      if (!storage || typeof storage.getItem !== "function") return null;
      try {
        const stored = storage.getItem(storageKey);
        return stored ? normalize(JSON.parse(stored)) : null;
      } catch {
        return null;
      }
    }

    function write(values) {
      if (!storage || typeof storage.setItem !== "function") return true;
      try {
        storage.setItem(storageKey, JSON.stringify(normalize(values)));
        return true;
      } catch {
        return false;
      }
    }

    return Object.freeze({
      capture,
      defaults: clone(DEFAULT_SETTINGS_SNAPSHOT),
      limits: SETTINGS_LIMITS,
      normalize,
      read,
      write,
    });
  }

  function normalizeStoredSettingNumber(value, minimum, maximum, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? clamp(number, minimum, maximum) : fallback;
  }

  function normalizeLayoutDirection(direction) {
    return direction === "rtl" ? "rtl" : DEFAULT_LAYOUT_DIRECTION;
  }

  function normalizeBoardLayoutWidth(width) {
    return normalizeStoredSettingNumber(width, MIN_LAYOUT_WIDTH, MAX_LAYOUT_WIDTH, LAYOUT_WIDTH);
  }

  function normalizeFocusMediaSize(size) {
    const value = Number(size);
    return Number.isFinite(value)
      ? clamp(Math.round(value / 10) * 10, MIN_FOCUS_MEDIA_SIZE, MAX_FOCUS_MEDIA_SIZE)
      : DEFAULT_FOCUS_MEDIA_SIZE;
  }

  function normalizeKeyboardAcceleration(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULT_KEYBOARD_ACCELERATION;
    return KEYBOARD_ACCELERATION_LEVELS.reduce((closest, candidate) =>
      Math.abs(candidate - number) < Math.abs(closest - number) ? candidate : closest,
    );
  }

  function normalizeMaxExplorationItems(value) {
    const number = Number(value);
    return Number.isFinite(number)
      ? clamp(Math.floor(number), MIN_EXPLORATION_ITEMS, MAX_EXPLORATION_ITEMS)
      : DEFAULT_MAX_EXPLORATION_ITEMS;
  }

  function normalizeLegacyMaxAiExplorationItems(value) {
    const number = Number(value);
    return Number.isFinite(number)
      ? clamp(Math.floor(number), 0, MAX_EXPLORATION_ITEMS)
      : 0;
  }

  function ratioFromLegacyMaxAiItems(maxItems, totalItems) {
    if (maxItems < 1 || totalItems < 1) return DEFAULT_AI_EXPLORATION_RATIO;
    return Math.max(
      25,
      normalizeAiExplorationRatio((maxItems / totalItems) * 100),
    );
  }

  function normalizeAiSimilarityMax(value) {
    const number = Number(value);
    return Number.isFinite(number)
      ? clamp(Math.round(number / 5) * 5, MIN_AI_SIMILARITY_MAX, MAX_AI_SIMILARITY_MAX)
      : DEFAULT_AI_SIMILARITY_MAX;
  }

  function normalizeActivePresetName(value) {
    return String(value ?? "").trim().slice(0, MAX_PRESET_NAME_LENGTH);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
  }

  return Object.freeze({
    DEFAULT_SETTINGS_SNAPSHOT,
    DEFAULT_STORAGE_KEY,
    SETTINGS_LIMITS,
    SETTINGS_VERSION,
    createSettingsSnapshotStore,
  });
});

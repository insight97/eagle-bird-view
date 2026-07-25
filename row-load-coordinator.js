"use strict";

(function exposeBirdViewRowLoad(root, factory) {
  const rowLoad = factory();
  if (typeof module === "object" && module.exports) module.exports = rowLoad;
  root.BirdViewRowLoad = rowLoad;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const STALE = Symbol("stale");

  function createRowLoadCoordinator({ onLoadingChange } = {}) {
    const generations = new Map();
    const loading = new Set();

    function nextGeneration(channel) {
      const generation = (generations.get(channel) || 0) + 1;
      generations.set(channel, generation);
      return generation;
    }

    function isCurrent(channel, generation) {
      return generations.get(channel) === generation;
    }

    function invalidate(channel) {
      nextGeneration(channel);
      if (!loading.delete(channel)) return;
      onLoadingChange?.(channel, false);
    }

    function invalidateAll() {
      for (const channel of new Set([...generations.keys(), ...loading])) {
        invalidate(channel);
      }
    }

    async function run(channel, task) {
      if (loading.has(channel)) return { status: "busy" };

      const generation = nextGeneration(channel);
      loading.add(channel);
      onLoadingChange?.(channel, true);
      const token = {
        generation,
        isCurrent: () => isCurrent(channel, generation),
      };

      try {
        const value = await task(token);
        if (!token.isCurrent() || value === STALE) return { status: "stale" };
        return { status: "success", value };
      } catch (error) {
        if (!token.isCurrent()) return { status: "stale" };
        return { status: "error", error };
      } finally {
        if (token.isCurrent()) {
          loading.delete(channel);
          onLoadingChange?.(channel, false);
        }
      }
    }

    async function load(
      channel,
      { find, select = (values) => values, hydrate, isRelevant = () => true },
    ) {
      return run(channel, async (token) => {
        const candidates = await find();
        if (!token.isCurrent() || !isRelevant()) return STALE;

        const selected = await select(candidates || []);
        if (!token.isCurrent() || !isRelevant()) return STALE;
        if (!selected?.length) return { kind: "empty", candidates: selected || [] };

        const items = hydrate ? await hydrate(selected) : selected;
        if (!token.isCurrent() || !isRelevant()) return STALE;
        return { kind: "loaded", candidates: selected, items: items || [] };
      });
    }

    return Object.freeze({
      getGeneration: (channel) => generations.get(channel) || 0,
      invalidate,
      invalidateAll,
      isLoading: (channel) => loading.has(channel),
      load,
      run,
    });
  }

  return Object.freeze({ createRowLoadCoordinator });
});

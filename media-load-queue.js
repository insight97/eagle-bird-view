"use strict";

(function exposeMediaLoadQueue(root, factory) {
  const media = factory();
  if (typeof module === "object" && module.exports) module.exports = media;
  root.BirdViewMedia = media;
})(typeof globalThis === "object" ? globalThis : this, () => {
  class MediaLoadQueue {
    #active = 0;
    #maxConcurrent;
    #queue = [];
    #states = new WeakMap();

    constructor({ maxConcurrent = 4 } = {}) {
      this.#maxConcurrent = maxConcurrent;
    }

    register(node, options) {
      this.dispose(node);
      this.#states.set(node, {
        node,
        start: options.start,
        cancel: options.cancel,
        hasOriginal: Boolean(options.hasOriginal),
        hasThumbnail: Boolean(options.hasThumbnail),
        preferThumbnailFirst: Boolean(options.preferThumbnailFirst),
        readyQuality: null,
        queuedQuality: null,
        pendingQuality: null,
        loadingQuality: null,
        originalFailed: false,
        thumbnailFailed: false,
        queued: false,
        loading: false,
        disposed: false,
      });
    }

    request(node, requestedQuality = "thumbnail") {
      const state = this.#states.get(node);
      if (!state || state.disposed) return false;
      const wantsOriginal =
        requestedQuality === "original" && state.hasOriginal && !state.originalFailed;
      let quality = wantsOriginal ? "original" : "thumbnail";
      if (quality === "thumbnail" && (!state.hasThumbnail || state.thumbnailFailed)) {
        return false;
      }
      if (state.readyQuality === "original" || state.readyQuality === quality) return false;

      let followupQuality = null;
      if (
        quality === "original" &&
        !state.readyQuality &&
        state.hasThumbnail &&
        state.preferThumbnailFirst &&
        !state.thumbnailFailed
      ) {
        followupQuality = "original";
        quality = "thumbnail";
      }
      const desiredQuality = followupQuality || quality;

      if (state.loading) {
        state.pendingQuality = promoteQuality(state.pendingQuality, desiredQuality);
        return false;
      }
      if (state.queued) {
        if (followupQuality) state.pendingQuality = "original";
        else if (quality === "original") state.queuedQuality = "original";
        return false;
      }

      state.pendingQuality = followupQuality;
      state.queuedQuality = quality;
      state.queued = true;
      if (quality === "original") this.#queue.unshift(state);
      else this.#queue.push(state);
      this.#pump();
      return true;
    }

    complete(node, quality, succeeded) {
      const state = this.#states.get(node);
      if (
        !state ||
        state.disposed ||
        !state.loading ||
        state.loadingQuality !== quality
      ) {
        return false;
      }

      state.loading = false;
      state.loadingQuality = null;
      this.#active = Math.max(0, this.#active - 1);
      if (succeeded) state.readyQuality = quality;
      else if (quality === "original") state.originalFailed = true;
      else state.thumbnailFailed = true;

      const pendingQuality = state.pendingQuality;
      state.pendingQuality = null;
      if (pendingQuality) this.request(node, pendingQuality);
      this.#pump();
      return true;
    }

    cancel(node, quality) {
      const state = this.#states.get(node);
      if (!state || state.disposed) return false;
      let canceled = false;

      if (state.pendingQuality === quality) {
        state.pendingQuality = null;
        canceled = true;
      }
      if (state.queued && state.queuedQuality === quality) {
        state.queued = false;
        state.queuedQuality = null;
        canceled = true;
      }
      if (state.loading && state.loadingQuality === quality) {
        state.loading = false;
        state.loadingQuality = null;
        this.#active = Math.max(0, this.#active - 1);
        canceled = true;
        try {
          state.cancel?.(quality);
        } catch {
          // Cancellation is best-effort; the stale completion will be ignored.
        }
      }

      if (canceled) this.#pump();
      return canceled;
    }

    dispose(node) {
      const state = this.#states.get(node);
      if (!state || state.disposed) return;
      state.disposed = true;
      state.queued = false;
      state.pendingQuality = null;
      if (state.loading) this.#active = Math.max(0, this.#active - 1);
      state.loading = false;
      state.loadingQuality = null;
      this.#states.delete(node);
      this.#pump();
    }

    get activeCount() {
      return this.#active;
    }

    snapshot(node) {
      const state = this.#states.get(node);
      if (!state) return null;
      return {
        readyQuality: state.readyQuality,
        queuedQuality: state.queuedQuality,
        pendingQuality: state.pendingQuality,
        loadingQuality: state.loadingQuality,
        originalFailed: state.originalFailed,
        thumbnailFailed: state.thumbnailFailed,
        queued: state.queued,
        loading: state.loading,
      };
    }

    #pump() {
      while (this.#active < this.#maxConcurrent && this.#queue.length) {
        const state = this.#queue.shift();
        if (state.disposed || !state.queued) continue;
        const quality = state.queuedQuality;
        state.queued = false;
        state.queuedQuality = null;
        state.loading = true;
        state.loadingQuality = quality;
        this.#active += 1;
        try {
          state.start(quality);
        } catch {
          this.complete(state.node, quality, false);
        }
      }
    }
  }

  function promoteQuality(current, requested) {
    return current === "original" || requested === "original" ? "original" : requested;
  }

  function waitForImageDecode(image, timeoutMs = 1500, timers = globalThis) {
    if (typeof image?.decode !== "function") return Promise.resolve();
    let timeoutId;
    const timeout = new Promise((resolve) => {
      timeoutId = timers.setTimeout(resolve, timeoutMs);
    });
    return Promise.race([Promise.resolve().then(() => image.decode()), timeout])
      .catch(() => {})
      .finally(() => timers.clearTimeout(timeoutId));
  }

  return Object.freeze({ MediaLoadQueue, waitForImageDecode });
});

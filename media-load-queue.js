"use strict";

(function exposeMediaLoadQueue(root, factory) {
  const media = factory();
  if (typeof module === "object" && module.exports) module.exports = media;
  root.BirdViewMedia = media;
})(typeof globalThis === "object" ? globalThis : this, () => {
  class MediaLoadQueue {
    #active = 0;
    #activeBackgroundOriginals = 0;
    #maxConcurrent;
    #maxBackgroundOriginals;
    #queue = [];
    #states = new WeakMap();

    // Background originals are intentionally capped below the total. A selected
    // or center card can then start immediately instead of waiting behind a
    // burst of expensive createImageBitmap decodes; thumbnails can still use
    // every slot because they do not enter that bounded-raster path.
    constructor({ maxConcurrent = 4, maxBackgroundOriginals = 2 } = {}) {
      this.#maxConcurrent = Math.max(1, Number(maxConcurrent) || 4);
      this.#maxBackgroundOriginals = Math.min(
        this.#maxConcurrent,
        Math.max(1, Number(maxBackgroundOriginals) || 2),
      );
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
        queuedPriority: null,
        pendingQuality: null,
        pendingPriority: null,
        loadingQuality: null,
        loadingPriority: null,
        originalFailed: false,
        thumbnailFailed: false,
        queued: false,
        loading: false,
        disposed: false,
      });
    }

    request(node, requestedQuality = "thumbnail", options = {}) {
      const state = this.#states.get(node);
      if (!state || state.disposed) return false;
      const priority = normalizePriority(options.priority);
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
        if (desiredQuality === "original") {
          state.pendingPriority = promotePriority(state.pendingPriority, priority);
        }
        return false;
      }
      if (state.queued) {
        if (followupQuality) {
          state.pendingQuality = "original";
          state.pendingPriority = promotePriority(state.pendingPriority, priority);
        } else if (quality === "original") {
          state.queuedQuality = "original";
          state.queuedPriority = promotePriority(state.queuedPriority, priority);
          if (state.queuedPriority === "high") this.#moveToFront(state);
          this.#pump();
        }
        return false;
      }

      state.pendingQuality = followupQuality;
      state.pendingPriority = followupQuality ? priority : null;
      state.queuedQuality = quality;
      state.queuedPriority = quality === "original" ? priority : "normal";
      state.queued = true;
      if (quality === "original" && priority === "high") this.#queue.unshift(state);
      else this.#queue.push(state);
      this.#pump();
      return true;
    }

    retry(node, requestedQuality = "original", options = {}) {
      const state = this.#states.get(node);
      if (!state || state.disposed) return false;
      if (requestedQuality === "original") state.originalFailed = false;
      if (requestedQuality === "thumbnail") state.thumbnailFailed = false;
      return this.request(node, requestedQuality, options);
    }

    // Drops a ready quality so it can be requested again. Used when the card is
    // still showing the right quality but needs it re-rastered at a sharper
    // size; the caller keeps the current pixels on screen until the reload
    // lands, so this never blanks a card.
    invalidate(node, quality = "original") {
      const state = this.#states.get(node);
      if (!state || state.disposed) return false;
      if (state.readyQuality !== quality) return false;
      state.readyQuality =
        quality === "original" && state.hasThumbnail && !state.thumbnailFailed
          ? "thumbnail"
          : null;
      return true;
    }

    fail(node, failedQuality = "original") {
      const state = this.#states.get(node);
      if (!state || state.disposed) return false;
      const isRequested =
        state.pendingQuality === failedQuality ||
        state.queuedQuality === failedQuality ||
        state.loadingQuality === failedQuality;
      if (!isRequested) return false;
      this.cancel(node, failedQuality);
      if (failedQuality === "original") state.originalFailed = true;
      if (failedQuality === "thumbnail") state.thumbnailFailed = true;
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
      this.#releaseBackgroundOriginal(state);
      state.loadingQuality = null;
      state.loadingPriority = null;
      this.#active = Math.max(0, this.#active - 1);
      if (succeeded) state.readyQuality = quality;
      else if (quality === "original") state.originalFailed = true;
      else state.thumbnailFailed = true;

      const pendingQuality = state.pendingQuality;
      const pendingPriority = state.pendingPriority;
      state.pendingQuality = null;
      state.pendingPriority = null;
      if (pendingQuality) this.request(node, pendingQuality, { priority: pendingPriority });
      this.#pump();
      return true;
    }

    cancel(node, quality) {
      const state = this.#states.get(node);
      if (!state || state.disposed) return false;
      let canceled = false;

      if (state.pendingQuality === quality) {
        state.pendingQuality = null;
        state.pendingPriority = null;
        canceled = true;
      }
      if (state.queued && state.queuedQuality === quality) {
        state.queued = false;
        state.queuedQuality = null;
        state.queuedPriority = null;
        canceled = true;
      }
      if (state.loading && state.loadingQuality === quality) {
        this.#releaseBackgroundOriginal(state);
        state.loading = false;
        state.loadingQuality = null;
        state.loadingPriority = null;
        this.#active = Math.max(0, this.#active - 1);
        canceled = true;
      }
      if (canceled) {
        try {
          state.cancel?.(quality);
        } catch {
          // Cancellation is best-effort; the stale completion will be ignored.
        }
        this.#pump();
      }
      return canceled;
    }

    dispose(node) {
      const state = this.#states.get(node);
      if (!state || state.disposed) return;
      const activeQualities = new Set(
        [state.loadingQuality, state.queuedQuality, state.pendingQuality].filter(Boolean),
      );
      state.disposed = true;
      state.queued = false;
      state.queuedQuality = null;
      state.queuedPriority = null;
      state.pendingQuality = null;
      state.pendingPriority = null;
      if (state.loading) {
        this.#releaseBackgroundOriginal(state);
        this.#active = Math.max(0, this.#active - 1);
      }
      state.loading = false;
      state.loadingQuality = null;
      state.loadingPriority = null;
      this.#states.delete(node);
      for (const quality of activeQualities) {
        try {
          state.cancel?.(quality);
        } catch {
          // Disposal must still release the queue slot if adapter cleanup fails.
        }
      }
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
        queuedPriority: state.queuedPriority,
        pendingQuality: state.pendingQuality,
        pendingPriority: state.pendingPriority,
        loadingQuality: state.loadingQuality,
        loadingPriority: state.loadingPriority,
        originalFailed: state.originalFailed,
        thumbnailFailed: state.thumbnailFailed,
        queued: state.queued,
        loading: state.loading,
      };
    }

    #pump() {
      while (this.#active < this.#maxConcurrent && this.#queue.length) {
        const index = this.#nextRunnableIndex();
        if (index === -1) return;
        const [state] = this.#queue.splice(index, 1);
        const quality = state.queuedQuality;
        const priority = state.queuedPriority || "normal";
        state.queued = false;
        state.queuedQuality = null;
        state.queuedPriority = null;
        state.loading = true;
        state.loadingQuality = quality;
        state.loadingPriority = priority;
        this.#active += 1;
        if (quality === "original" && priority !== "high") {
          this.#activeBackgroundOriginals += 1;
        }
        try {
          state.start(quality);
        } catch {
          this.complete(state.node, quality, false);
        }
      }
    }

    #nextRunnableIndex() {
      for (let index = 0; index < this.#queue.length; index += 1) {
        const state = this.#queue[index];
        if (state.disposed || !state.queued) {
          this.#queue.splice(index, 1);
          index -= 1;
          continue;
        }
        const isBackgroundOriginal =
          state.queuedQuality === "original" && state.queuedPriority !== "high";
        if (
          isBackgroundOriginal &&
          this.#activeBackgroundOriginals >= this.#maxBackgroundOriginals
        ) {
          continue;
        }
        return index;
      }
      return -1;
    }

    #moveToFront(state) {
      this.#queue = this.#queue.filter((candidate) => candidate !== state);
      this.#queue.unshift(state);
    }

    #releaseBackgroundOriginal(state) {
      if (state.loadingQuality !== "original" || state.loadingPriority === "high") return;
      this.#activeBackgroundOriginals = Math.max(0, this.#activeBackgroundOriginals - 1);
    }
  }

  function promoteQuality(current, requested) {
    return current === "original" || requested === "original" ? "original" : requested;
  }

  function normalizePriority(priority) {
    return priority === "high" ? "high" : "normal";
  }

  function promotePriority(current, requested) {
    return current === "high" || requested === "high" ? "high" : "normal";
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

"use strict";

(function exposeSelectionTagOverflow(root, factory) {
  const hasCommonJS = typeof module === "object" && module.exports;
  const popover =
    root.BirdViewPopover ||
    (hasCommonJS && typeof require === "function" ? require("./anchored-popover.js") : null);
  const selectionTagOverflow = factory(popover);
  if (hasCommonJS) module.exports = selectionTagOverflow;
  root.BirdViewSelectionTags = selectionTagOverflow;
})(typeof globalThis === "object" ? globalThis : this, (popover) => {
  const { AnchoredPopover } = popover;
  const MAX_TAG_OPTIONS = 80;
  const DEFAULT_TAG_GAP = 4;

  class SelectionTagOverflow extends AnchoredPopover {
    open(node, anchor, tags) {
      this.close();
      const entries = [...new Set(tags || [])].filter(Boolean);
      if (!entries.length) return false;

      this.mount(node, anchor, {
        className: "tag-editor selection-tag-overflow",
        ariaLabel: `選取素材的全部 Tag（${entries.length} 個）`,
        heading: `全部 Tag（${entries.length}）`,
        placeholder: "搜尋 Tag",
        extra: { entries },
      });
      return true;
    }

    handleKeyDown(event, session) {
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.moveSelection(session, event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key !== "Enter") return;
      event.preventDefault();
      session.actions[session.activeIndex]?.activate();
    }

    renderOptions(session) {
      const query = this.getQuery(session);
      const entries = session.entries
        .filter((tag) => !query || tag.toLocaleLowerCase().includes(query))
        .slice(0, MAX_TAG_OPTIONS);
      this.resetOptions(session);

      for (const tag of entries) this.appendTagOption(session, tag);
      if (!session.actions.length) {
        this.appendEmptyMessage(session, query ? "沒有符合的 Tag" : "沒有可用的 Tag");
      }
      this.commitOptions(session);
    }

    appendTagOption(session, tag) {
      const option = document.createElement("button");
      option.className = "tag-editor-option selection-tag-overflow-option";
      option.type = "button";
      option.append(this.options.createTagChip(tag));
      this.appendAction(session, option, () => {
        if (this.session !== session) return;
        this.close();
        void this.options.onSelect({ node: session.node, tag });
      });
    }
  }

  function getVisibleTagCount(
    tagWidths,
    availableWidth,
    overflowWidths,
    { gap = DEFAULT_TAG_GAP, maxVisible = Number.POSITIVE_INFINITY } = {},
  ) {
    const widths = tagWidths.map((width) => Math.max(0, Number(width) || 0));
    const available = Math.max(0, Number(availableWidth) || 0);
    const requestedMax = Number(maxVisible);
    const maxCount = Math.min(
      widths.length,
      Number.isFinite(requestedMax) ? Math.max(0, Math.floor(requestedMax)) : widths.length,
    );
    const gapSize = Math.max(0, Number(gap) || 0);
    const overflowSize = (hiddenCount) =>
      Math.max(0, Number(overflowWidths?.[hiddenCount]) || 0);
    const prefixWidths = [0];
    for (const width of widths) prefixWidths.push(prefixWidths.at(-1) + width);

    for (let visible = maxCount; visible >= 0; visible -= 1) {
      const hidden = widths.length - visible;
      const itemCount = visible + Number(hidden > 0);
      const requiredWidth =
        prefixWidths[visible] +
        (itemCount > 1 ? gapSize * (itemCount - 1) : 0) +
        overflowSize(hidden);
      if (requiredWidth <= available) return visible;
    }
    return 0;
  }

  return Object.freeze({
    SelectionTagOverflow,
    getVisibleTagCount,
  });
});

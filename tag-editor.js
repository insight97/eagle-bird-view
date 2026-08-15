"use strict";

(function exposeTagEditor(root, factory) {
  const hasCommonJS = typeof module === "object" && module.exports;
  const resolve = (name, modulePath) =>
    root[name] ||
    (hasCommonJS && typeof require === "function" ? require(modulePath) : null);
  const tagEditor = factory(
    resolve("BirdViewCore", "./bird-view-core.js"),
    resolve("BirdViewPopover", "./anchored-popover.js"),
  );
  if (hasCommonJS) module.exports = tagEditor;
  root.BirdViewTagEditor = tagEditor;
})(typeof globalThis === "object" ? globalThis : this, (core, popover) => {
  const { compareTextMatch, normalizeTags, rankTagMatches } = core;
  const { AnchoredPopover } = popover;
  const MAX_TAG_OPTIONS = 80;

  class TagEditor extends AnchoredPopover {
    open(node, anchor) {
      this.close();
      this.options.onSelectNode(node);
      this.mount(node, anchor, {
        className: "tag-editor",
        ariaLabel: `編輯 ${node.item.name || "素材"} 的標籤`,
        heading: "編輯標籤",
        placeholder: "搜尋或輸入新標籤",
        extra: { selected: new Set(normalizeTags(node.item.tags)) },
        buttons: [
          { label: "取消", onClick: () => this.close() },
          { label: "完成", primary: true, onClick: (session) => void this.commit(session) },
        ],
      });
    }

    openMultiple(nodes, anchor) {
      const selectedNodes = [...new Set(nodes || [])].filter((node) => node?.item);
      if (!selectedNodes.length) return false;
      this.close();
      const initialByNode = new Map(
        selectedNodes.map((node) => [node, new Set(normalizeTags(node.item.tags))]),
      );
      const allTags = new Set();
      for (const tags of initialByNode.values()) {
        for (const tag of tags) allTags.add(tag);
      }
      const commonTags = new Set(
        [...allTags].filter((tag) => selectedNodes.every((node) => initialByNode.get(node).has(tag))),
      );
      const mixedTags = new Set(
        [...allTags].filter((tag) => !commonTags.has(tag)),
      );
      this.mount(selectedNodes[0], anchor, {
        className: "tag-editor",
        ariaLabel: `編輯 ${selectedNodes.length} 個素材的標籤`,
        heading: `編輯 ${selectedNodes.length} 個素材的標籤`,
        placeholder: "搜尋或輸入新標籤",
        extra: {
          selected: commonTags,
          mixed: mixedTags,
          touched: new Set(),
          nodes: selectedNodes,
          initialByNode,
          multi: true,
        },
        buttons: [
          { label: "取消", onClick: () => this.close() },
          { label: "完成", primary: true, onClick: (session) => void this.commit(session) },
        ],
      });
      return true;
    }

    handleKeyDown(event, session) {
      if (event.key === "Escape") {
        event.preventDefault();
        void this.commit(session);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.moveSelection(session, event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (!session.input.value.trim()) {
        void this.commit(session);
        return;
      }
      session.actions[session.activeIndex]?.activate();
    }

    renderOptions(session) {
      const query = this.getQuery(session);
      const availableTags = normalizeAvailableTagEntries(
        this.options.getAvailableTags?.() || [],
      );
      const tagCounts = new Map(
        availableTags.map(({ name, count }) => [name, count]),
      );
      let candidates = rankTagMatches(
        [
          ...session.selected,
          ...normalizeTags(session.node.item.tags),
          ...(session.mixed || []),
          ...availableTags.map(({ name }) => name),
        ],
        query,
      );
      if (!query) {
        candidates = candidates.sort((first, second) => {
          const selectedDifference =
            Number(session.selected.has(second)) - Number(session.selected.has(first));
          return selectedDifference || first.localeCompare(second);
        });
      } else {
        const searchOrder = new Map(candidates.map((tag, index) => [tag, index]));
        candidates = candidates.sort((first, second) => {
          const similarityOrder = compareTextMatch(first, second, query);
          if (similarityOrder) return similarityOrder;
          const countOrder = compareTagCounts(tagCounts.get(first), tagCounts.get(second));
          return countOrder || searchOrder.get(first) - searchOrder.get(second);
        });
      }
      candidates = candidates.slice(0, MAX_TAG_OPTIONS);
      this.resetOptions(session);

      for (const tag of candidates) this.appendTagOption(session, tag);
      if (query && !candidates.some((tag) => tag.toLocaleLowerCase() === query)) {
        this.appendCreateOption(session, session.input.value.trim());
      }
      if (!session.actions.length) this.appendEmptyMessage(session, "沒有符合的標籤");
      this.commitOptions(session);
    }

    appendTagOption(session, tag) {
      const option = document.createElement("button");
      const marker = document.createElement("span");
      const isSelected = session.selected.has(tag);
      const isMixed = session.mixed?.has(tag) && !session.touched?.has(tag);
      option.className = "tag-editor-option";
      option.type = "button";
      option.setAttribute("aria-pressed", isMixed ? "mixed" : String(isSelected));
      marker.className = "tag-editor-check";
      marker.textContent = isMixed ? "—" : isSelected ? "✓" : "";
      option.classList.toggle("is-mixed", isMixed);
      option.append(marker, this.options.createTagChip(tag));
      this.appendAction(session, option, () => {
        if (session.selected.has(tag)) session.selected.delete(tag);
        else session.selected.add(tag);
        session.mixed?.delete(tag);
        session.touched?.add(tag);
        this.restartSearch(session);
      });
    }

    appendCreateOption(session, tag) {
      const create = document.createElement("button");
      create.className = "tag-editor-create";
      create.type = "button";
      create.textContent = `建立「${tag}」`;
      this.appendAction(session, create, () => {
        session.selected.add(tag);
        session.mixed?.delete(tag);
        session.touched?.add(tag);
        this.restartSearch(session);
      });
    }

    restartSearch(session) {
      session.input.value = "";
      session.activeIndex = 0;
      this.renderOptions(session);
    }

    async commit(session) {
      if (this.session !== session || session.node.isSaving) return;
      if (session.multi) {
        await this.commitMultiple(session);
        return;
      }
      const previousTags = normalizeTags(session.node.item.tags);
      const nextTags = [...session.selected];
      this.close();
      if (
        previousTags.length === nextTags.length &&
        previousTags.every((tag, index) => tag === nextTags[index])
      ) {
        return;
      }
      await this.options.onCommit?.(new Map([[session.node, nextTags]]));
    }

    async commitMultiple(session) {
      const nextByNode = new Map();
      for (const node of session.nodes) {
        const previousTags = [...session.initialByNode.get(node)];
        const nextTags = previousTags.filter(
          (tag) => !session.touched.has(tag) || session.selected.has(tag),
        );
        for (const tag of session.selected) {
          if (session.touched.has(tag) && !nextTags.includes(tag)) nextTags.push(tag);
        }
        if (
          previousTags.length !== nextTags.length ||
          previousTags.some((tag, index) => tag !== nextTags[index])
        ) {
          nextByNode.set(node, nextTags);
        }
      }
      this.close();
      if (!nextByNode.size) return;
      await this.options.onCommit?.(nextByNode);
    }

    refresh() {
      if (this.session) this.renderOptions(this.session);
    }
  }

  function normalizeAvailableTagEntries(source) {
    const entries = [];
    const seen = new Set();
    for (const value of source) {
      const name = String(
        value && typeof value === "object" ? value.name || "" : value || "",
      ).trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      entries.push({ name, count: normalizeTagCount(value?.count) });
    }
    return entries;
  }

  function normalizeTagCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count >= 0 ? Math.floor(count) : null;
  }

  function compareTagCounts(first, second) {
    if (first === null && second === null) return 0;
    if (first === null) return 1;
    if (second === null) return -1;
    return second - first;
  }

  return Object.freeze({ TagEditor });
});

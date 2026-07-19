"use strict";

(function exposeTagEditor(root, factory) {
  const hasCommonJS = typeof module === "object" && module.exports;
  const core =
    root.BirdViewCore ||
    (hasCommonJS && typeof require === "function" ? require("./bird-view-core.js") : null);
  const tagEditor = factory(core);
  if (hasCommonJS) module.exports = tagEditor;
  root.BirdViewTagEditor = tagEditor;
})(typeof globalThis === "object" ? globalThis : this, (core) => {
  const { clamp, normalizeTags, rankTagMatches } = core;

  class TagEditor {
    constructor(options) {
      this.options = options;
      this.session = null;
    }

    open(node, anchor) {
      this.close();
      this.options.onSelectNode(node);
      const editor = document.createElement("div");
      const heading = document.createElement("div");
      const input = document.createElement("input");
      const options = document.createElement("div");
      const footer = document.createElement("div");
      const cancel = document.createElement("button");
      const save = document.createElement("button");
      const session = {
        node,
        anchor,
        editor,
        input,
        options,
        selected: new Set(normalizeTags(node.item.tags)),
        actions: [],
        activeIndex: 0,
        outsideHandler: null,
      };

      editor.className = "tag-editor";
      editor.setAttribute("role", "dialog");
      editor.setAttribute("aria-label", `編輯 ${node.item.name || "素材"} 的標籤`);
      heading.className = "tag-editor-heading";
      heading.textContent = "編輯標籤";
      input.className = "tag-editor-search";
      input.type = "search";
      input.placeholder = "搜尋或輸入新標籤";
      input.setAttribute("aria-label", "搜尋或輸入新標籤");
      options.className = "tag-editor-options";
      footer.className = "tag-editor-footer";
      cancel.className = "tag-editor-button";
      cancel.type = "button";
      cancel.textContent = "取消";
      save.className = "tag-editor-button is-primary";
      save.type = "button";
      save.textContent = "完成";

      input.addEventListener("input", () => {
        session.activeIndex = 0;
        this.renderOptions(session);
      });
      input.addEventListener("keydown", (event) => this.handleKeyDown(event, session));
      cancel.addEventListener("click", () => this.close());
      save.addEventListener("click", () => void this.commit(session));
      editor.addEventListener("pointerdown", (event) => event.stopPropagation());
      footer.append(cancel, save);
      editor.append(heading, input, options, footer);
      this.options.getViewport().append(editor);
      this.session = session;
      this.renderOptions(session);

      session.outsideHandler = (event) => {
        if (!editor.contains(event.target) && event.target !== anchor) this.close();
      };
      document.addEventListener("pointerdown", session.outsideHandler, true);
      requestAnimationFrame(() => {
        if (this.session !== session) return;
        this.position(session);
        input.focus();
      });
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
      const query = session.input.value.trim().toLocaleLowerCase();
      let candidates = rankTagMatches(
        [
          ...session.selected,
          ...normalizeTags(session.node.item.tags),
          ...this.options.getAvailableTags(),
        ],
        query,
      );
      if (!query) {
        candidates = candidates.sort((first, second) => {
          const selectedDifference =
            Number(session.selected.has(second)) - Number(session.selected.has(first));
          return selectedDifference || first.localeCompare(second);
        });
      }
      candidates = candidates.slice(0, 80);
      session.options.replaceChildren();
      session.actions = [];

      for (const tag of candidates) this.appendTagOption(session, tag);
      if (query && !candidates.some((tag) => tag.toLocaleLowerCase() === query)) {
        this.appendCreateOption(session, session.input.value.trim());
      }
      if (!session.options.childElementCount) {
        const empty = document.createElement("div");
        empty.className = "tag-editor-empty";
        empty.textContent = "沒有符合的標籤";
        session.options.append(empty);
      }
      session.activeIndex = clamp(session.activeIndex, 0, Math.max(0, session.actions.length - 1));
      this.updateSelection(session);
    }

    appendTagOption(session, tag) {
      const option = document.createElement("button");
      const marker = document.createElement("span");
      const isSelected = session.selected.has(tag);
      option.className = "tag-editor-option";
      option.type = "button";
      option.setAttribute("aria-pressed", String(isSelected));
      marker.className = "tag-editor-check";
      marker.textContent = isSelected ? "✓" : "";
      option.append(marker, this.options.createTagChip(tag));
      const activate = () => {
        if (session.selected.has(tag)) session.selected.delete(tag);
        else session.selected.add(tag);
        session.input.value = "";
        session.activeIndex = 0;
        this.renderOptions(session);
      };
      option.addEventListener("click", activate);
      session.options.append(option);
      session.actions.push({ element: option, activate });
    }

    appendCreateOption(session, tag) {
      const create = document.createElement("button");
      const activate = () => {
        session.selected.add(tag);
        session.input.value = "";
        session.activeIndex = 0;
        this.renderOptions(session);
      };
      create.className = "tag-editor-create";
      create.type = "button";
      create.textContent = `建立「${tag}」`;
      create.addEventListener("click", activate);
      session.options.append(create);
      session.actions.push({ element: create, activate });
    }

    moveSelection(session, direction) {
      if (!session.actions.length) return;
      session.activeIndex =
        (session.activeIndex + direction + session.actions.length) % session.actions.length;
      this.updateSelection(session, true);
    }

    updateSelection(session, scroll = false) {
      for (const [index, action] of session.actions.entries()) {
        action.element.classList.toggle("is-active", index === session.activeIndex);
      }
      if (scroll) {
        session.actions[session.activeIndex]?.element.scrollIntoView({ block: "nearest" });
      }
    }

    position(session) {
      const viewportRect = this.options.getViewport().getBoundingClientRect();
      const anchorRect = session.anchor?.getBoundingClientRect() || {
        left: viewportRect.left + viewportRect.width / 2,
        top: viewportRect.top + viewportRect.height / 2,
        height: 0,
      };
      const width = session.editor.offsetWidth;
      const height = session.editor.offsetHeight;
      const anchorLeft = anchorRect.left - viewportRect.left;
      const anchorTop = anchorRect.top - viewportRect.top;
      const left = clamp(anchorLeft, 8, Math.max(8, viewportRect.width - width - 8));
      const below = anchorTop + anchorRect.height + 6;
      const top =
        below + height <= viewportRect.height - 8
          ? below
          : Math.max(8, anchorTop - height - 6);
      session.editor.style.left = `${Math.round(left)}px`;
      session.editor.style.top = `${Math.round(top)}px`;
    }

    async commit(session) {
      if (this.session !== session || session.node.isSaving) return;
      const previousTags = normalizeTags(session.node.item.tags);
      const nextTags = [...session.selected];
      this.close();
      if (
        previousTags.length === nextTags.length &&
        previousTags.every((tag, index) => tag === nextTags[index])
      ) {
        return;
      }
      await this.options.onCommit(session.node, nextTags, previousTags);
    }

    closeForNode(node) {
      if (this.session?.node === node) this.close();
    }

    refresh() {
      if (this.session) this.renderOptions(this.session);
    }

    close() {
      const session = this.session;
      if (!session) return;
      document.removeEventListener("pointerdown", session.outsideHandler, true);
      session.editor.remove();
      this.session = null;
    }
  }

  return Object.freeze({ TagEditor });
});

"use strict";

(function exposeFolderPicker(root, factory) {
  const picker = factory();
  if (typeof module === "object" && module.exports) module.exports = picker;
  root.BirdViewFolderPicker = picker;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const MAX_FOLDER_OPTIONS = 80;
  const FOLDER_COLLATOR = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });

  class FolderPicker {
    constructor(options) {
      this.options = options;
      this.session = null;
    }

    open(node, anchor, folders) {
      this.close();
      const entries = createFolderEntries(folders);
      if (!entries.length) {
        this.options.onEmpty?.(node);
        return false;
      }

      const editor = document.createElement("div");
      const heading = document.createElement("div");
      const input = document.createElement("input");
      const options = document.createElement("div");
      const footer = document.createElement("div");
      const cancel = document.createElement("button");
      const session = {
        node,
        anchor,
        editor,
        input,
        options,
        entries,
        actions: [],
        activeIndex: 0,
        outsideHandler: null,
      };

      editor.className = "tag-editor folder-picker";
      editor.setAttribute("role", "dialog");
      editor.setAttribute("aria-label", `將 ${node.item?.name || "素材"} 加入資料夾`);
      heading.className = "tag-editor-heading";
      heading.textContent = "加入資料夾";
      input.className = "tag-editor-search";
      input.type = "search";
      input.placeholder = "搜尋資料夾";
      input.setAttribute("aria-label", "搜尋資料夾");
      options.className = "tag-editor-options";
      footer.className = "tag-editor-footer";
      cancel.className = "tag-editor-button";
      cancel.type = "button";
      cancel.textContent = "取消";

      input.addEventListener("input", () => {
        session.activeIndex = 0;
        this.renderOptions(session);
      });
      input.addEventListener("keydown", (event) => this.handleKeyDown(event, session));
      cancel.addEventListener("click", () => this.close());
      editor.addEventListener("pointerdown", (event) => event.stopPropagation());
      footer.append(cancel);
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
      const query = session.input.value.trim().toLocaleLowerCase();
      const entries = session.entries
        .filter((entry) => !query || entry.searchText.includes(query))
        .sort((first, second) => FOLDER_COLLATOR.compare(first.path, second.path))
        .slice(0, MAX_FOLDER_OPTIONS);
      session.options.replaceChildren();
      session.actions = [];

      for (const entry of entries) this.appendFolderOption(session, entry);
      if (!session.options.childElementCount) {
        const empty = document.createElement("div");
        empty.className = "tag-editor-empty";
        empty.textContent = query ? "沒有符合的資料夾" : "沒有可用的資料夾";
        session.options.append(empty);
      }
      session.activeIndex = Math.min(
        session.activeIndex,
        Math.max(0, session.actions.length - 1),
      );
      this.updateSelection(session);
    }

    appendFolderOption(session, entry) {
      const option = document.createElement("button");
      const path = document.createElement("span");
      option.className = "tag-editor-option folder-picker-option";
      option.type = "button";
      option.title = entry.path;
      path.className = "folder-picker-path";
      path.textContent = entry.path;
      option.append(path);

      const activate = () => {
        if (this.session !== session) return;
        this.close();
        void this.options.onSelect(session.node, entry.folder);
      };
      option.addEventListener("click", activate);
      session.options.append(option);
      session.actions.push({ element: option, activate });
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

    closeForNode(node) {
      if (this.session?.node === node) this.close();
    }

    close() {
      const session = this.session;
      if (!session) return;
      document.removeEventListener("pointerdown", session.outsideHandler, true);
      session.editor.remove();
      this.session = null;
    }
  }

  function createFolderEntries(folders) {
    const byId = new Map();
    const visit = (folder, parentId = "") => {
      const id = String(folder?.id || "").trim();
      if (!id || byId.has(id)) return;
      byId.set(id, {
        folder,
        id,
        name: String(folder?.name || "").trim() || "未命名資料夾",
        parentId: String(folder?.parent || parentId || "").trim(),
      });
      for (const child of folder?.children || []) visit(child, id);
    };
    for (const folder of folders || []) visit(folder);

    const pathCache = new Map();
    const getPath = (id, visiting = new Set()) => {
      if (pathCache.has(id)) return pathCache.get(id);
      const entry = byId.get(id);
      if (!entry || visiting.has(id)) return "";
      visiting.add(id);
      const parentPath = entry.parentId ? getPath(entry.parentId, visiting) : "";
      visiting.delete(id);
      const path = parentPath ? `${parentPath} / ${entry.name}` : entry.name;
      pathCache.set(id, path);
      return path;
    };

    return [...byId.values()].map((entry) => {
      const path = getPath(entry.id);
      return {
        folder: entry.folder,
        path,
        searchText: path.toLocaleLowerCase(),
      };
    });
  }

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
  }

  return Object.freeze({ FolderPicker, createFolderEntries });
});

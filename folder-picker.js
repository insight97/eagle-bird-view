"use strict";

(function exposeFolderPicker(root, factory) {
  const hasCommonJS = typeof module === "object" && module.exports;
  const popover =
    root.BirdViewPopover ||
    (hasCommonJS && typeof require === "function" ? require("./anchored-popover.js") : null);
  const picker = factory(popover);
  if (hasCommonJS) module.exports = picker;
  root.BirdViewFolderPicker = picker;
})(typeof globalThis === "object" ? globalThis : this, (popover) => {
  const { AnchoredPopover } = popover;
  const MAX_FOLDER_OPTIONS = 80;
  const FOLDER_COLLATOR = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });

  class FolderPicker extends AnchoredPopover {
    open(node, anchor, folders) {
      this.close();
      const entries = createFolderEntries(folders);
      if (!entries.length) {
        this.options.onEmpty?.(node);
        return false;
      }

      this.mount(node, anchor, {
        className: "tag-editor folder-picker",
        ariaLabel: `將 ${node.item?.name || "素材"} 加入資料夾`,
        heading: "加入資料夾",
        placeholder: "搜尋資料夾",
        extra: { entries },
        buttons: [{ label: "取消", onClick: () => this.close() }],
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
        .filter((entry) => !query || entry.searchText.includes(query))
        .sort((first, second) => FOLDER_COLLATOR.compare(first.path, second.path))
        .slice(0, MAX_FOLDER_OPTIONS);
      this.resetOptions(session);

      for (const entry of entries) this.appendFolderOption(session, entry);
      if (!session.actions.length) {
        this.appendEmptyMessage(session, query ? "沒有符合的資料夾" : "沒有可用的資料夾");
      }
      this.commitOptions(session);
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

      this.appendAction(session, option, () => {
        if (this.session !== session) return;
        this.close();
        void this.options.onSelect(session.node, entry.folder);
      });
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

  return Object.freeze({ FolderPicker, createFolderEntries });
});

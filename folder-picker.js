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

      this.options.onSelectNode?.(node);
      this.mount(node, anchor, {
        className: "tag-editor folder-picker",
        ariaLabel: `編輯 ${node.item?.name || "素材"} 的資料夾`,
        heading: "編輯資料夾",
        placeholder: "搜尋資料夾",
        extra: { entries, selected: new Set(normalizeFolderIds(node.item?.folders)) },
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
      const entries = session.entries
        .filter((entry) => !query || entry.searchText.includes(query))
        .sort((first, second) => {
          if (!query) {
            const selectedDifference =
              Number(session.selected.has(second.id)) - Number(session.selected.has(first.id));
            if (selectedDifference) return selectedDifference;
          }
          return FOLDER_COLLATOR.compare(first.path, second.path);
        })
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
      const marker = document.createElement("span");
      const path = document.createElement("span");
      const isSelected = session.selected.has(entry.id);
      option.className = "tag-editor-option folder-picker-option";
      option.type = "button";
      option.setAttribute("aria-pressed", String(isSelected));
      option.title = entry.path;
      marker.className = "tag-editor-check";
      marker.textContent = isSelected ? "✓" : "";
      path.className = "folder-picker-path";
      path.textContent = entry.path;
      option.append(marker, path);

      this.appendAction(session, option, () => {
        if (this.session !== session) return;
        if (session.selected.has(entry.id)) session.selected.delete(entry.id);
        else session.selected.add(entry.id);
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
      const previousFolders = normalizeFolderIds(session.node.item?.folders);
      const nextFolders = [...session.selected];
      this.close();
      if (
        previousFolders.length === nextFolders.length &&
        previousFolders.every((folderId, index) => folderId === nextFolders[index])
      ) {
        return;
      }
      await this.options.onCommit?.(session.node, nextFolders, previousFolders);
    }
  }

  function normalizeFolderIds(folders) {
    return [
      ...new Set(
        (Array.isArray(folders) ? folders : [])
          .map((folderId) => String(folderId || "").trim())
          .filter(Boolean),
      ),
    ];
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
        id: entry.id,
        path,
        searchText: path.toLocaleLowerCase(),
      };
    });
  }

  return Object.freeze({ FolderPicker, createFolderEntries });
});

"use strict";

(function exposeBirdViewFolderBrowser(root, factory) {
  const browser = factory();
  if (typeof module === "object" && module.exports) module.exports = browser;
  root.BirdViewFolderBrowser = browser;
})(typeof globalThis === "object" ? globalThis : this, () => {
  function createFolderBrowser({ document, elements, onSelect }) {
    let folders = [];
    let isOpen = false;
    const expandedFolderIds = new Set();

    elements.toggle?.addEventListener("click", toggle);

    function toggle() {
      isOpen = !isOpen;
      updateOpenState();
    }
    elements.search?.addEventListener("input", render);

    function setFolders(nextFolders) {
      folders = normalizeFolderTree(nextFolders);
      render();
    }

    function setLoading(isLoading, message = "") {
      if (elements.status) {
        setStatusText(isLoading ? "正在載入資料夾…" : message);
      }
      if (elements.tree) elements.tree.setAttribute("aria-busy", String(isLoading));
    }

    function setStatus(message) {
      setStatusText(message);
    }

    function setStatusText(message) {
      if (!elements.status) return;
      elements.status.textContent = message;
      elements.status.title = message;
    }

    function render() {
      if (!elements.tree) return;
      const query = String(elements.search?.value || "").trim().toLocaleLowerCase();
      const visibleFolders = filterFolders(folders, query);
      elements.tree.replaceChildren(...visibleFolders.map((folder) => renderFolder(folder, 0)));
      if (elements.status && !elements.status.textContent.includes("載入")) {
        setStatusText(query
          ? visibleFolders.length
            ? ""
            : "找不到符合的資料夾。"
          : folders.length
            ? "選取資料夾後，白板只顯示該資料夾內容。"
            : "目前沒有可用的資料夾。");
      }
    }

    function renderFolder(folder, depth) {
      const row = document.createElement("div");
      row.className = "folder-browser-row";
      row.style.setProperty("--folder-depth", String(depth));
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-level", String(depth + 1));

      const children = Array.isArray(folder.children) ? folder.children : [];
      const entry = document.createElement("div");
      entry.className = "folder-browser-entry";

      if (children.length) {
        const disclosure = document.createElement("button");
        const isExpanded =
          String(elements.search?.value || "").trim() || expandedFolderIds.has(folder.id);
        disclosure.type = "button";
        disclosure.className = "folder-browser-disclosure";
        disclosure.classList.toggle("is-expanded", Boolean(isExpanded));
        disclosure.setAttribute("aria-expanded", String(Boolean(isExpanded)));
        disclosure.setAttribute(
          "aria-label",
          `${isExpanded ? "收合" : "展開"}「${folder.name}」子資料夾`,
        );
        disclosure.title = disclosure.getAttribute("aria-label");
        disclosure.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (expandedFolderIds.has(folder.id)) expandedFolderIds.delete(folder.id);
          else expandedFolderIds.add(folder.id);
          render();
        });
        entry.append(disclosure);
      } else {
        const spacer = document.createElement("span");
        spacer.className = "folder-browser-disclosure-spacer";
        spacer.setAttribute("aria-hidden", "true");
        entry.append(spacer);
      }

      const button = document.createElement("button");
      button.type = "button";
      button.className = "folder-browser-item";
      button.dataset.folderId = String(folder.id);
      button.title = `載入「${folder.name}」並取代白板內容`;
      button.setAttribute("aria-label", button.title);
      button.textContent = folder.name;
      button.addEventListener("click", () => {
        onSelect?.({
          folder,
          includeSubfolders: elements.includeSubfolders?.checked !== false,
        });
      });
      entry.append(button);
      row.append(entry);

      const isExpanded =
        String(elements.search?.value || "").trim() || expandedFolderIds.has(folder.id);
      if (children.length && isExpanded) {
        const childGroup = document.createElement("div");
        childGroup.className = "folder-browser-children";
        childGroup.setAttribute("role", "group");
        childGroup.append(...children.map((child) => renderFolder(child, depth + 1)));
        row.append(childGroup);
      }
      return row;
    }

    function updateOpenState() {
      elements.root?.classList.toggle("is-open", isOpen);
      elements.toggle?.setAttribute("aria-expanded", String(isOpen));
      elements.toggle?.setAttribute(
        "aria-label",
        isOpen ? "收合資料夾側欄" : "開啟資料夾側欄",
      );
      elements.toggle?.setAttribute("title", isOpen ? "收合資料夾側欄" : "開啟資料夾側欄");
    }

    updateOpenState();
    render();

    return Object.freeze({ setFolders, setLoading, setStatus, toggle });
  }

  function filterFolders(source, query) {
    const visited = new Set();

    function visit(folder) {
      const id = String(folder?.id || "").trim();
      if (!id || visited.has(id)) return null;
      visited.add(id);
      const children = (folder.children || []).map(visit).filter(Boolean);
      const name = folder.name;
      if (!query || name.toLocaleLowerCase().includes(query) || children.length) {
        return { id, name, children };
      }
      return null;
    }

    return source.map(visit).filter(Boolean);
  }

  // Eagle returns Folder instances. Keep a small, explicit view model at this
  // boundary so getters and non-enumerable properties such as `id` are not
  // lost by object spread or other serialization-like operations.
  function normalizeFolderTree(source) {
    const visited = new Set();

    function visit(folder) {
      const id = String(folder?.id || "").trim();
      if (!id || visited.has(id)) return null;
      visited.add(id);
      const name = String(folder?.name || "").trim() || "未命名資料夾";
      const children = (Array.isArray(folder?.children) ? folder.children : [])
        .map(visit)
        .filter(Boolean);
      return { id, name, children };
    }

    return (Array.isArray(source) ? source : []).map(visit).filter(Boolean);
  }

  return Object.freeze({ createFolderBrowser });
});

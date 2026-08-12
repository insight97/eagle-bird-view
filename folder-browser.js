"use strict";

(function exposeBirdViewFolderBrowser(root, factory) {
  const browser = factory();
  if (typeof module === "object" && module.exports) module.exports = browser;
  root.BirdViewFolderBrowser = browser;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const DEFAULT_FOLDER_ICON = "📁";
  const FOLDER_ICON_SVG =
    '<svg viewBox="0 0 24 24" focusable="false"><path fill="currentColor" d="M10 4H4c-1.11 0-1.99.89-1.99 2L2 18c0 1.1.89 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" /></svg>';
  const FOLDER_ICON_COLORS = Object.freeze({
    red: "#e56b6f",
    orange: "#e99045",
    yellow: "#d4ad42",
    green: "#64b879",
    aqua: "#4db7b3",
    blue: "#5d91d8",
    purple: "#8b7bd8",
    pink: "#d978a6",
  });
  const SOURCE_TYPES = Object.freeze(["folder", "tag", "extension"]);
  const TAG_SORT_MODES = Object.freeze(["alphabetical", "grouped"]);
  const LABEL_COLLATOR = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });

  function createFolderBrowser({ document, elements, onSelect }) {
    let folders = [];
    let tags = [];
    let tagGroups = [];
    let fileTypes = [];
    let isOpen = false;
    let activeType = "folder";
    let tagSortMode = "alphabetical";
    let selectedTarget = { type: "", value: "" };
    let isLoading = false;
    let statusMessage = "";
    const expandedFolderIds = new Set();

    elements.toggle?.addEventListener("click", toggle);
    elements.folderTab?.addEventListener("click", () => setActiveType("folder"));
    elements.tagTab?.addEventListener("click", () => setActiveType("tag"));
    elements.extensionTab?.addEventListener("click", () => setActiveType("extension"));
    elements.search?.addEventListener("input", () => {
      if (!isLoading) statusMessage = "";
      renderFolders();
      renderStatus();
    });
    elements.includeSubfolders?.addEventListener("change", renderFolders);
    elements.tagSearch?.addEventListener("input", () => {
      if (!isLoading) statusMessage = "";
      renderTags();
      renderStatus();
    });
    elements.tagSort?.addEventListener("change", () => {
      const requestedMode = normalizeTagSortMode(elements.tagSort.value);
      tagSortMode = requestedMode === "grouped" && tagGroups.length
        ? "grouped"
        : "alphabetical";
      updateTagSortState();
      renderTags();
      renderStatus();
    });

    function toggle() {
      isOpen = !isOpen;
      updateOpenState();
    }

    function setActiveType(type) {
      if (!SOURCE_TYPES.includes(type) || type === activeType) return;
      activeType = type;
      if (!isLoading) statusMessage = "";
      renderSourceState();
      renderStatus();
    }

    function setFolders(nextFolders) {
      folders = normalizeFolderTree(nextFolders);
      if (
        selectedTarget.type === "folder" &&
        !containsFolder(folders, selectedTarget.value)
      ) {
        selectedTarget = { type: "", value: "" };
      }
      renderFolders();
      renderStatus();
    }

    function setTags(nextTags, nextTagGroups = []) {
      tags = normalizeTagEntries(nextTags);
      tagGroups = normalizeTagGroups(nextTagGroups);
      if (!tagGroups.length) tagSortMode = "alphabetical";
      if (
        selectedTarget.type === "tag" &&
        !tags.some(({ name }) => name === selectedTarget.value)
      ) {
        selectedTarget = { type: "", value: "" };
      }
      updateTagSortState();
      renderTags();
      renderStatus();
    }

    function setFileTypes(nextFileTypes) {
      fileTypes = normalizeFileTypes(nextFileTypes);
      if (
        selectedTarget.type === "extension" &&
        !fileTypes.some(({ value }) => value === selectedTarget.value)
      ) {
        selectedTarget = { type: "", value: "" };
      }
      renderFileTypes();
      renderStatus();
    }

    function setSelectedTarget(target = {}) {
      const type = SOURCE_TYPES.includes(target.type) ? target.type : "";
      const value = normalizeTargetValue(type, target.value);
      selectedTarget = type && value ? { type, value } : { type: "", value: "" };
      if (selectedTarget.type) activeType = selectedTarget.type;
      renderSourceState();
      renderFolders();
      renderTags();
      renderFileTypes();
    }

    function setLoading(nextValue, message = "") {
      const nextLoading = Boolean(nextValue);
      isLoading = nextLoading;
      statusMessage = nextLoading
        ? message || `正在載入${getSourceLabel(activeType)}…`
        : message;
      for (const list of [elements.tree, elements.tagList, elements.extensionList]) {
        list?.setAttribute("aria-busy", String(nextLoading));
      }
      renderStatus();
    }

    function setStatus(message) {
      statusMessage = String(message || "");
      renderStatus();
    }

    function setStatusText(message) {
      if (!elements.status) return;
      elements.status.textContent = message;
      elements.status.title = message;
    }

    function renderFolders() {
      if (!elements.tree) return;
      const query = String(elements.search?.value || "").trim().toLocaleLowerCase();
      const visibleFolders = filterFolders(folders, query);
      elements.tree.replaceChildren(...visibleFolders.map((folder) => renderFolder(folder, 0)));
    }

    function renderFolder(folder, depth) {
      const row = document.createElement("div");
      row.className = "folder-browser-row";
      row.style.setProperty("--folder-depth", String(depth));
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-level", String(depth + 1));
      const isSelected =
        selectedTarget.type === "folder" && String(folder.id) === selectedTarget.value;
      row.setAttribute("aria-selected", String(isSelected));

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
          renderFolders();
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
      button.classList.toggle("is-selected", isSelected);
      button.dataset.folderId = String(folder.id);
      if (folder.iconColor) {
        button.style.setProperty("--folder-icon-color", folder.iconColor);
      }
      const count = elements.includeSubfolders?.checked !== false
        ? folder.recursiveCount ?? folder.count
        : folder.count;
      const countLabel = count === null || count === undefined ? "" : `（${count} 個素材）`;
      button.title = `載入「${folder.name}」${countLabel}並取代白板內容`;
      button.setAttribute("aria-label", button.title);
      const icon = document.createElement("span");
      icon.className = "folder-browser-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = FOLDER_ICON_SVG;
      const label = document.createElement("span");
      label.className = "folder-browser-label";
      label.textContent = folder.name;
      button.append(icon, label);
      appendCount(button, count);
      button.addEventListener("click", () => {
        selectedTarget = { type: "folder", value: String(folder.id) };
        statusMessage = "";
        renderFolders();
        onSelect?.({
          type: "folder",
          value: String(folder.id),
          label: folder.name,
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

    function renderTags() {
      if (!elements.tagList) return;
      const query = String(elements.tagSearch?.value || "").trim().toLocaleLowerCase();
      const visibleTags = tags
        .filter(({ searchText }) => !query || searchText.includes(query))
        .sort(compareTags);
      if (tagSortMode === "grouped" && tagGroups.length) {
        elements.tagList.replaceChildren(
          ...groupTags(visibleTags, tagGroups).map(renderTagGroup),
        );
        return;
      }
      elements.tagList.replaceChildren(
        ...visibleTags.map((tag) =>
          renderTagItem(tag),
        ),
      );
    }

    function renderTagGroup(group) {
      const section = document.createElement("section");
      section.className = "folder-browser-tag-group";
      section.setAttribute("role", "group");
      section.setAttribute("aria-label", group.name);

      const heading = document.createElement("div");
      heading.className = "folder-browser-tag-group-heading";
      heading.textContent = group.name;
      section.append(heading, ...group.tags.map(renderTagItem));
      return section;
    }

    function renderTagItem(tag) {
      return renderTargetItem({
        type: "tag",
        value: tag.name,
        label: tag.name,
        icon: "#",
        color: tag.color,
        count: tag.count,
      });
    }

    function renderFileTypes() {
      if (!elements.extensionList) return;
      elements.extensionList.replaceChildren(
        ...fileTypes.map((fileType) =>
          renderTargetItem({
            type: "extension",
            value: fileType.value,
            label: fileType.label,
            icon: fileType.value.slice(0, 3).toUpperCase(),
            count: fileType.count,
          }),
        ),
      );
    }

    function renderTargetItem({ type, value, label, icon, color = "", count = null }) {
      const button = document.createElement("button");
      const isSelected = selectedTarget.type === type && selectedTarget.value === value;
      button.type = "button";
      button.className = "folder-browser-item folder-browser-target-item";
      button.classList.toggle("is-selected", isSelected);
      button.dataset.type = type;
      button.dataset.value = value;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(isSelected));
      const countLabel = count === null || count === undefined ? "" : `（${count} 個素材）`;
      button.title = `載入「${label}」${countLabel}並取代白板內容`;
      button.setAttribute("aria-label", button.title);

      const iconElement = document.createElement("span");
      iconElement.className = `folder-browser-icon folder-browser-${type}-icon`;
      iconElement.textContent = icon;
      iconElement.setAttribute("aria-hidden", "true");
      if (color) iconElement.style.setProperty("--library-source-color", color);

      const labelElement = document.createElement("span");
      labelElement.className = "folder-browser-label";
      labelElement.textContent = label;
      button.append(iconElement, labelElement);
      appendCount(button, count);
      button.addEventListener("click", () => {
        selectedTarget = { type, value };
        statusMessage = "";
        renderTags();
        renderFileTypes();
        renderFolders();
        onSelect?.({ type, value, label });
      });
      return button;
    }

    function appendCount(target, count) {
      if (count === null || count === undefined) return;
      const countElement = document.createElement("span");
      countElement.className = "folder-browser-count";
      countElement.textContent = `(${count})`;
      countElement.setAttribute("aria-hidden", "true");
      target.append(countElement);
    }

    function renderSourceState() {
      const entries = [
        ["folder", elements.folderTab, elements.folderPanel],
        ["tag", elements.tagTab, elements.tagPanel],
        ["extension", elements.extensionTab, elements.extensionPanel],
      ];
      for (const [type, tab, panel] of entries) {
        const isActive = type === activeType;
        if (tab) {
          tab.classList.toggle("is-active", isActive);
          tab.setAttribute("aria-selected", String(isActive));
        }
        if (panel) panel.hidden = !isActive;
      }
    }

    function renderStatus() {
      if (!elements.status) return;
      if (isLoading || statusMessage) {
        setStatusText(statusMessage);
        return;
      }

      if (activeType === "tag") {
        const query = String(elements.tagSearch?.value || "").trim().toLocaleLowerCase();
        const hasMatch = tags.some(({ searchText }) => !query || searchText.includes(query));
        setStatusText(
          query && !hasMatch
            ? "找不到符合的 Tag。"
            : tags.length
              ? "選取 Tag 後，白板只顯示含有該 Tag 的素材。"
              : "目前沒有可用的 Tag。",
        );
        return;
      }

      if (activeType === "extension") {
        setStatusText(
          fileTypes.length
            ? "選取檔案類型後，白板只顯示該副檔名素材。"
            : "目前沒有可用的檔案類型。",
        );
        return;
      }

      const query = String(elements.search?.value || "").trim().toLocaleLowerCase();
      const hasMatch = filterFolders(folders, query).length > 0;
      setStatusText(
        query && !hasMatch
          ? "找不到符合的資料夾。"
          : folders.length
            ? "選取資料夾後，白板只顯示該資料夾內容。"
            : "目前沒有可用的資料夾。",
      );
    }

    function updateOpenState() {
      elements.root?.classList.toggle("is-open", isOpen);
      elements.toggle?.setAttribute("aria-expanded", String(isOpen));
      elements.toggle?.setAttribute(
        "aria-label",
        isOpen ? "收合素材來源側欄" : "開啟素材來源側欄",
      );
      elements.toggle?.setAttribute(
        "title",
        isOpen ? "收合素材來源側欄" : "開啟素材來源側欄",
      );
    }

    function updateTagSortState() {
      if (!elements.tagSort) return;
      elements.tagSort.hidden = tagGroups.length === 0;
      elements.tagSort.value = tagSortMode;
    }

    updateOpenState();
    updateTagSortState();
    renderSourceState();
    renderFolders();
    renderTags();
    renderFileTypes();
    renderStatus();

    return Object.freeze({
      setFileTypes,
      setFolders,
      setLoading,
      setSelectedTarget,
      setStatus,
      setTags,
      toggle,
    });
  }

  function getSourceLabel(type) {
    if (type === "tag") return " Tag";
    if (type === "extension") return "檔案類型";
    return "資料夾";
  }

  function normalizeTargetValue(type, value) {
    const normalized = String(value || "").trim();
    return type === "extension" ? normalized.replace(/^\./, "").toLowerCase() : normalized;
  }

  function normalizeTagEntries(source) {
    const names = new Set();
    const entries = [];
    for (const tag of Array.isArray(source) ? source : []) {
      const name = String(tag?.name || tag || "").trim();
      if (!name || names.has(name)) continue;
      names.add(name);
      entries.push({
        name,
        color: String(tag?.color || "").trim(),
        count: normalizeCount(tag?.count),
        groups: normalizeStringList(tag?.groups),
        searchText: name.toLocaleLowerCase(),
      });
    }
    return entries;
  }

  function normalizeFileTypes(source) {
    const values = new Set();
    const entries = [];
    for (const fileType of Array.isArray(source) ? source : []) {
      const value = normalizeTargetValue("extension", fileType?.value || fileType);
      if (!value || values.has(value)) continue;
      const count = normalizeCount(fileType?.count);
      if (count === 0) continue;
      values.add(value);
      entries.push({
        value,
        label: String(fileType?.label || value.toUpperCase()).trim(),
        count,
      });
    }
    return entries.sort((left, right) => compareLabels(left.value, right.value));
  }

  function normalizeTagGroups(source) {
    const ids = new Set();
    const entries = [];
    for (const group of Array.isArray(source) ? source : []) {
      const id = String(group?.id || "").trim();
      const name = String(group?.name || "").trim();
      if (!id || !name || ids.has(id)) continue;
      ids.add(id);
      entries.push({ id, name, tags: normalizeStringList(group?.tags) });
    }
    return entries;
  }

  function normalizeCount(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
  }

  function normalizeStringList(source) {
    const values = new Set();
    for (const value of Array.isArray(source) ? source : []) {
      const normalized = String(value || "").trim();
      if (normalized) values.add(normalized);
    }
    return [...values];
  }

  function normalizeTagSortMode(value) {
    const normalized = String(value || "").trim();
    return TAG_SORT_MODES.includes(normalized) ? normalized : "alphabetical";
  }

  function compareTags(left, right) {
    return compareLabels(left.name, right.name);
  }

  function compareLabels(left, right) {
    const firstResult = LABEL_COLLATOR.compare(String(left), String(right));
    return firstResult || String(left).localeCompare(String(right));
  }

  function groupTags(tags, groups) {
    const tagsByName = new Map(tags.map((tag) => [tag.name, tag]));
    const groupedNames = new Set();
    const entries = [];

    for (const group of groups) {
      const groupTags = [];
      const names = new Set();
      for (const name of group.tags) {
        const tag = tagsByName.get(name);
        if (!tag || names.has(name)) continue;
        names.add(name);
        groupedNames.add(name);
        groupTags.push(tag);
      }
      for (const tag of tags) {
        if (names.has(tag.name) || !tag.groups.includes(group.id)) continue;
        names.add(tag.name);
        groupedNames.add(tag.name);
        groupTags.push(tag);
      }
      if (groupTags.length) entries.push({ name: group.name, tags: groupTags });
    }

    const ungrouped = tags.filter((tag) => !groupedNames.has(tag.name));
    if (ungrouped.length) entries.push({ name: "未分組", tags: ungrouped });
    return entries;
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
        const filtered = { id, name, icon: folder.icon, iconColor: folder.iconColor, children };
        if (folder.count !== undefined) filtered.count = folder.count;
        if (folder.recursiveCount !== undefined) {
          filtered.recursiveCount = folder.recursiveCount;
        }
        return filtered;
      }
      return null;
    }

    return source.map(visit).filter(Boolean);
  }

  function containsFolder(source, folderId) {
    return source.some(
      (folder) => String(folder.id) === folderId || containsFolder(folder.children || [], folderId),
    );
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
      const icon = String(folder?.icon || "").trim() || DEFAULT_FOLDER_ICON;
      const iconColor = normalizeFolderIconColor(folder?.iconColor);
      const children = (Array.isArray(folder?.children) ? folder.children : [])
        .map(visit)
        .filter(Boolean);
      const normalized = { id, name, icon, iconColor, children };
      const count = normalizeCount(folder?.count);
      const recursiveCount = normalizeCount(folder?.recursiveCount);
      if (count !== null) normalized.count = count;
      if (recursiveCount !== null) normalized.recursiveCount = recursiveCount;
      return normalized;
    }

    return (Array.isArray(source) ? source : []).map(visit).filter(Boolean);
  }

  function normalizeFolderIconColor(value) {
    return FOLDER_ICON_COLORS[String(value || "").trim().toLowerCase()] || "";
  }

  return Object.freeze({ createFolderBrowser });
});

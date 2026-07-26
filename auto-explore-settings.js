"use strict";

(function exposeBirdViewAutoExploreSettings(root, factory) {
  const core =
    root.BirdViewCore ||
    (typeof module === "object" && typeof require === "function"
      ? require("./bird-view-core.js")
      : null);
  const exploration =
    root.BirdViewExploration ||
    (typeof module === "object" && typeof require === "function"
      ? require("./exploration-source.js")
      : null);
  const settings = factory(core, exploration, root);
  if (typeof module === "object" && module.exports) module.exports = settings;
  root.BirdViewAutoExploreSettings = settings;
})(typeof globalThis === "object" ? globalThis : this, (core, exploration, root) => {
  const { normalizeTags } = core;
  const {
    DEFAULT_UNRATED_FILTER,
    normalizeUnratedFilter,
    unratedFiltersEqual,
  } = exploration;

  function createAutoExploreSettings(options = {}) {
    const {
      document: documentRef = root.document,
      elements = {},
      defaultFilter = DEFAULT_UNRATED_FILTER,
      normalizeFilter = normalizeUnratedFilter,
      filtersEqual = unratedFiltersEqual,
      normalizeTagValues = normalizeTags,
      getKnownTags = () => [],
      getKnownFolders = () => [],
      createTagChip = (tag) => {
        const chip = documentRef.createElement("span");
        chip.textContent = tag;
        return chip;
      },
      createFolderChip = (folder) => {
        const chip = documentRef.createElement("span");
        chip.textContent = folder?.label || folder?.name || folder?.id || "";
        return chip;
      },
      onFilterChange = () => {},
      onReset = () => {},
    } = options;

    let committedFilter = normalizeFilter(defaultFilter);
    let draftFilter = null;

    function getFilter() {
      return normalizeFilter(committedFilter);
    }

    function setFilter(filter) {
      committedFilter = normalizeFilter(filter);
      if (draftFilter) draftFilter = normalizeFilter(committedFilter);
      update();
    }

    function open() {
      draftFilter = normalizeFilter(committedFilter);
      if (elements.autoExploreTagSearch) elements.autoExploreTagSearch.value = "";
      if (elements.autoExploreExcludedTagSearch) {
        elements.autoExploreExcludedTagSearch.value = "";
      }
      if (elements.autoExploreFolderSearch) elements.autoExploreFolderSearch.value = "";
      update();
      if (elements.autoExploreSettingsPanel) {
        elements.autoExploreSettingsPanel.hidden = false;
        elements.autoExploreSettingsPanel.removeAttribute("hidden");
      }
      elements.autoExploreSettingsButton?.setAttribute("aria-expanded", "true");
    }

    function close() {
      draftFilter = null;
      if (elements.autoExploreSettingsPanel) {
        elements.autoExploreSettingsPanel.hidden = true;
        elements.autoExploreSettingsPanel.setAttribute("hidden", "");
      }
      elements.autoExploreSettingsButton?.setAttribute("aria-expanded", "false");
    }

    function toggle() {
      if (!elements.autoExploreSettingsPanel) return;
      if (elements.autoExploreSettingsPanel.hidden) open();
      else close();
    }

    function apply({ closeAfterApply = true } = {}) {
      if (!draftFilter) return;
      const previous = getFilter();
      const next = normalizeFilter(draftFilter);
      const changed = !filtersEqual(previous, next);
      committedFilter = next;
      if (closeAfterApply) close();
      else draftFilter = normalizeFilter(next);
      update();
      onFilterChange(getFilter(), { previous, changed });
    }

    function update() {
      updateFilterControls();
      renderTagOptions();
    }

    function setActiveTab(tabName, { focus = false } = {}) {
      const tabs = elements.autoExploreSettingsTabs || [];
      const panels = elements.autoExploreSettingsPanels || [];
      if (!tabs.length || !panels.length) return;

      const activeTab = tabs.find((tab) => tab.dataset.settingsTab === tabName) || tabs[0];
      const activeName = activeTab.dataset.settingsTab;
      for (const tab of tabs) {
        const isActive = tab === activeTab;
        tab.classList.toggle("is-active", isActive);
        tab.setAttribute("aria-selected", String(isActive));
        tab.setAttribute("tabindex", isActive ? "0" : "-1");
      }
      for (const panel of panels) {
        const isActive = panel.dataset.settingsPanel === activeName;
        panel.hidden = !isActive;
        panel.setAttribute("aria-hidden", String(!isActive));
      }
      if (focus) activeTab.focus();
    }

    function handleTabKeyDown(event) {
      const tabs = elements.autoExploreSettingsTabs || [];
      const currentTab = event.currentTarget || event.target;
      const currentIndex = tabs.indexOf(currentTab);
      if (currentIndex === -1) return;

      let nextIndex = currentIndex;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        nextIndex = (currentIndex + 1) % tabs.length;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = tabs.length - 1;
      } else {
        return;
      }

      event.preventDefault();
      setActiveTab(tabs[nextIndex].dataset.settingsTab, { focus: true });
    }

    function updateDraftFileTypes(event) {
      if (!draftFilter) return;
      const fileTypes = [
        ["image", elements.autoExploreFileTypeImage],
        ["video", elements.autoExploreFileTypeVideo],
      ]
        .filter(([, input]) => input?.checked)
        .map(([fileType]) => fileType);
      if (!fileTypes.length) {
        event.target.checked = true;
        return;
      }
      draftFilter.fileTypes = fileTypes;
      apply({ closeAfterApply: false });
    }

    function updateDraftRating(event) {
      if (!draftFilter) return;
      draftFilter.rating = event.target.value;
      if (event.target.value !== "any") {
        draftFilter.minRating = null;
        draftFilter.maxRating = null;
      }
      apply({ closeAfterApply: false });
    }

    function updateDraftTagMatch(event) {
      if (!draftFilter) return;
      draftFilter.tagMatch = event.target.value;
      apply({ closeAfterApply: false });
    }

    function updateDraftTagGroupMatch(event) {
      if (!draftFilter) return;
      draftFilter.tagGroupMatch = event.target.value;
      apply({ closeAfterApply: false });
    }

    function updateDraftRatingRange(event, key) {
      if (!draftFilter) return;
      draftFilter = {
        ...draftFilter,
        rating: "any",
        [key]: event.target.value === "" ? null : Number(event.target.value),
      };
      apply({ closeAfterApply: false });
    }

    function updateDraftFolderMatch(event) {
      if (!draftFilter) return;
      draftFilter.folderMatch = event.target.value;
      apply({ closeAfterApply: false });
    }

    function updateDraftIncludeSubfolders(event) {
      if (!draftFilter) return;
      draftFilter.includeSubfolders = Boolean(event.target.checked);
      apply({ closeAfterApply: false });
    }

    function addTagGroup() {
      const draft = draftFilter || normalizeFilter(committedFilter);
      draftFilter = {
        ...draft,
        tagGroups: [...(draft.tagGroups || []), { tags: [], match: "all" }],
      };
      apply({ closeAfterApply: false });
    }

    function updateDraftMaxTagCount(event) {
      if (!draftFilter) return;
      const value = Number(event.target.value);
      draftFilter.maxTagCount = Number.isInteger(value) && value >= 1 ? value : null;
      apply({ closeAfterApply: false });
    }

    function handleTagSearchKeyDown(event, optionsElement) {
      if (event.key !== "Enter") return;
      const firstOption = optionsElement?.querySelector("button");
      if (!firstOption) return;
      event.preventDefault();
      firstOption.click();
    }

    function reset() {
      draftFilter = normalizeFilter(defaultFilter);
      if (elements.autoExploreTagSearch) elements.autoExploreTagSearch.value = "";
      if (elements.autoExploreExcludedTagSearch) {
        elements.autoExploreExcludedTagSearch.value = "";
      }
      if (elements.autoExploreFolderSearch) elements.autoExploreFolderSearch.value = "";
      apply({ closeAfterApply: false });
      onReset();
    }

    function renderTagOptions() {
      const filter = draftFilter || committedFilter;
      renderTagPicker({
        searchElement: elements.autoExploreTagSearch,
        optionsElement: elements.autoExploreTagOptions,
        selectedElement: elements.autoExploreSelectedTags,
        selectedTags: filter.tags,
        oppositeTags: filter.excludedTags,
        filterKey: "tags",
      });
      renderTagPicker({
        searchElement: elements.autoExploreExcludedTagSearch,
        optionsElement: elements.autoExploreExcludedTagOptions,
        selectedElement: elements.autoExploreSelectedExcludedTags,
        selectedTags: filter.excludedTags,
        oppositeTags: filter.tags,
        filterKey: "excludedTags",
      });
      renderTagGroups(filter);
      renderFolderPicker({
        searchElement: elements.autoExploreFolderSearch,
        optionsElement: elements.autoExploreFolderOptions,
        selectedElement: elements.autoExploreSelectedFolders,
        selectedFolders: filter.folders,
        filterKey: "folders",
      });
    }

    function renderTagGroups(filter) {
      const container = elements.autoExploreTagGroups;
      if (!container) return;
      const groups = Array.isArray(filter.tagGroups) ? filter.tagGroups : [];
      container.replaceChildren(
        ...groups.map((group, index) => {
          const wrapper = documentRef.createElement("div");
          const header = documentRef.createElement("div");
          const title = documentRef.createElement("span");
          const match = documentRef.createElement("select");
          const remove = documentRef.createElement("button");
          const search = documentRef.createElement("input");
          const options = documentRef.createElement("div");
          const selected = documentRef.createElement("div");

          wrapper.className = "auto-explore-tag-group";
          header.className = "auto-explore-tag-group-header";
          title.className = "auto-explore-tag-group-title";
          title.textContent = `群組 ${index + 2}`;
          match.className = "auto-explore-select auto-explore-tag-group-match";
          match.replaceChildren(
            createSelectOption("all", "全部符合"),
            createSelectOption("any", "符合任一"),
          );
          match.value = group.match;
          match.addEventListener("change", (event) => updateTagGroup(index, { match: event.target.value }));
          remove.className = "auto-explore-tag-group-remove";
          remove.type = "button";
          remove.textContent = "移除";
          remove.addEventListener("click", () => removeTagGroup(index));
          header.append(title, match, remove);

          search.className = "auto-explore-tag-search";
          search.type = "search";
          search.placeholder = "搜尋 Tag";
          options.className = "auto-explore-tag-options";
          options.hidden = true;
          selected.className = "auto-explore-selected-tags";
          selected.hidden = true;
          search.addEventListener("input", () => renderTagGroupPicker({ index, search, options, selected }));
          search.addEventListener("keydown", (event) => handleTagSearchKeyDown(event, options));
          wrapper.append(header, search, options, selected);
          renderTagGroupPicker({ index, search, options, selected });
          return wrapper;
        }),
      );
    }

    function renderTagGroupPicker({ index, search, options, selected }) {
      const filter = draftFilter || committedFilter;
      const group = filter.tagGroups?.[index];
      if (!group) return;
      const selectedTags = normalizeTagValues(group.tags);
      const selectedSet = new Set(selectedTags);
      selected.hidden = selectedTags.length === 0;
      selected.replaceChildren(
        ...selectedTags.map((tag) => {
          const remove = documentRef.createElement("button");
          const chip = createTagChip(tag);
          remove.className = "auto-explore-selected-tag";
          remove.type = "button";
          remove.title = `移除 ${tag}`;
          remove.append(chip, createTextNode("×", "auto-explore-selected-tag-remove"));
          remove.addEventListener("click", () => {
            updateTagGroup(index, { tags: selectedTags.filter((value) => value !== tag) });
          });
          return remove;
        }),
      );

      const query = String(search.value || "").trim().toLocaleLowerCase();
      const tags = query
        ? normalizeTagValues(getKnownTags())
            .filter((tag) => !selectedSet.has(tag) && tag.toLocaleLowerCase().includes(query))
            .sort((first, second) => first.localeCompare(second))
        : [];
      options.replaceChildren();
      options.hidden = !query;
      if (!query) return;
      if (!tags.length) {
        const empty = documentRef.createElement("div");
        empty.className = "auto-explore-tag-empty";
        empty.textContent = "找不到符合的 Tag";
        options.append(empty);
        return;
      }
      options.append(
        ...tags.map((tag) => {
          const option = documentRef.createElement("button");
          option.className = "auto-explore-tag-option";
          option.type = "button";
          option.append(createTextNode("+", "tag-editor-check"), createTagChip(tag));
          option.addEventListener("click", () => {
            search.value = "";
            updateTagGroup(index, { tags: [...selectedTags, tag] });
          });
          return option;
        }),
      );
    }

    function updateTagGroup(index, changes) {
      const draft = draftFilter || normalizeFilter(committedFilter);
      const groups = (draft.tagGroups || []).map((group, groupIndex) =>
        groupIndex === index ? { ...group, ...changes } : group,
      );
      draftFilter = { ...draft, tagGroups: groups };
      apply({ closeAfterApply: false });
    }

    function removeTagGroup(index) {
      const draft = draftFilter || normalizeFilter(committedFilter);
      draftFilter = {
        ...draft,
        tagGroups: (draft.tagGroups || []).filter((_, groupIndex) => groupIndex !== index),
      };
      apply({ closeAfterApply: false });
    }

    function renderFolderPicker({
      searchElement,
      optionsElement,
      selectedElement,
      selectedFolders: rawSelectedFolders,
      filterKey,
    }) {
      const selectedFolders = normalizeTagValues(rawSelectedFolders);
      renderSelectedFolders(selectedElement, selectedFolders, filterKey);
      if (!optionsElement) return;

      const query = String(searchElement?.value || "").trim().toLocaleLowerCase();
      const selectedSet = new Set(selectedFolders);
      const folders = query
        ? getKnownFolders()
            .map(normalizeFolderOption)
            .filter(
              (folder) =>
                folder.id &&
                !selectedSet.has(folder.id) &&
                folder.label.toLocaleLowerCase().includes(query),
            )
            .sort((first, second) => first.label.localeCompare(second.label))
        : [];

      if (!folders.length) {
        optionsElement.hidden = true;
        optionsElement.replaceChildren();
        if (!query) return;
        const empty = documentRef.createElement("div");
        empty.className = "auto-explore-tag-empty";
        empty.textContent = "找不到符合的資料夾";
        optionsElement.replaceChildren(empty);
        optionsElement.hidden = false;
        return;
      }

      optionsElement.hidden = false;
      optionsElement.replaceChildren(
        ...folders.map((folder) => {
          const option = documentRef.createElement("button");
          option.className = "auto-explore-tag-option";
          option.type = "button";
          option.title = folder.label;
          option.append(createTextNode("+", "tag-editor-check"), createFolderChip(folder));
          option.addEventListener("click", () => {
            const draft = draftFilter || normalizeFilter(committedFilter);
            const nextFolders = new Set(normalizeTagValues(draft[filterKey]));
            nextFolders.add(folder.id);
            draftFilter = {
              ...draft,
              [filterKey]: [...nextFolders],
            };
            if (searchElement) searchElement.value = "";
            apply({ closeAfterApply: false });
          });
          return option;
        }),
      );
    }

    function renderSelectedFolders(container, folderIds, filterKey) {
      if (!container) return;
      const knownFolders = new Map(
        getKnownFolders().map((folder) => {
          const normalized = normalizeFolderOption(folder);
          return [normalized.id, normalized];
        }),
      );
      container.hidden = folderIds.length === 0;
      container.replaceChildren(
        ...folderIds.map((folderId) => {
          const remove = documentRef.createElement("button");
          const folder = knownFolders.get(folderId) || { id: folderId, label: folderId };
          remove.className = "auto-explore-selected-tag";
          remove.type = "button";
          remove.title = `移除 ${folder.label}`;
          remove.append(createFolderChip(folder), createTextNode("×", "auto-explore-selected-tag-remove"));
          remove.addEventListener("click", () => {
            const draft = draftFilter || normalizeFilter(committedFilter);
            draftFilter = {
              ...draft,
              [filterKey]: normalizeTagValues(draft[filterKey]).filter(
                (value) => value !== folderId,
              ),
            };
            apply({ closeAfterApply: false });
          });
          return remove;
        }),
      );
    }

    function normalizeFolderOption(folder) {
      return {
        id: String(folder?.id || "").trim(),
        label: String(folder?.label || folder?.path || folder?.name || folder?.id || "").trim(),
      };
    }

    function createTextNode(text, className) {
      const node = documentRef.createElement("span");
      node.className = className;
      node.textContent = text;
      return node;
    }

    function createSelectOption(value, label) {
      const option = documentRef.createElement("option");
      option.value = value;
      option.textContent = label;
      return option;
    }

    function renderTagPicker({
      searchElement,
      optionsElement,
      selectedElement,
      selectedTags: rawSelectedTags,
      oppositeTags: rawOppositeTags,
      filterKey,
    }) {
      const selectedTags = normalizeTagValues(rawSelectedTags);
      const oppositeTags = normalizeTagValues(rawOppositeTags);
      renderSelectedTags(selectedElement, selectedTags, filterKey);
      if (!optionsElement) return;

      const query = String(searchElement?.value || "").trim().toLocaleLowerCase();
      const selectedSet = new Set(selectedTags);
      const oppositeSet = new Set(oppositeTags);
      const tags = query
        ? normalizeTagValues(getKnownTags())
            .filter(
              (tag) =>
                !selectedSet.has(tag) &&
                !oppositeSet.has(tag) &&
                tag.toLocaleLowerCase().includes(query),
            )
            .sort((first, second) => first.localeCompare(second))
        : [];

      if (!tags.length) {
        optionsElement.hidden = true;
        optionsElement.replaceChildren();
        if (!query) return;
        const empty = documentRef.createElement("div");
        empty.className = "auto-explore-tag-empty";
        empty.textContent = "找不到符合的 Tag";
        optionsElement.replaceChildren(empty);
        optionsElement.hidden = false;
        return;
      }

      optionsElement.hidden = false;
      optionsElement.replaceChildren(
        ...tags.map((tag) => {
          const option = documentRef.createElement("button");
          const marker = documentRef.createElement("span");
          option.className = "auto-explore-tag-option";
          option.type = "button";
          option.setAttribute("aria-pressed", "false");
          marker.className = "tag-editor-check";
          marker.textContent = "+";
          option.append(marker, createTagChip(tag));
          option.addEventListener("click", () => {
            const draft = draftFilter || normalizeFilter(committedFilter);
            const nextTags = new Set(normalizeTagValues(draft[filterKey]));
            const oppositeKey = filterKey === "tags" ? "excludedTags" : "tags";
            nextTags.add(tag);
            draftFilter = {
              ...draft,
              [filterKey]: [...nextTags],
              [oppositeKey]: normalizeTagValues(draft[oppositeKey]).filter(
                (value) => value !== tag,
              ),
            };
            if (searchElement) searchElement.value = "";
            apply({ closeAfterApply: false });
          });
          return option;
        }),
      );
    }

    function renderSelectedTags(container, tags, filterKey) {
      if (!container) return;
      container.hidden = tags.length === 0;
      container.replaceChildren(
        ...tags.map((tag) => {
          const remove = documentRef.createElement("button");
          const chip = createTagChip(tag);
          const marker = documentRef.createElement("span");
          remove.className = "auto-explore-selected-tag";
          remove.type = "button";
          remove.title = `移除 ${tag}`;
          remove.setAttribute("aria-label", `移除 Tag ${tag}`);
          marker.className = "auto-explore-selected-tag-remove";
          marker.textContent = "×";
          remove.append(chip, marker);
          remove.addEventListener("click", () => {
            const draft = draftFilter || normalizeFilter(committedFilter);
            draftFilter = {
              ...draft,
              [filterKey]: normalizeTagValues(draft[filterKey]).filter(
                (value) => value !== tag,
              ),
            };
            apply({ closeAfterApply: false });
          });
          return remove;
        }),
      );
    }

    function updateFilterControls() {
      const filter = draftFilter || committedFilter;
      const fileTypes = new Set(filter.fileTypes);
      if (elements.autoExploreFileTypeImage) {
        elements.autoExploreFileTypeImage.checked = fileTypes.has("image");
      }
      if (elements.autoExploreFileTypeVideo) {
        elements.autoExploreFileTypeVideo.checked = fileTypes.has("video");
      }
      if (elements.autoExploreRating) {
        elements.autoExploreRating.value = String(filter.rating);
      }
      if (elements.autoExploreMinRating) {
        elements.autoExploreMinRating.value = filter.minRating ?? "";
      }
      if (elements.autoExploreMaxRating) {
        elements.autoExploreMaxRating.value = filter.maxRating ?? "";
      }
      if (elements.autoExploreTagMatch) {
        elements.autoExploreTagMatch.value = filter.tagMatch;
      }
      if (elements.autoExploreTagGroupMatch) {
        elements.autoExploreTagGroupMatch.value = filter.tagGroupMatch;
      }
      if (elements.autoExploreMaxTagCount) {
        elements.autoExploreMaxTagCount.value = filter.maxTagCount ?? "";
      }
      if (elements.autoExploreFolderMatch) {
        elements.autoExploreFolderMatch.value = filter.folderMatch;
      }
      if (elements.autoExploreIncludeSubfolders) {
        elements.autoExploreIncludeSubfolders.checked = filter.includeSubfolders;
      }
      updateFilterSummaries(filter);
    }

    function updateFilterSummaries(filter) {
      if (elements.autoExploreFolderSummary) {
        const folderCount = filter.folders.length;
        elements.autoExploreFolderSummary.textContent = folderCount
          ? `${folderCount} 個資料夾${filter.includeSubfolders ? "（含子資料夾）" : ""}`
          : "不限";
      }
      if (elements.autoExploreFilterSummary) {
        const ratingSummary = getRatingSummary(filter);
        const selectedGroupCount = [filter.tags, ...filter.tagGroups.map(({ tags }) => tags)]
          .filter((tags) => tags.length)
          .length;
        const excludedTagCount = filter.excludedTags.length;
        const tagSummary = selectedGroupCount
          ? `${selectedGroupCount} 個 Tag 群組${excludedTagCount ? ` · 排除 ${excludedTagCount}` : ""}`
          : excludedTagCount
            ? `排除 ${excludedTagCount} 個 Tag`
            : "不限 Tag";
        elements.autoExploreFilterSummary.textContent = `${ratingSummary} · ${tagSummary}`;
      }
    }

    function getRatingSummary(filter) {
      if (filter.rating === "unrated") return "未評分";
      if (filter.rating !== "any") return `${filter.rating} 星`;
      if (filter.minRating !== null && filter.maxRating !== null) {
        return `${filter.minRating}–${filter.maxRating} 星`;
      }
      if (filter.minRating !== null) return `至少 ${filter.minRating} 星`;
      if (filter.maxRating !== null) return `最多 ${filter.maxRating} 星`;
      return "不限評分";
    }

    function handleOutsidePointerDown(event) {
      const panel = elements.autoExploreSettingsPanel;
      if (!panel || panel.hidden) return;
      if (elements.autoExploreControls?.contains(event.target)) return;
      close();
    }

    elements.autoExploreSettingsButton?.addEventListener("click", toggle);
    elements.autoExploreSettingsClose?.addEventListener("click", close);
    for (const tab of elements.autoExploreSettingsTabs || []) {
      tab.addEventListener("click", () => setActiveTab(tab.dataset.settingsTab));
      tab.addEventListener("keydown", handleTabKeyDown);
    }
    elements.autoExploreFileTypeImage?.addEventListener("change", updateDraftFileTypes);
    elements.autoExploreFileTypeVideo?.addEventListener("change", updateDraftFileTypes);
    elements.autoExploreRating?.addEventListener("change", updateDraftRating);
    elements.autoExploreMinRating?.addEventListener("change", (event) =>
      updateDraftRatingRange(event, "minRating"),
    );
    elements.autoExploreMaxRating?.addEventListener("change", (event) =>
      updateDraftRatingRange(event, "maxRating"),
    );
    elements.autoExploreTagMatch?.addEventListener("change", updateDraftTagMatch);
    elements.autoExploreTagGroupMatch?.addEventListener("change", updateDraftTagGroupMatch);
    elements.autoExploreMaxTagCount?.addEventListener("input", updateDraftMaxTagCount);
    elements.autoExploreTagSearch?.addEventListener("input", update);
    elements.autoExploreTagSearch?.addEventListener("keydown", (event) =>
      handleTagSearchKeyDown(event, elements.autoExploreTagOptions),
    );
    elements.autoExploreExcludedTagSearch?.addEventListener("input", update);
    elements.autoExploreExcludedTagSearch?.addEventListener("keydown", (event) =>
      handleTagSearchKeyDown(event, elements.autoExploreExcludedTagOptions),
    );
    elements.autoExploreFolderMatch?.addEventListener("change", updateDraftFolderMatch);
    elements.autoExploreIncludeSubfolders?.addEventListener("change", updateDraftIncludeSubfolders);
    elements.autoExploreFolderSearch?.addEventListener("input", update);
    elements.autoExploreAddTagGroup?.addEventListener("click", addTagGroup);
    elements.autoExploreSettingsReset?.addEventListener("click", reset);
    documentRef?.addEventListener?.("pointerdown", handleOutsidePointerDown);

    setActiveTab("exploration");
    update();

    return Object.freeze({
      close,
      getFilter,
      open,
      setActiveTab,
      setFilter,
      toggle,
      update,
    });
  }

  return Object.freeze({ createAutoExploreSettings });
});

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
      createTagChip = (tag) => {
        const chip = documentRef.createElement("span");
        chip.textContent = tag;
        return chip;
      },
      onFilterChange = () => {},
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
      apply({ closeAfterApply: false });
    }

    function updateDraftTagMatch(event) {
      if (!draftFilter) return;
      draftFilter.tagMatch = event.target.value;
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
      apply({ closeAfterApply: false });
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
      if (elements.autoExploreTagMatch) {
        elements.autoExploreTagMatch.value = filter.tagMatch;
      }
      if (elements.autoExploreMaxTagCount) {
        elements.autoExploreMaxTagCount.value = filter.maxTagCount ?? "";
      }
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
    elements.autoExploreTagMatch?.addEventListener("change", updateDraftTagMatch);
    elements.autoExploreMaxTagCount?.addEventListener("input", updateDraftMaxTagCount);
    elements.autoExploreTagSearch?.addEventListener("input", update);
    elements.autoExploreTagSearch?.addEventListener("keydown", (event) =>
      handleTagSearchKeyDown(event, elements.autoExploreTagOptions),
    );
    elements.autoExploreExcludedTagSearch?.addEventListener("input", update);
    elements.autoExploreExcludedTagSearch?.addEventListener("keydown", (event) =>
      handleTagSearchKeyDown(event, elements.autoExploreExcludedTagOptions),
    );
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

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createElementStub } = require("../test-support/plugin-harness.js");
const { createFolderBrowser } = require("../folder-browser.js");

function createHarness() {
  const elements = {
    root: createElementStub("aside"),
    toggle: createElementStub("button"),
    folderTab: createElementStub("button"),
    tagTab: createElementStub("button"),
    extensionTab: createElementStub("button"),
    folderPanel: createElementStub("section"),
    tagPanel: createElementStub("section"),
    extensionPanel: createElementStub("section"),
    search: createElementStub("input"),
    includeSubfolders: createElementStub("input"),
    tree: createElementStub("div"),
    tagSearch: createElementStub("input"),
    tagSort: createElementStub("select"),
    tagList: createElementStub("div"),
    extensionList: createElementStub("div"),
    status: createElementStub("div"),
  };
  elements.includeSubfolders.checked = true;
  elements.tagSort.value = "alphabetical";
  const document = {
    createElement(tag) {
      return createElementStub(tag);
    },
  };
  const selections = [];
  const browser = createFolderBrowser({
    document,
    elements,
    onSelect(selection) {
      selections.push(selection);
    },
  });
  return { browser, elements, selections };
}

function folderLabels(harness) {
  return harness.elements.tree
    .querySelectorAll(".folder-browser-label")
    .map(({ textContent }) => textContent);
}

function tagLabels(harness) {
  return harness.elements.tagList
    .querySelectorAll(".folder-browser-label")
    .map(({ textContent }) => textContent);
}

function tagGroupHeadings(harness) {
  return harness.elements.tagList
    .querySelectorAll(".folder-browser-tag-group-heading")
    .map(({ textContent }) => textContent);
}

test("folder browser renders nested folders and reports the selected folder", () => {
  const harness = createHarness();
  harness.browser.setFolders([
    { id: "root", name: "Design", children: [{ id: "child", name: "Icons" }] },
  ]);

  assert.equal(harness.elements.tree.children.length, 1);
  assert.deepEqual(folderLabels(harness), ["Design"]);
  harness.elements.tree.querySelectorAll(".folder-browser-disclosure")[0].click();
  const buttons = harness.elements.tree.querySelectorAll(".folder-browser-item");
  assert.deepEqual(folderLabels(harness), ["Design", "Icons"]);

  harness.elements.includeSubfolders.checked = false;
  buttons[1].click();

  const selectedButtons = harness.elements.tree.querySelectorAll(".folder-browser-item");
  assert.equal(selectedButtons[1].classList.contains("is-selected"), true);
  assert.equal(selectedButtons[1].parentNode.parentNode.getAttribute("aria-selected"), "true");

  assert.deepEqual(harness.selections, [
    {
      type: "folder",
      value: "child",
      label: "Icons",
      folder: { id: "child", name: "Icons", icon: "📁", iconColor: "", children: [] },
      includeSubfolders: false,
    },
  ]);
});

test("library sidebar switches between folders, Tags, and file extensions", () => {
  const harness = createHarness();
  harness.browser.setTags([
    { name: "UI", color: "red" },
    { name: "Reference", color: "blue" },
  ]);
  harness.browser.setFileTypes([
    { value: "jpg", label: "JPG" },
    { value: "pdf", label: "PDF" },
    { value: "mp4", label: "MP4" },
  ]);

  harness.elements.tagTab.click();
  assert.equal(harness.elements.folderPanel.hidden, true);
  assert.equal(harness.elements.tagPanel.hidden, false);
  assert.deepEqual(
    tagLabels(harness),
    ["Reference", "UI"],
  );
  harness.elements.tagList
    .querySelectorAll(".folder-browser-item")
    .find((button) => button.dataset.value === "UI")
    .click();

  harness.elements.extensionTab.click();
  assert.equal(harness.elements.tagPanel.hidden, true);
  assert.equal(harness.elements.extensionPanel.hidden, false);
  harness.elements.extensionList
    .querySelectorAll(".folder-browser-item")
    .find((button) => button.dataset.value === "pdf")
    .click();

  assert.deepEqual(harness.selections, [
    { type: "tag", value: "UI", label: "UI" },
    { type: "extension", value: "pdf", label: "PDF" },
  ]);
});

test("library sidebar sorts Tags and file extensions alphabetically", () => {
  const harness = createHarness();
  harness.browser.setTags([{ name: "zebra" }, { name: "Alpha" }, { name: "beta" }]);
  harness.browser.setFileTypes([
    { value: "pdf", label: "PDF" },
    { value: "jpg", label: "JPG" },
    { value: "mp4", label: "MP4" },
  ]);

  assert.deepEqual(tagLabels(harness), ["Alpha", "beta", "zebra"]);
  assert.deepEqual(
    harness.elements.extensionList
      .querySelectorAll(".folder-browser-label")
      .map(({ textContent }) => textContent),
    ["JPG", "MP4", "PDF"],
  );
});

test("library sidebar can render Tags in Eagle group order", () => {
  const harness = createHarness();
  harness.browser.setTags(
    [
      { name: "UI", groups: ["work"] },
      { name: "Portrait", groups: ["subject"] },
      { name: "Shared", groups: ["work", "subject"] },
      { name: "Loose" },
    ],
    [
      { id: "subject", name: "主題", tags: ["Portrait", "Shared"] },
      { id: "work", name: "工作", tags: ["Shared", "UI"] },
    ],
  );

  harness.elements.tagSort.value = "grouped";
  harness.elements.tagSort.emit("change");

  assert.equal(harness.elements.tagSort.hidden, false);
  assert.deepEqual(tagGroupHeadings(harness), ["主題", "工作", "未分組"]);
  assert.deepEqual(tagLabels(harness), ["Portrait", "Shared", "Shared", "UI", "Loose"]);
});

test("grouped Tag search keeps only groups with matching Tags", () => {
  const harness = createHarness();
  harness.browser.setTags(
    [
      { name: "Portrait", groups: ["subject"] },
      { name: "UI", groups: ["work"] },
      { name: "Loose" },
    ],
    [
      { id: "subject", name: "主題", tags: ["Portrait"] },
      { id: "work", name: "工作", tags: ["UI"] },
    ],
  );
  harness.elements.tagSort.value = "grouped";
  harness.elements.tagSort.emit("change");

  harness.elements.tagSearch.value = "por";
  harness.elements.tagSearch.emit("input");

  assert.deepEqual(tagGroupHeadings(harness), ["主題"]);
  assert.deepEqual(tagLabels(harness), ["Portrait"]);
});

test("library sidebar falls back to alphabetical Tags without Eagle groups", () => {
  const harness = createHarness();
  harness.browser.setTags([{ name: "Zulu" }, { name: "Alpha" }]);

  harness.elements.tagSort.value = "grouped";
  harness.elements.tagSort.emit("change");

  assert.equal(harness.elements.tagSort.hidden, true);
  assert.equal(harness.elements.tagSort.value, "alphabetical");
  assert.deepEqual(tagLabels(harness), ["Alpha", "Zulu"]);
});

test("library sidebar searches Tags independently from folders", () => {
  const harness = createHarness();
  harness.browser.setTags([{ name: "UI" }, { name: "Photography" }]);
  harness.elements.tagTab.click();
  harness.elements.tagSearch.value = "photo";
  harness.elements.tagSearch.emit("input");

  assert.deepEqual(
    harness.elements.tagList
      .querySelectorAll(".folder-browser-label")
      .map(({ textContent }) => textContent),
    ["Photography"],
  );
});

test("library sidebar keeps one selected target across source tabs", () => {
  const harness = createHarness();
  harness.browser.setTags([{ name: "UI" }]);
  harness.browser.setFileTypes([{ value: "pdf", label: "PDF" }]);

  harness.browser.setSelectedTarget({ type: "tag", value: "UI" });
  assert.equal(harness.elements.tagPanel.hidden, false);
  assert.equal(
    harness.elements.tagList
      .querySelectorAll(".folder-browser-item")[0]
      .classList.contains("is-selected"),
    true,
  );

  harness.elements.extensionTab.click();
  harness.elements.extensionList.querySelectorAll(".folder-browser-item")[0].click();
  harness.elements.tagTab.click();
  assert.equal(
    harness.elements.tagList
      .querySelectorAll(".folder-browser-item")[0]
      .classList.contains("is-selected"),
    false,
  );
});

test("folder browser keeps the selected folder highlighted across refreshes", () => {
  const harness = createHarness();
  const folders = [
    { id: "root", name: "Design", children: [{ id: "child", name: "Icons" }] },
    { id: "other", name: "Photos" },
  ];
  harness.browser.setFolders(folders);
  harness.elements.tree.querySelectorAll(".folder-browser-disclosure")[0].click();
  harness.elements.tree.querySelectorAll(".folder-browser-item")[1].click();

  harness.browser.setFolders(folders);
  assert.equal(
    harness.elements.tree.querySelectorAll(".folder-browser-item")[1].classList.contains("is-selected"),
    true,
  );

  harness.browser.setFolders([{ id: "other", name: "Photos" }]);
  assert.equal(
    harness.elements.tree.querySelectorAll(".folder-browser-item")[0].classList.contains("is-selected"),
    false,
  );
});

test("folder browser highlights the Eagle-selected folder when the tree arrives later", () => {
  const harness = createHarness();

  harness.browser.setSelectedTarget({ type: "folder", value: "child" });
  harness.browser.setFolders([
    { id: "root", name: "Design", children: [{ id: "child", name: "Icons" }] },
  ]);
  harness.elements.tree.querySelectorAll(".folder-browser-disclosure")[0].click();

  const buttons = harness.elements.tree.querySelectorAll(".folder-browser-item");
  assert.equal(buttons[1].classList.contains("is-selected"), true);
});

test("folder browser renders Eagle folder icons and colors with a fallback", () => {
  const harness = createHarness();
  harness.browser.setFolders([
    {
      id: "custom",
      name: "Favorites",
      icon: "C:\\Eagle\\icons\\favorites.png",
      iconColor: "purple",
    },
    { id: "default", name: "Other" },
  ]);

  const buttons = harness.elements.tree.querySelectorAll(".folder-browser-item");
  const icons = harness.elements.tree.querySelectorAll(".folder-browser-icon");
  assert.equal(icons.length, 2);
  assert.ok(icons.every(({ innerHTML }) => innerHTML.includes('fill="currentColor"')));
  assert.equal(buttons[0].style["--folder-icon-color"], "#8b7bd8");
  assert.equal(buttons[1].style["--folder-icon-color"], undefined);
});

test("folder browser search keeps matching ancestors visible", () => {
  const harness = createHarness();
  harness.browser.setFolders([
    {
      id: "root",
      name: "Design",
      icon: "📦",
      iconColor: "blue",
      children: [{ id: "child", name: "Icons", icon: "⭐", iconColor: "purple" }],
    },
    { id: "other", name: "Photos" },
  ]);

  harness.elements.search.value = "icons";
  harness.elements.search.emit("input");

  assert.deepEqual(folderLabels(harness), ["Design", "Icons"]);
  const buttons = harness.elements.tree.querySelectorAll(".folder-browser-item");
  assert.match(buttons[0].querySelector(".folder-browser-icon").innerHTML, /currentColor/);
  assert.equal(buttons[0].style["--folder-icon-color"], "#5d91d8");
  assert.match(buttons[1].querySelector(".folder-browser-icon").innerHTML, /currentColor/);
  assert.equal(buttons[1].style["--folder-icon-color"], "#8b7bd8");
});

test("folder browser can be collapsed without removing the folder tree", () => {
  const harness = createHarness();

  assert.equal(harness.elements.root.classList.contains("is-open"), false);
  harness.elements.toggle.click();
  assert.equal(harness.elements.root.classList.contains("is-open"), true);
  assert.equal(harness.elements.toggle.getAttribute("aria-expanded"), "true");
});

test("folder browser preserves ids from Eagle-like folder objects", () => {
  const harness = createHarness();
  const eagleFolder = {};
  Object.defineProperties(eagleFolder, {
    id: { value: "eagle-root" },
    name: { value: "Design" },
    children: { value: [] },
  });
  harness.browser.setFolders([eagleFolder]);

  harness.elements.tree.querySelectorAll(".folder-browser-item")[0].click();

  assert.equal(harness.selections[0].folder.id, "eagle-root");
});

test("folder browser keeps the full status message in the tooltip", () => {
  const harness = createHarness();
  const message = "已載入「非常非常深層且名稱很長的資料夾」的內容。";

  harness.browser.setStatus(message);

  assert.equal(harness.elements.status.textContent, message);
  assert.equal(harness.elements.status.title, message);
});

test("folder browser can collapse a folder without hiding its siblings", () => {
  const harness = createHarness();
  harness.browser.setFolders([
    { id: "root", name: "Design", children: [{ id: "child", name: "Icons" }] },
    { id: "other", name: "Photos" },
  ]);

  assert.deepEqual(folderLabels(harness), ["Design", "Photos"]);
  const disclosure = harness.elements.tree.querySelectorAll(".folder-browser-disclosure")[0];
  assert.equal(disclosure.classList.contains("is-expanded"), false);
  disclosure.click();
  assert.deepEqual(folderLabels(harness), ["Design", "Icons", "Photos"]);
  assert.equal(
    harness.elements.tree.querySelectorAll(".folder-browser-disclosure")[0].classList.contains(
      "is-expanded",
    ),
    true,
  );
  harness.elements.tree.querySelectorAll(".folder-browser-disclosure")[0].click();
  assert.equal(
    harness.elements.tree.querySelectorAll(".folder-browser-disclosure")[0].classList.contains(
      "is-expanded",
    ),
    false,
  );

  assert.deepEqual(folderLabels(harness), ["Design", "Photos"]);
});

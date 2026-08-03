"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createElementStub } = require("../test-support/plugin-harness.js");
const { createFolderBrowser } = require("../folder-browser.js");

function createHarness() {
  const elements = {
    root: createElementStub("aside"),
    toggle: createElementStub("button"),
    search: createElementStub("input"),
    includeSubfolders: createElementStub("input"),
    tree: createElementStub("div"),
    status: createElementStub("div"),
  };
  elements.includeSubfolders.checked = true;
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

  assert.deepEqual(harness.selections, [
    {
      folder: { id: "child", name: "Icons", icon: "📁", iconColor: "", children: [] },
      includeSubfolders: false,
    },
  ]);
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

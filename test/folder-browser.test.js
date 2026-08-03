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

test("folder browser renders nested folders and reports the selected folder", () => {
  const harness = createHarness();
  harness.browser.setFolders([
    { id: "root", name: "Design", children: [{ id: "child", name: "Icons" }] },
  ]);

  assert.equal(harness.elements.tree.children.length, 1);
  assert.deepEqual(
    harness.elements.tree.querySelectorAll(".folder-browser-item").map(({ textContent }) => textContent),
    ["Design"],
  );
  harness.elements.tree.querySelectorAll(".folder-browser-disclosure")[0].click();
  const buttons = harness.elements.tree.querySelectorAll(".folder-browser-item");
  assert.deepEqual(buttons.map(({ textContent }) => textContent), ["Design", "Icons"]);

  harness.elements.includeSubfolders.checked = false;
  buttons[1].click();

  assert.deepEqual(harness.selections, [
    {
      folder: { id: "child", name: "Icons", children: [] },
      includeSubfolders: false,
    },
  ]);
});

test("folder browser search keeps matching ancestors visible", () => {
  const harness = createHarness();
  harness.browser.setFolders([
    { id: "root", name: "Design", children: [{ id: "child", name: "Icons" }] },
    { id: "other", name: "Photos" },
  ]);

  harness.elements.search.value = "icons";
  harness.elements.search.emit("input");

  assert.deepEqual(
    harness.elements.tree.querySelectorAll(".folder-browser-item").map(({ textContent }) => textContent),
    ["Design", "Icons"],
  );
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

  assert.deepEqual(
    harness.elements.tree.querySelectorAll(".folder-browser-item").map(({ textContent }) => textContent),
    ["Design", "Photos"],
  );
  const disclosure = harness.elements.tree.querySelectorAll(".folder-browser-disclosure")[0];
  assert.equal(disclosure.classList.contains("is-expanded"), false);
  disclosure.click();
  assert.deepEqual(
    harness.elements.tree.querySelectorAll(".folder-browser-item").map(({ textContent }) => textContent),
    ["Design", "Icons", "Photos"],
  );
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

  assert.deepEqual(
    harness.elements.tree.querySelectorAll(".folder-browser-item").map(({ textContent }) => textContent),
    ["Design", "Photos"],
  );
});

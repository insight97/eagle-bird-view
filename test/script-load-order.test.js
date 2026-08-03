"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

function scriptSources() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  return [...html.matchAll(/<script src="([^"]+)"[^>]*>/g)].map(([, source]) => source);
}

// Eagle loads the plugin as plain scripts, so each module has to find its
// dependencies on the global object by the time it runs. Nothing here may fall
// back to require(): that path only exists for the test runner.
test("every module resolves its dependencies in index.html script order", () => {
  const context = {
    console,
    Intl,
    document: { addEventListener() {}, querySelector: () => null },
    require() {
      throw new Error("browser scripts must not fall back to require()");
    },
  };
  context.globalThis = context;
  vm.createContext(context);

  const sources = scriptSources();
  assert.ok(sources.includes("plugin.js"), "index.html should load plugin.js");

  for (const source of sources) {
    if (source === "plugin.js") continue;
    vm.runInContext(fs.readFileSync(path.join(ROOT, source), "utf8"), context, {
      filename: source,
    });
  }

  assert.deepEqual(
    Object.keys(context).filter((key) => key.startsWith("BirdView")).sort(),
    [
      "BirdViewAutoExploreSettings",
      "BirdViewBoard",
      "BirdViewCamera",
      "BirdViewCore",
      "BirdViewExploration",
      "BirdViewFolder",
      "BirdViewFolderBrowser",
      "BirdViewFolderPicker",
      "BirdViewMaterializer",
      "BirdViewMedia",
      "BirdViewPopover",
      "BirdViewRowLoad",
      "BirdViewSelection",
      "BirdViewSelectionTags",
      "BirdViewSettingsPresets",
      "BirdViewTagEditor",
      "BirdViewVideo",
    ],
  );
  assert.equal(
    Object.getPrototypeOf(context.BirdViewTagEditor.TagEditor),
    context.BirdViewPopover.AnchoredPopover,
  );
  assert.equal(
    Object.getPrototypeOf(context.BirdViewFolderPicker.FolderPicker),
    context.BirdViewPopover.AnchoredPopover,
  );
});

test("plugin.js only destructures exports its dependencies provide", () => {
  const context = { console, Intl };
  context.globalThis = context;
  vm.createContext(context);

  for (const source of scriptSources()) {
    if (source === "plugin.js") continue;
    vm.runInContext(fs.readFileSync(path.join(ROOT, source), "utf8"), context, {
      filename: source,
    });
  }

  const plugin = fs.readFileSync(path.join(ROOT, "plugin.js"), "utf8");
  for (const [, names, moduleName] of plugin.matchAll(
    /const \{([^}]+)\} = (BirdView\w+);/g,
  )) {
    const exported = context[moduleName];
    assert.ok(exported, `${moduleName} should be defined before plugin.js runs`);
    for (const name of names.split(",").map((value) => value.trim()).filter(Boolean)) {
      assert.ok(name in exported, `${moduleName} should export ${name}`);
    }
  }
});

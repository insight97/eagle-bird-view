"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { build } = require("esbuild");

const projectRoot = path.resolve(__dirname, "..");
const cacheDirectory = path.join(projectRoot, ".test-cache");
const bundlePath = path.join(cacheDirectory, "happy-dom-window.cjs");
const temporaryBundlePath = `${bundlePath}.tmp`;
const metadataPath = path.join(cacheDirectory, "metadata.json");
const happyDomRoot = path.dirname(require.resolve("happy-dom/package.json"));
const happyDomPackage = JSON.parse(
  fs.readFileSync(path.join(happyDomRoot, "package.json"), "utf8"),
);
const metadata = { formatVersion: 2, happyDomVersion: happyDomPackage.version };

async function prepareTestDom() {
  if (isCurrentBundle()) return;
  fs.mkdirSync(cacheDirectory, { recursive: true });
  await build({
    entryPoints: [path.join(happyDomRoot, "lib/window/Window.js")],
    outfile: temporaryBundlePath,
    bundle: true,
    format: "cjs",
    platform: "node",
    logLevel: "warning",
  });
  fs.renameSync(temporaryBundlePath, bundlePath);
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`);
}

function isCurrentBundle() {
  if (!fs.existsSync(bundlePath) || !fs.existsSync(metadataPath)) return false;
  try {
    const cached = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    return (
      cached.formatVersion === metadata.formatVersion &&
      cached.happyDomVersion === metadata.happyDomVersion
    );
  } catch {
    return false;
  }
}

prepareTestDom().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createVideoThumbnailService } = require("../video-thumbnail.js");

function createCanvasProbe() {
  const canvas = {
    width: 0,
    height: 0,
    drawCalls: [],
    getContext(type) {
      assert.equal(type, "2d");
      return {
        drawImage(...args) {
          canvas.drawCalls.push(args);
        },
      };
    },
    toDataURL(type) {
      assert.equal(type, "image/png");
      return "data:image/png;base64,AAEC";
    },
  };
  return canvas;
}

test("video thumbnail service captures the current frame and cleans its temporary file", async () => {
  const canvas = createCanvasProbe();
  const writes = [];
  const removed = [];
  const thumbnailPaths = [];
  const item = {
    id: "video-1",
    async setCustomThumbnail(filePath) {
      thumbnailPaths.push(filePath);
      return true;
    },
  };
  const video = { readyState: 4, videoWidth: 1920, videoHeight: 1080 };
  const service = createVideoThumbnailService({
    document: {
      createElement(tag) {
        assert.equal(tag, "canvas");
        return canvas;
      },
    },
    getTempDirectory: async () => "/tmp",
    joinPath: (directory, filename) => `${directory}/${filename}`,
    writeFile: async (filePath, bytes) => writes.push({ filePath, bytes: [...bytes] }),
    removeFile: async (filePath) => removed.push(filePath),
    now: () => 1700000000000,
  });

  const result = await service.setFromVideo({ video, item });

  assert.deepEqual(result, { status: "saved" });
  assert.equal(canvas.width, 1920);
  assert.equal(canvas.height, 1080);
  assert.deepEqual(canvas.drawCalls, [[video, 0, 0, 1920, 1080]]);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].bytes, [0, 1, 2]);
  assert.match(writes[0].filePath, /\/tmp\/bird-view-video-thumbnail-video-1-1700000000000\.png$/);
  assert.deepEqual(thumbnailPaths, [writes[0].filePath]);
  assert.deepEqual(removed, [writes[0].filePath]);
});

test("video thumbnail service reports an unavailable frame without writing a file", async () => {
  let writes = 0;
  const service = createVideoThumbnailService({
    document: { createElement() { throw new Error("should not create a canvas"); } },
    getTempDirectory: async () => "/tmp",
    joinPath: (directory, filename) => `${directory}/${filename}`,
    writeFile: async () => { writes += 1; },
    removeFile: async () => {},
  });

  const result = await service.setFromVideo({
    video: { readyState: 1, videoWidth: 1920, videoHeight: 1080 },
    item: { setCustomThumbnail: async () => true },
  });

  assert.deepEqual(result, { status: "unavailable", reason: "video-not-ready" });
  assert.equal(writes, 0);
});

test("video thumbnail service identifies missing temporary-file capabilities", async () => {
  const service = createVideoThumbnailService({
    document: { createElement() {} },
    getTempDirectory: async () => "/tmp",
  });

  const result = await service.setFromVideo({
    video: { readyState: 4, videoWidth: 1920, videoHeight: 1080 },
    item: { setCustomThumbnail: async () => true },
  });

  assert.deepEqual(result, {
    status: "unavailable",
    reason: "runtime-unavailable",
    missing: ["path.join", "fs.writeFile", "fs.unlink"],
  });
});

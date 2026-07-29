"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startVideoPlayer } = require("../../video-player.js");
const { withDom } = require("../../test-support/dom-harness.js");

test("video player mounts controls, updates progress and volume, and restores the preview on error", () =>
  withDom(async (window) => {
    const originalPlay = window.HTMLMediaElement.prototype.play;
    const originalPause = window.HTMLMediaElement.prototype.pause;
    let playCalls = 0;
    let pauseCalls = 0;
    window.HTMLMediaElement.prototype.play = function play() {
      playCalls += 1;
      return Promise.resolve();
    };
    window.HTMLMediaElement.prototype.pause = function pause() {
      pauseCalls += 1;
    };

    try {
      const card = document.createElement("article");
      const frame = document.createElement("div");
      const image = document.createElement("img");
      const playButton = document.createElement("button");
      const volumeChanges = [];
      const toasts = [];
      let layoutChanges = 0;
      let rotations = 0;
      const node = {
        element: card,
        mediaHeight: 100,
        height: 100,
      };

      frame.append(image, playButton);
      card.append(frame);
      document.body.append(card);

      startVideoPlayer({
        frame,
        image,
        playButton,
        item: { fileURL: "file:///movie.mp4" },
        node,
        controlsHeight: 8,
        initialVolume: 0.4,
        onVolumeChange: (volume) => volumeChanges.push(volume),
        applyRotation: () => { rotations += 1; },
        onLayoutChange: () => { layoutChanges += 1; },
        showToast: (message) => toasts.push(message),
      });

      const video = node.videoElement;
      const controls = card.querySelector(".video-controls");
      const toggleButton = card.querySelector(".video-toggle");
      const progress = card.querySelector(".video-progress");
      const timeLabel = card.querySelector(".video-time");
      const volumeButton = card.querySelector(".volume-toggle");
      const volume = card.querySelector(".volume-slider");

      assert.ok(video);
      assert.ok(controls);
      assert.equal(video.src, "file:///movie.mp4");
      assert.equal(video.loop, true);
      assert.equal(video.volume, 0.4);
      assert.equal(node.height, 108);
      assert.equal(playCalls, 1);
      assert.equal(rotations, 1);
      assert.equal(layoutChanges, 1);

      node.pausePlayback();
      assert.equal(pauseCalls, 1);
      node.playPlayback();
      assert.equal(playCalls, 2);

      Object.defineProperty(video, "duration", { configurable: true, value: 125 });
      video.currentTime = 65;
      video.dispatchEvent(new window.Event("loadedmetadata"));
      video.dispatchEvent(new window.Event("timeupdate"));
      assert.equal(timeLabel.textContent, "1:05 / 2:05");
      assert.equal(progress.value, "520");

      progress.value = "500";
      progress.dispatchEvent(new window.Event("input", { bubbles: true }));
      assert.equal(video.currentTime, 62.5);
      assert.equal(timeLabel.textContent, "1:02 / 2:05");

      volume.value = "0.25";
      volume.dispatchEvent(new window.Event("input", { bubbles: true }));
      video.dispatchEvent(new window.Event("volumechange"));
      assert.equal(video.volume, 0.25);
      assert.equal(volumeChanges.at(-1), 0.25);

      volumeButton.click();
      video.dispatchEvent(new window.Event("volumechange"));
      assert.equal(video.muted, true);
      assert.equal(volumeButton.getAttribute("aria-label"), "取消靜音");

      video.dispatchEvent(new window.Event("play"));
      assert.equal(toggleButton.getAttribute("aria-label"), "暫停");
      video.dispatchEvent(new window.Event("pause"));
      assert.equal(toggleButton.getAttribute("aria-label"), "播放");

      video.dispatchEvent(new window.Event("error"));
      assert.equal(node.videoElement, null);
      assert.equal(node.mediaElement, image);
      assert.equal(node.height, 100);
      assert.equal(node.pausePlayback, null);
      assert.equal(node.playPlayback, null);
      assert.equal(image.parentNode, frame);
      assert.equal(playButton.parentNode, frame);
      assert.equal(layoutChanges, 2);
      assert.equal(toasts.at(-1), "這個影片的容器或編碼無法由外掛播放器解碼。");
      assert.equal(pauseCalls, 1);
    } finally {
      window.HTMLMediaElement.prototype.play = originalPlay;
      window.HTMLMediaElement.prototype.pause = originalPause;
    }
  }));

test("starting an already active video delegates to its toggle handler", () =>
  withDom(() => {
    let toggles = 0;
    const node = {
      videoElement: {},
      togglePlayback: () => { toggles += 1; },
    };

    startVideoPlayer({ node });

    assert.equal(toggles, 1);
  }));

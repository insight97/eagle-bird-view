"use strict";

(function exposeVideoPlayer(root, factory) {
  const videoPlayer = factory();
  if (typeof module === "object" && module.exports) module.exports = videoPlayer;
  root.BirdViewVideo = videoPlayer;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const VIDEO_CONTROLS_HIDE_DELAY = 1600;
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const CONTROL_ICONS = Object.freeze({
    play: [{ d: "M4.5 3.25v9.5L12.5 8l-8-4.75Z" }],
    pause: [{ d: "M3.5 3h3v10h-3zM9.5 3h3v10h-3z" }],
    volume: [
      { d: "M2.5 6.25v3.5h2.25L8 12.5v-9L4.75 6.25H2.5Z" },
      {
        d: "M10 5.5a3.55 3.55 0 0 1 0 5",
        fill: "none",
        stroke: "currentColor",
        "stroke-linecap": "round",
        "stroke-width": "1.25",
      },
    ],
    muted: [
      { d: "M2.5 6.25v3.5h2.25L8 12.5v-9L4.75 6.25H2.5Z" },
      {
        d: "m10 6 3 4m0-4-3 4",
        fill: "none",
        stroke: "currentColor",
        "stroke-linecap": "round",
        "stroke-width": "1.25",
      },
    ],
  });

  function setControlIcon(button, iconName) {
    const svg = document.createElementNS(SVG_NAMESPACE, "svg");
    svg.classList.add("video-control-icon");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    for (const attributes of CONTROL_ICONS[iconName]) {
      const path = document.createElementNS(SVG_NAMESPACE, "path");
      path.setAttribute("d", attributes.d);
      for (const [name, value] of Object.entries(attributes)) {
        if (name !== "d") path.setAttribute(name, value);
      }
      svg.append(path);
    }
    button.replaceChildren(svg);
  }

  function formatVideoTime(value) {
    const rawSeconds = Number(value);
    if (!Number.isFinite(rawSeconds)) return "--:--";
    const totalSeconds = Math.max(0, Math.floor(rawSeconds));
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function startVideoPlayer(options) {
    const {
      frame,
      image,
      playButton,
      item,
      node,
      controlsHeight,
      initialVolume = 1,
      onVolumeChange,
      applyRotation,
      onLayoutChange,
      showToast,
    } = options;
    if (node.videoElement) {
      node.togglePlayback?.();
      return;
    }
    const video = document.createElement("video");
    const controls = document.createElement("div");
    const toggleButton = document.createElement("button");
    const progress = document.createElement("input");
    const timeLabel = document.createElement("span");
    const volumeControl = document.createElement("div");
    const volumeButton = document.createElement("button");
    const volumePopover = document.createElement("div");
    const volume = document.createElement("input");
    const volumeValue = document.createElement("span");
    let controlsHideTimer = null;
    let controlsPointerInside = false;
    let controlsFocused = false;

    video.src = item.fileURL;
    video.autoplay = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "metadata";
    const nextVolume = Number(initialVolume);
    video.volume = Number.isFinite(nextVolume)
      ? Math.min(1, Math.max(0, nextVolume))
      : 1;
    node.mediaElement = video;
    applyRotation();
    controls.className = "video-controls";
    toggleButton.className = "video-toggle";
    toggleButton.type = "button";
    setControlIcon(toggleButton, "pause");
    toggleButton.setAttribute("aria-label", "暫停");
    progress.className = "video-progress";
    progress.type = "range";
    progress.min = "0";
    progress.max = "1000";
    progress.value = "0";
    progress.setAttribute("aria-label", "影片播放進度");
    timeLabel.className = "video-time";
    timeLabel.textContent = "0:00 / --:--";
    timeLabel.setAttribute("aria-label", "影片播放時間");
    timeLabel.title = "目前播放時間 / 影片長度";
    volumeControl.className = "volume-control";
    volumeButton.className = "volume-toggle";
    volumeButton.type = "button";
    setControlIcon(volumeButton, "volume");
    volumeButton.setAttribute("aria-label", "靜音");
    volumeButton.setAttribute("aria-pressed", "false");
    volumeButton.title = "靜音";
    volumePopover.className = "volume-popover";
    volume.className = "volume-slider";
    volume.type = "range";
    volume.min = "0";
    volume.max = "1";
    volume.step = "0.01";
    volume.value = String(video.volume);
    volume.setAttribute("aria-label", "音量");
    volumeValue.className = "volume-value";
    volumeValue.textContent = "100%";
    volumePopover.append(volume, volumeValue);
    volumeControl.append(volumeButton, volumePopover);
    controls.append(toggleButton, progress, timeLabel, volumeControl);
    let lastAudibleVolume = video.volume || 1;

    const clearControlsHideTimer = () => {
      if (controlsHideTimer === null) return;
      clearTimeout(controlsHideTimer);
      controlsHideTimer = null;
    };
    const setControlsVisibility = (visible) => {
      if (visible) node.element?.setAttribute("data-video-controls-visible", "true");
      else node.element?.removeAttribute("data-video-controls-visible");
    };
    const updateTimeLabel = () => {
      timeLabel.textContent = `${formatVideoTime(video.currentTime)} / ${formatVideoTime(video.duration)}`;
    };
    const scheduleControlsHide = () => {
      clearControlsHideTimer();
      if (video.paused || controlsPointerInside || controlsFocused) return;
      controlsHideTimer = setTimeout(() => {
        controlsHideTimer = null;
        if (video.paused || controlsPointerInside || controlsFocused) return;
        setControlsVisibility(false);
      }, VIDEO_CONTROLS_HIDE_DELAY);
    };
    const revealControls = () => {
      setControlsVisibility(true);
      scheduleControlsHide();
    };
    node.stopVideoControls = () => {
      clearControlsHideTimer();
      setControlsVisibility(false);
    };
    node.revealVideoControls = revealControls;

    controls.addEventListener("dblclick", (event) => event.stopPropagation());
    controls.addEventListener("pointerenter", () => {
      controlsPointerInside = true;
      setControlsVisibility(true);
    });
    controls.addEventListener("pointerleave", () => {
      controlsPointerInside = false;
      scheduleControlsHide();
    });
    controls.addEventListener("pointerdown", revealControls);
    controls.addEventListener("focusin", () => {
      controlsFocused = true;
      setControlsVisibility(true);
    });
    controls.addEventListener("focusout", (event) => {
      if (event.relatedTarget && controls.contains(event.relatedTarget)) return;
      controlsFocused = false;
      scheduleControlsHide();
    });
    frame.addEventListener("pointerenter", revealControls);
    frame.addEventListener("pointermove", revealControls);
    frame.addEventListener("pointerdown", revealControls);

    const togglePlayback = () => {
      if (video.paused) {
        video.play().catch(() => showToast("無法播放這個影片。", true));
      } else {
        video.pause();
      }
    };
    const playPlayback = () =>
      video.play().catch(() => showToast("無法播放這個影片。", true));
    const pausePlayback = () => video.pause();
    node.videoElement = video;
    node.togglePlayback = togglePlayback;
    node.playPlayback = playPlayback;
    node.pausePlayback = pausePlayback;

    toggleButton.addEventListener("click", togglePlayback);
    video.addEventListener("play", () => {
      setControlIcon(toggleButton, "pause");
      toggleButton.setAttribute("aria-label", "暫停");
      revealControls();
    });
    video.addEventListener("pause", () => {
      setControlIcon(toggleButton, "play");
      toggleButton.setAttribute("aria-label", "播放");
      clearControlsHideTimer();
      setControlsVisibility(true);
    });
    video.addEventListener("timeupdate", () => {
      if (Number.isFinite(video.duration) && !progress.matches(":active")) {
        progress.value = String(Math.round((video.currentTime / video.duration) * 1000));
      }
      updateTimeLabel();
    });
    video.addEventListener("durationchange", updateTimeLabel);
    video.addEventListener("loadedmetadata", updateTimeLabel);
    progress.addEventListener("input", () => {
      if (Number.isFinite(video.duration)) {
        video.currentTime = (Number(progress.value) / 1000) * video.duration;
      }
      updateTimeLabel();
    });
    volumeButton.addEventListener("click", () => {
      if (video.muted || video.volume === 0) {
        if (video.volume === 0) video.volume = lastAudibleVolume;
        video.muted = false;
      } else {
        lastAudibleVolume = video.volume;
        video.muted = true;
      }
    });
    volume.addEventListener("input", () => {
      video.muted = false;
      video.volume = Number(volume.value);
      if (video.volume > 0) lastAudibleVolume = video.volume;
    });
    video.addEventListener("volumechange", () => {
      const audibleVolume = video.muted ? 0 : video.volume;
      const isMuted = audibleVolume === 0;
      volume.value = String(audibleVolume);
      volumeValue.textContent = `${Math.round(audibleVolume * 100)}%`;
      setControlIcon(volumeButton, isMuted ? "muted" : "volume");
      volumeButton.setAttribute("aria-label", isMuted ? "取消靜音" : "靜音");
      volumeButton.setAttribute("aria-pressed", String(isMuted));
      volumeButton.title = isMuted ? "取消靜音" : "靜音";
      onVolumeChange?.(video.volume);
    });
    video.addEventListener("error", () => {
      if (node.videoElement !== video) return;
      node.stopVideoControls?.();
      showToast("這個影片的容器或編碼無法由外掛播放器解碼。", true);
      video.remove();
      controls.remove();
      node.videoElement = null;
      node.togglePlayback = null;
      node.playPlayback = null;
      node.pausePlayback = null;
      node.stopVideoControls = null;
      node.revealVideoControls = null;
      node.mediaElement = image;
      applyRotation();
      frame.prepend(image);
      frame.append(playButton);
      node.height = node.mediaHeight;
      onLayoutChange();
    });

    image.remove();
    playButton.remove();
    frame.prepend(video);
    frame.after(controls);
    node.height = node.mediaHeight + controlsHeight;
    onLayoutChange();
    updateTimeLabel();
    setControlsVisibility(true);
    video.play().catch(() => {
      showToast("瀏覽器阻擋自動播放，請按影片上的播放鍵。", false);
    });
  }

  return Object.freeze({ startVideoPlayer });
});

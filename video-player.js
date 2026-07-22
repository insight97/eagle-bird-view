"use strict";

(function exposeVideoPlayer(root, factory) {
  const videoPlayer = factory();
  if (typeof module === "object" && module.exports) module.exports = videoPlayer;
  root.BirdViewVideo = videoPlayer;
})(typeof globalThis === "object" ? globalThis : this, () => {
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
    const volumeControl = document.createElement("div");
    const volumeButton = document.createElement("button");
    const volumePopover = document.createElement("div");
    const volume = document.createElement("input");
    const volumeValue = document.createElement("span");

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
    toggleButton.textContent = "❚❚";
    toggleButton.setAttribute("aria-label", "暫停");
    progress.className = "video-progress";
    progress.type = "range";
    progress.min = "0";
    progress.max = "1000";
    progress.value = "0";
    progress.setAttribute("aria-label", "影片播放進度");
    volumeControl.className = "volume-control";
    volumeButton.className = "volume-toggle";
    volumeButton.type = "button";
    volumeButton.textContent = "🔊";
    volumeButton.setAttribute("aria-label", "靜音");
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
    controls.append(toggleButton, progress, volumeControl);
    let lastAudibleVolume = video.volume || 1;

    controls.addEventListener("dblclick", (event) => event.stopPropagation());

    const togglePlayback = () => {
      if (video.paused) {
        video.play().catch(() => showToast("無法播放這個影片。", true));
      } else {
        video.pause();
      }
    };
    node.videoElement = video;
    node.togglePlayback = togglePlayback;

    toggleButton.addEventListener("click", togglePlayback);
    video.addEventListener("play", () => {
      toggleButton.textContent = "❚❚";
      toggleButton.setAttribute("aria-label", "暫停");
    });
    video.addEventListener("pause", () => {
      toggleButton.textContent = "▶";
      toggleButton.setAttribute("aria-label", "播放");
    });
    video.addEventListener("timeupdate", () => {
      if (Number.isFinite(video.duration) && !progress.matches(":active")) {
        progress.value = String(Math.round((video.currentTime / video.duration) * 1000));
      }
    });
    progress.addEventListener("input", () => {
      if (Number.isFinite(video.duration)) {
        video.currentTime = (Number(progress.value) / 1000) * video.duration;
      }
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
      volumeButton.textContent = isMuted ? "🔇" : "🔊";
      volumeButton.setAttribute("aria-label", isMuted ? "取消靜音" : "靜音");
      volumeButton.title = isMuted ? "取消靜音" : "靜音";
      onVolumeChange?.(video.volume);
    });
    video.addEventListener("error", () => {
      if (node.videoElement !== video) return;
      showToast("這個影片的容器或編碼無法由外掛播放器解碼。", true);
      video.remove();
      controls.remove();
      node.videoElement = null;
      node.togglePlayback = null;
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
    video.play().catch(() => {
      showToast("瀏覽器阻擋自動播放，請按影片上的播放鍵。", false);
    });
  }

  return Object.freeze({ startVideoPlayer });
});

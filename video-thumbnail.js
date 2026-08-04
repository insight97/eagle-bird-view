"use strict";

(function exposeBirdViewVideoThumbnail(root, factory) {
  const videoThumbnail = factory();
  if (typeof module === "object" && module.exports) module.exports = videoThumbnail;
  root.BirdViewVideoThumbnail = videoThumbnail;
})(typeof globalThis === "object" ? globalThis : this, () => {
  function createVideoThumbnailService({
    document: documentRef,
    getTempDirectory,
    joinPath,
    writeFile,
    removeFile,
    now = Date.now,
  } = {}) {
    async function setFromVideo({ video, item } = {}) {
      if (
        !video ||
        Number(video.readyState) < 2 ||
        !Number.isFinite(Number(video.videoWidth)) ||
        !Number.isFinite(Number(video.videoHeight)) ||
        video.videoWidth < 1 ||
        video.videoHeight < 1
      ) {
        return { status: "unavailable", reason: "video-not-ready" };
      }
      if (!item || typeof item.setCustomThumbnail !== "function") {
        return { status: "unavailable", reason: "item-api-unavailable" };
      }
      if (
        !documentRef?.createElement ||
        typeof getTempDirectory !== "function" ||
        typeof joinPath !== "function" ||
        typeof writeFile !== "function" ||
        typeof removeFile !== "function"
      ) {
        return { status: "unavailable", reason: "runtime-unavailable" };
      }

      const width = Math.floor(video.videoWidth);
      const height = Math.floor(video.videoHeight);
      const canvas = documentRef.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext?.("2d");
      if (!context) return { status: "unavailable", reason: "canvas-unavailable" };

      context.drawImage(video, 0, 0, width, height);
      const bytes = decodePngDataUrl(canvas.toDataURL("image/png"));
      const directory = await getTempDirectory();
      if (!directory) return { status: "unavailable", reason: "temp-directory-unavailable" };

      const filename = `bird-view-video-thumbnail-${safeName(item.id)}-${now()}.png`;
      const filePath = joinPath(directory, filename);
      let written = false;
      try {
        await writeFile(filePath, bytes);
        written = true;
        const result = await item.setCustomThumbnail(filePath);
        if (result === false) throw new Error("Eagle 拒絕設定影片縮圖");
        return { status: "saved" };
      } finally {
        if (written) {
          try {
            await removeFile(filePath);
          } catch {
            // Temporary cleanup is best-effort after Eagle receives the thumbnail.
          }
        }
      }
    }

    return Object.freeze({ setFromVideo });
  }

  function decodePngDataUrl(dataUrl) {
    const match = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl || ""));
    if (!match) throw new Error("無法將影片畫面編碼為 PNG");
    if (typeof atob !== "function") throw new Error("目前環境不支援影片畫面編碼");
    const binary = atob(match[1]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function safeName(value) {
    return String(value || "item")
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "item";
  }

  return Object.freeze({ createVideoThumbnailService });
});

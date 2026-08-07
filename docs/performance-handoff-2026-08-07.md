# 白板高解析度圖片卡頓：Agent 交接摘要

日期：2026-08-07

## 狀態：已定位並修正

原因不是文末推測的情況 A 或 B，而是第三種：原圖**已經載入完成**，但它是 40 MP 的全解析度母檔，每次 raster 都超出 Chromium 的 image decode cache 而被重新解碼。

`Profile-20260807T011206.json` 的 `PaintImage` 直接給出證據：

```text
src 5374 × 7589  →  實際畫在 120.98 × 170.84
src 4000 × 3000  →  實際畫在 213.33 × 159.98
```

同一個 `LazyPixelRef` 在 7 秒內被 decode 6 次；>150ms 的 decode 共 14 次、合計約 2.9 秒，全部落在 `CompositorTileWorker1~4`。

修正方式是 bounded raster：母檔載入後先縮成有上限的點陣圖再交給 compositor。實作與量測記錄在
[performance-best-practices.md](./performance-best-practices.md) 的「已量測並修正」段落。

以下保留當時的調查過程，說明為什麼所有 layer／`will-change` 方向的嘗試都無效。

## 問題現象

- 白板有多張高解析度圖片，尤其是 Painting 素材時，平移會卡頓。
- 不需要縮放就會卡，縮放也會卡。
- 將所有 `.media-card` 隱藏後，移動明顯變順。
- 目前最新版本即使降低合成層提示，仍然會卡。
- 移動結束後，圖片有時需要約 0.5 秒才恢復清晰。

## 可重現條件

使用者提供的測試環境資訊：

```text
devicePixelRatio: 1
viewport: 1407 x 967
cards: 18
quality: original 15, thumbnail 2, idle 1
```

大部分卡片已經是 `original`，因此問題不應直接假設為「原圖尚未載入」。

## Trace 證據

正常狀態 `Profile-20260807T011206.json`：

```text
Dropped frames: 167
CompositeLayers: 2301.8 ms
RasterTask: 1560.2 ms
ImageDecodeTask: 1872.0 ms
Decode Image: 2988.9 ms
ImageUploadTask: 101.0 ms
Paint: 10.5 ms
Layout: 36.8 ms
GPUTask: 1048.0 ms
GPU memory peak: 約 116 MiB
```

隱藏卡片 A/B `Profile-20260807T011322-birdviewab.json`：

```text
Dropped frames: 7
CompositeLayers: 143.6 ms
RasterTask: 2.7 ms
ImageDecodeTask: 429.9 ms
Decode Image: 355.1 ms
ImageUploadTask: 18.2 ms
Paint: 4.5 ms
GPUTask: 80.2 ms
GPU memory peak: 約 86.7 MiB
```

目前最可靠的結論：

- 主要瓶頸不是 JavaScript、Layout 或主執行緒 Paint。
- 主要瓶頸在高解析度圖片造成的 GPU Raster、Image Upload 與 Composite。
- 隱藏卡片後 Raster 與 Composite 幾乎消失，證明圖片內容本身是核心因素。
- 不應只繼續調整 `requestAnimationFrame`、Layout 或一般 CSS 小優化。

## 已嘗試的方案與結果

### 1. 移動期間將原圖降回縮圖

相關 commit：

```text
e9b62e6 perf: downgrade images during camera motion
```

結果：

- 使用者感覺沒有變順。
- 圖片恢復清晰速度變慢。
- 已在工作樹中 staged rollback，尚未建立新的 rollback commit。

不要直接假設這個 commit 是目前有效方案。

### 2. 移動期間暫停原圖 queue

結果：

- 沒有明顯改善卡頓。
- 圖片清晰速度變慢。
- 已撤回。

### 3. 每張卡片加入 `will-change`

結果：

- 沒有改善。
- 可能增加 layer 與 GPU memory 壓力。
- 已撤回。

### 4. `contain: paint`

結果：

- 沒有明顯改善。
- 已撤回。

### 5. 移動時隱藏 grid 與 labels

目前仍保留：

```css
.viewport.is-panning .grid-layer,
.viewport.is-panning .labels-layer {
  visibility: hidden;
}
```

結果：

- 主觀上稍微變順。
- 但無法解決主要卡頓。

### 6. 平移期間只更新 world transform

`plugin.js` 的 `renderCamera()` 在 `state.isPanning` 時提前返回，延後：

- viewport media window
- labels
- 中央選取
- 自動探索

結果：

- 減少了非必要工作。
- 但圖片 GPU Raster／Composite 仍是主要瓶頸。

### 7. 已載入原圖時，移動期間只顯示快取縮圖

目前 `media-materializer.js` 有：

- `setMotionImageQuality()`
- `applyMotionImageQuality()`

行為：

- 原圖留在 DOM。
- 原圖仍可在背景載入與 decode。
- 移動期間顯示已載入的 thumbnail。
- 移動結束切回 original。
- 不重新下載、不重新建立 `<img>`。

測試已確認圖片不會消失，也不會重新建立圖片元素。

但使用者目前仍觀察到移動後約 0.5 秒才清晰，代表問題可能是 compositor raster 延遲，或原圖實際 decode 尚未完成。

### 8. 平移不再提升整個 `.world` layer

最新實驗：

- 純平移時移除 `.world.is-moving`。
- 只有縮放時使用 `will-change: transform`。
- 平移結束時避免因尚未同步的 scale 狀態重新提升 world layer。

結果：

- 使用者回報仍然會卡。
- 尚未證明這個方案有效。

## 重要程式位置

- 相機與平移：
  - `plugin.js` 的 `startViewportPan()`、`finishViewportPan()`
  - `plugin.js` 的 `renderCamera()`
  - `plugin.js` 的 `keepCameraLayerPromoted()`
  - `plugin.js` 的 `runViewportWork()`
- 圖片載入與切換：
  - `media-materializer.js` 的原圖建立、load、decode 流程
  - `media-materializer.js` 的 `setMotionImageQuality()`
  - `media-materializer.js` 的 `applyMotionImageQuality()`
- Queue：
  - `media-load-queue.js`
  - 目前原圖併發上限是 4
- CSS：
  - `styles.css` 的 `.world`
  - `styles.css` 的 `.world.is-moving`
  - `styles.css` 的 `.media-frame img`

## 目前 Git 狀態

目前沒有 commit 最新實驗。

`HEAD` 是：

```text
e9b62e6 perf: downgrade images during camera motion
```

工作樹包含：

- staged：撤回 `e9b62e6` 的部分變更
- unstaged：快取縮圖切換、平移 layer 實驗、測試與文件
- 未追蹤 trace：

```text
Profile-20260807T011206.json
Profile-20260807T011322-birdviewab.json
```

不要使用 destructive git 指令，也不要直接 reset，因為 staged／unstaged 內容都包含前面實驗的結果。

## 測試狀態

最新一次：

```text
npm test
35/35 passed
```

`git diff --check` 也通過。

## 當時的「建議下一步」已作廢

原本這裡建議下一個 agent 去區分兩種情況：

- 情況 A：原圖尚未完成 decode
- 情況 B：原圖已 ready 但 compositor／layer 有問題

**兩個都不是答案。** 實際原因是第三種：原圖早已載入完成，但它是 40 MP 的全解析度母檔，每次 raster 都超出 Chromium 的 image decode cache 而被重新解碼。照著 A／B 去查會一路查錯方向——這也正是文件前半段那些 `will-change`／`contain`／layer 實驗全部無效的原因。

完整的分析、修正與後續兩輪 trace（預算只增不減、平移期間不載入）記錄在：

[performance-best-practices.md](./performance-best-practices.md)

那份文件是這個主題目前的單一事實來源。本文件只保留當時的調查過程與失敗嘗試，供了解「為什麼那些方向沒用」時參考。

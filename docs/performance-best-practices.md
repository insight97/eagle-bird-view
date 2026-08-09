# Bird View 媒體白板效能最佳實務

研究日期：2026-07-27
適用情境：classic JavaScript、DOM media cards、可平移／縮放白板，在約 100–200 張圖片時，拉遠後移動或 Ctrl＋方向鍵跨列聚焦出現卡頓。

本文只整理高信任的一手來源與本專案的對照結果，不修改產品程式碼，也不把尚未經過 Eagle 內建 Chromium 實測的做法視為已驗證修正。

## 結論先行

本專案已經具備基本的 DOM windowing：只掛載可視節點、保留附近節點，遠處節點釋放媒體與 DOM；相機也以 `requestAnimationFrame` 合併更新，白板主要使用 `transform` 平移／縮放。這代表「把所有 100–200 張卡片全部改成虛擬化」不會是第一個應做的改動。

目前更值得優先驗證的假設是：

1. **跨列聚焦的每一幀可能同時做相機合成與標籤重新定位。** `renderCamera()` 在縮放改變時呼叫 `updateMountedLabelPositions()`；該路徑會對已掛載標籤寫入 `left`、`top`、`width`。這是根據目前程式路徑做的推論，必須用 Performance trace 確認是否出現 Recalculate Style、Layout 或 Paint。
2. **拉遠後，screen-space viewport 會涵蓋較多白板節點。** 目前 `mountMargin` 是 viewport 最大邊，保留範圍再乘上 3 個 viewport；低 zoom 時，`visibleNodes`、`retainedNodes`、媒體卡片與標籤數量可能一起上升。這是本專案的幾何／掛載行為，不等同於瀏覽器必然會卡頓。
3. **`will-change` 與合成層不是免費的 GPU 加速。** 將整個大型 `.world` 或每張卡片都提升成 layer 可能增加 texture memory、GPU upload 與 layer 管理成本；官方建議先測量，再只在即將動畫的少數元素上短時間使用。
4. **圖片解碼與合成要分開觀察。** 本專案原圖已在替換到畫面前呼叫 `decode()`，但縮圖在 `load` 後直接顯示；若 trace 顯示 Image Decode 或 raster 成為尖峰，才值得調整縮圖交換時機或載入策略。

Chrome 的官方效能模型把每幀工作分成 JavaScript、style、layout、paint 與 composite；動畫／平移的目標是盡量只走 composite，但 `transform` 仍可能因 layer、raster、圖片與主執行緒工作而卡頓。[web.dev：Rendering performance](https://web.dev/articles/rendering-performance)；[web.dev：Animations and performance](https://web.dev/articles/animations-and-performance)

## 已量測並修正：高解析度原圖的 decode cache 抖動（2026-08-07）

上述第 4 點在 2026-08-07 的 trace 中得到確認，而且是當時卡頓的**主因**，與 layer 提升無關。

`PaintImage` 直接顯示了問題：

```text
src 5374 × 7589（40.8 MP）  →  實際畫在 120.98 × 170.84
src 4000 × 3000（12 MP）    →  實際畫在 213.33 × 159.98
```

Eagle 的 `fileURL` 是全解析度母檔，而 `thumbnailURL` 只有 320px 長邊，中間沒有任何階梯。`wantsOriginalImage()` 一旦判定卡片夠大，就直接把 40 MP 的母檔交給 compositor：單張解碼後就是 156 MiB RGBA，本身已超過 Chromium image decode cache 的預算。

結果是每次 raster 都 cache miss 並重新解碼：

```text
同一個 LazyPixelRef 在 7 秒內被 decode 6 次
>150ms 的 decode 共 14 次，合計約 2.9 秒
全部發生在 CompositorTileWorker1~4，也就是產生 frame 的關鍵路徑
```

A/B 對照（隱藏 `.media-card`）：`RasterTask` 1560ms → 2.7ms，大型 decode 14 次 → 1 次。

### 為什麼 layer 類的嘗試都無效

`will-change`、`contain: paint`、`translate3d`、調整 `.world` 提升時機、暫停原圖 queue，調整的都是 composite 與載入。成本在 raster worker 的 decode，只要母檔還是 paint source，重新 raster 就一定重新解碼。「移動結束後約 0.5 秒才清晰」也不是 queue 排程太晚，而是切回母檔後的一次完整 decode。

### 採用的修正：bounded raster

母檔不再作為 paint source，改成先渲染一張有上限的點陣圖再交給 compositor：

- `bird-view-core.js` 的 `getRasterTargetSize()`／`getRasterDimensionBudget()` 是純函式，依卡片在螢幕上的最長邊決定預算，量化成 512／1024／2048／4096 四階，讓平移與小幅縮放不會反覆重繪。
- `image-downscaler.js` 以 `fetch()` 取得編碼位元組後交給 `createImageBitmap(blob, { resizeWidth, resizeHeight })`，讓瀏覽器**直接解碼到目標尺寸**；JPEG 會在 DCT 階段就縮放，全解析度點陣圖完全不會產生。編碼優先走 `OffscreenCanvas.convertToBlob()`，讓 WebP encode 離開主執行緒。
- 若 `fetch` 讀不到檔案（例如 file:// 被擋），退回讓 `<img>` 載入母檔再從元素縮圖；這條路仍能消除重複解碼，但省不掉第一次全解析度解碼。兩條路都失敗才直接顯示母檔。
- `media-materializer.js` 在載入前就用 Eagle metadata 的 `item.width`／`item.height` 算出目標尺寸，所以不必先解碼才知道要縮多少。縮放超過目前預算時透過 `MediaLoadQueue.invalidate()` 重新算一張，期間畫面維持既有 raster 不閃爍。

效果：40 MP 母檔在一般 zoom 下只需 512 長邊（約 0.74 MB 解碼），15 張卡片合計約 11 MB，可完整放進 decode cache。

### 連帶移除：移動期間的縮圖降級

原本 `setMotionImageQuality()` 會在平移／縮放期間把畫面換成 320px 縮圖，那是為了掩蓋母檔 raster 成本而加的。bounded raster 之後這個降級只剩副作用——縮放時整個白板變模糊——因此連同 `applyMotionImageQuality()` 一起移除。

這是個通則：**為了掩蓋某個成本而加的降級，在成本被真正消除後必須跟著移除**，否則它會變成新的品質問題，而且很難歸因。

### 第二輪 trace：預算只增不減（`Profile-20260807T021434.json`）

bounded raster 上線後 `RasterTask` 從 1560ms 降到 253ms／7981 次（平均 0.03ms），但仍有殘留卡頓。`PaintImage` 顯示原因：

```text
src 2901 × 4096  →  實際畫在 127 × 180   過取樣 520 倍
src 2898 × 4096  →  實際畫在 118 × 167   過取樣 602 倍
```

`refreshRasterBudget()` 當時只會**升級**預算。使用者放大過一次後，卡片拿到 4096 長邊的 raster（單張 47 MB），縮小回去卻永遠不會還回來——等於用 4096 重演了原本 7589 的問題。

而且升級路徑本身也漏掉主要情況：`refreshRasterBudget()` 只對 `getQuality(node) === "original"` 的卡片執行，但縮小到 320px 門檻以下的卡片會回報 `"thumbnail"`，於是完全不會被重新檢視，就這樣一直畫著 4096 的 raster。

連帶症狀：主執行緒的 `CompositeLayers` 出現 9 次超過 100ms（最長 165ms）。時間軸顯示每次長 commit 都在某個 100–180ms 的 raster-thread decode 開始後約 15ms 啟動、並在該 decode 結束時同時結束——**主執行緒在 commit 階段同步等待圖片解碼**。這是症狀不是獨立問題。

修正：

- `refreshRasterBudget(node, { allowShrink })` — 放大時立即升級（否則畫面看得出模糊），縮小則只在相機停下（`sync()`）時執行，避免縮放手勢期間每 120ms 重繪一次。
- `dropOriginalRaster(node)` — 卡片掉到原圖門檻以下時，把 raster 交還並切回縮圖。

### 第三輪：載入追不上平移速度

卡頓解決後浮現的下一個問題，其實不是載入太慢，而是**平移期間完全不載入**。

`scheduleViewportWork()` 在 `state.isPanning` 時直接 return，所以整個拖曳過程沒有任何 mount 或 load，要等放開手才開始。`getViewportWorkInterval(isPanning)` 本來就回傳 250ms，代表原本設計過平移期間的節流節奏，但那條分支已經變成無法到達的死碼。

第二個因素：`preloadMargin` 固定 120px，且不知道相機往哪走。就算恢復載入，也是等素材快進畫面才開始抓。

修正：

- `runPanMediaWork()` — 平移期間以 250ms 節流只跑 `updateMediaVisibility()`；label、中央選取與自動探索仍然延後到手勢結束。
- `getPreloadMargins(travel, base, maxLead)` — 純函式，依上一輪的相機位移只在**前進方向**加大預載帶（`PRELOAD_LEAD_FACTOR = 2`，約兩輪的runway），並以 mount 範圍為上限。四個方向平均加大會在相機正在離開的三個方向白做工。

代價要講清楚：平移期間現在會建立 DOM。bounded raster 讓 raster／decode 變便宜之後，卡片 DOM 建立很可能成為平移期間新的主要主執行緒成本，若之後再出現卡頓，這是第一個該量的地方。

### 第四輪：移除 `.world` 的 layer 提升

`keepCameraLayerPromoted()` 會在縮放期間為 `.world` 加上 `will-change: transform`，settle 後 100ms 移除。它存在的理由是避免縮放每幀重新 raster 整個 world——而那個成本已經被 bounded raster 消掉了（`RasterTask` 7981 次共 253ms）。

剩下的只有副作用：will-change 會釘住 compositor 的 raster scale，所以縮放期間畫面是被拉伸的舊點陣圖。因此整套移除：`keepCameraLayerPromoted()`、`CAMERA_SETTLE_DELAY`、`SMOOTH_ZOOM_RASTER_VELOCITY_THRESHOLD`、`cameraSettleTimer`、`skipCameraLayerPromotion` 與 `.world.is-moving`。

平移路徑本來就沒有提升，而平移是順的，所以縮放改走同一條路是有依據的，不是猜測。

`test/integration/camera-layer.test.js` 現在斷言相反的不變條件：`.world` 不會被加上任何 class，且 `styles.css` 裡沒有任何 `.world` 規則帶 `will-change`。

### 第五輪：縮小預算階梯的過取樣

檢討有損／無損時發現的：真正在丟資訊的是縮放不是編碼（5374×7589 → 363×512 已經丟掉 99.8% 的像素，WebP q0.92 相較之下是捨入誤差），而且**編碼格式完全不影響效能**——decode 後的記憶體是 `寬 × 高 × 4`，與格式無關。所以換 PNG 只會無損地保存一張已經被大幅縮小的圖，並付出數倍的編碼時間。

真正的浪費在別處：預算原本以 2 的次方往上取，卡片因此拿到比實際能顯示多 1～2 倍線性（1～4 倍像素）的 raster。那些像素**永遠不會被顯示**，只佔記憶體、拉長 decode。

階梯改成在每個 octave 中間插一階：

```text
512 → 768 → 1024 → 1536 → 2048 → 3072 → 4096
```

因為所有 2 的次方都仍在階梯上，新預算**只會小於或等於**原本的選擇，不可能更大——這點有 property 測試逐值驗證（400～4200）。過取樣上限從 4 倍像素降到 2.25 倍，實測各級距約省 31%，最佳情況 44%。

沒有任何卡片會取樣不足：不變條件仍是「預算 ≥ 卡片實際顯示的裝置像素」。

### 第六輪 trace：raster 路徑已乾淨，瓶頸換成 GC（`Profile-20260807T111743.json`）

39.5 秒、瀏覽 322 張卡片。原始問題確認解決：

```text
Decode Image @ CompositorTileWorker*   369 ms / 224 次   （原本 3613 ms）
RasterTask                             315 ms / 21127 次（平均 0.015 ms）
CompositeLayers                        250 ms / 1989 次  （原本 1707 ms，其中 9 次 >100 ms）
```

decode 已完全離開 raster 關鍵路徑——全部落在 `ThreadPoolForegroundWorker`，也就是 `createImageBitmap`。

但仍有 226 dropped frames。主執行緒有 247 個 >16ms 的 task、49 個 >50ms，而其中最大宗是 `RunMicrotasks`（60–80ms）。展開後裡面幾乎全是 GC：`MajorGC`、`V8.GC_MARK_COMPACTOR`，以及關鍵線索 **`V8.ExternalMemoryPressure`**——外部記憶體（blob、ImageBitmap、解碼後的母檔）在逼出 major GC。

記憶體計數器確認**不是洩漏**：jsHeap 全程穩定在約 32 MB，nodes／listeners 隨掛載釋放起伏。是**短期配置量太大**：39.5 秒內建了 167 張 bounded raster，每張都要在 `createImageBitmap` 內完整解碼一次母檔（合計 24.9 秒，平均 58 ms）。

原因是第三輪「平移期間持續載入」矯枉過正：平移會掃過幾百張只出現一瞬間的卡片，而每張只要超過 320px 門檻就會去抓原圖。

修正：`sync()` 新增 `deferOriginals`，平移期間尚未取得原圖的卡片只載縮圖，相機停下再補。縮放不套用——縮放才是使用者在判斷銳利度的時候，而且不會掃過幾百張。

**這和已移除的 `setMotionImageQuality()` 是不同的東西**，容易混淆：那個會把**已載入**的原圖降級成縮圖，導致整個白板在縮放時變模糊；這個只是延後**尚未開始**的載入，已經有 raster 的卡片完全不受影響。測試把這個區別明確釘住。

### 第七輪 trace：延後根本沒有生效（`Profile-20260807T112528.json`）

第六輪的修正沒有降低 decode：24883ms → 24365ms（幾乎不變）。原因在輸入事件的分布：

```text
InputLatency::RawKeyDown   502
EventDispatch keydown      251
pointerup                    1
```

**這位使用者是用鍵盤瀏覽，不是拖曳。** 而 `deferOriginals: state.isPanning` 只在指標拖曳時為真——`startViewportPan()` 是唯一設定它的地方。鍵盤平移走 `smoothPanFrame`（平滑模式）或每次 keydown 直接 `panBy`（離散模式），兩者都不碰 `isPanning`，所以延後一次都沒有觸發。

更糟的是同一個判斷也決定了排程模式：鍵盤平移期間 `scheduleViewportWork()` 走的是 **settled** 分支，也就是相機正在飛越白板時，每 100ms 跑一次完整維護（labels、中央選取、自動探索）。

修正：`isCameraMoving()` 改問「相機是否在動」而不是「哪個輸入裝置在動」，涵蓋 `isPanning`、`isSmoothZooming`、`smoothPanFrame`、`cameraFocusFrame`，再加上「最近 180ms 內相機是否變動過」作為兜底——後者同時涵蓋離散鍵盤重複與滾輪縮放，那兩者也都沒有持續性狀態旗標。

因為時間窗比 settled 間隔長，落在飛行途中的那一次 pass 會延後並重新排程，而不是誤判相機已停。`runViewportWork()` 因此必須在延後時自行重排——相機停止後 `renderCamera` 不再觸發任何排程，沒有別的東西會喚醒它。

### 第八輪 trace：延後生效了，但編碼在主執行緒（`Profile-20260809T184537.json`）

`isCameraMoving()` 修正後：

```text
母檔解碼（jpg+png）  235 次 / 20.0 s  →  68 次 / 6.9 s
Decode Image 總計    24365 ms / 476×  →  11302 ms / 134×
GC background        5095 ms / 923×   →  2456 ms / 398×
```

建的 raster 少了 71%。但主執行緒仍有 43 個 >50ms 的 task，展開後大宗是 `RunMicrotasks`，而其中 GC 只佔 205ms／1534ms——其餘無法從 trace 事件歸因。

V8 CPU profile 給出答案：

```text
1911 ms  convertToBlob
1805 ms  step @camera-navigation.js:312
 552 ms  (garbage collector)
```

**`OffscreenCanvas.convertToBlob()` 並沒有離開主執行緒。** 規格寫「in parallel」，但在主執行緒建立的 OffscreenCanvas 上，Chrome 實際在主執行緒做讀回與編碼。68 張 raster × 約 28ms，正是那些 67ms 微任務區塊。

### 採用的修正：canvas + `bitmaprenderer`

不再編碼成 WebP 再塞進 `<img>`，改成把 `ImageBitmap` 直接轉移進 `<canvas>`：

```js
canvas.getContext("bitmaprenderer").transferFromImageBitmap(bitmap)
```

零複製。一次消除編碼（1911ms）、blob URL 生命週期、WebP 的第二次解碼（58 次／4219ms），以及有損重編碼本身。

代價與注意事項：

- canvas 的記憶體是**釘住的**，不像 `<img>` 由 decode cache 管理。預算階梯與縮小邏輯把尺寸綁住了，但 retained（未 release）的卡片會一直持有 backing store，所以 `release()` 必須把 `width`／`height` 歸零，只移除元素是不夠的。
- `<img>` 靠 CSS `image-orientation: from-image` 處理 EXIF 旋轉；canvas 畫什麼就是什麼，所以旋轉必須在 `createImageBitmap({ imageOrientation: "from-image" })` 時烘進 bitmap，否則直式照片會躺著。
- `transferFromImageBitmap` 會消耗 bitmap，之後不必也不能再 `close()`。

另一半的 `step @camera-navigation.js:312`（1805ms）是平滑平移／縮放的動畫迴圈，屬於既有程式碼，與圖片管線無關。

### 可推廣的判準

- 先問「來源像素量與實際顯示像素量差幾倍」，再問 layer 怎麼提升。差距達兩、三個數量級時，任何 CSS hint 都救不了。
- `Decode Image` 的 `imageType` 沒有尺寸資訊，但 `PaintImage` 的 `srcWidth`／`srcHeight` 對上 `width`／`height` 就能直接算出過取樣倍率；`Decode LazyPixelRef` 的重複 id 則能證明 cache 抖動。
- 任何「依畫面尺寸調整資源品質」的機制，**降級路徑和升級路徑一樣重要**，而且要分別確認兩者的觸發條件涵蓋所有狀態。這次升級與降級各漏了一種情況：預算不會下降，以及掉出門檻的卡片完全不再被檢視。只測放大不會發現任何一個。
- 主執行緒 `CompositeLayers` 異常長、但內部沒有對應的主執行緒子事件時，先對照 raster thread 的 decode 時間軸；commit 會同步等待當幀需要的圖片解碼，長 commit 往往只是解碼太慢的投影。
- **不要相信「這個 API 在背景執行」的直覺，用 CPU profile 確認。** `OffscreenCanvas.convertToBlob()` 的規格寫 in parallel，我據此在 commit 訊息裡寫了「encode 離開主執行緒」，實際上它佔了主執行緒 1911ms。trace 的事件層級看不出來（那段時間只會顯示為 `RunMicrotasks`），要靠 ProfileChunk 裡的 V8 CPU profile 才看得到函式名稱。長微任務內若 GC 佔比不高，就該直接去看 CPU profile。
- **先確認使用者實際怎麼操作，再決定優化掛在哪個狀態上。** 「平移」在程式裡被等同於 `isPanning`，而那只涵蓋指標拖曳；實際使用者幾乎全用鍵盤。任何「手勢期間如何如何」的優化，都要先問「這個旗標涵蓋所有讓相機移動的路徑嗎」。trace 裡的 `InputLatency::*` 與 `EventDispatch` 分布可以直接回答。
- 條件要描述**狀態**（相機在動嗎）而不是**成因**（指標按下了嗎）。以成因命名的旗標會隨著新增輸入方式默默失效，而且不會有任何測試變紅。
- 主執行緒的長 task 若展開後只有 GC，不要去找「哪段 JS 慢」。看 `V8.ExternalMemoryPressure` 與記憶體計數器：heap 平穩就不是洩漏，而是短期配置量太大，該減少的是**產生配置的次數**，不是配置本身的大小。
- 「動畫期間延後昂貴工作」是對的，但要逐項判斷延後的代價。延後 label 與選取沒有後果；延後 media window 的後果是使用者到了目的地才開始載入。當一個常數（`getViewportWorkInterval(true) = 250`）沒有任何呼叫端能到達時，通常代表某次收緊把原本的分層壓成了一刀切。

## 本專案現況對照

| 路徑 | 目前行為 | 與卡頓的關聯 |
| --- | --- | --- |
| 相機動畫 | `camera-navigation.js` 以 `requestAnimationFrame` 插值 camera；每幀呼叫整合層的 `updateCamera()`。 | 跨列聚焦同時改變位置與 scale，會觸發較多下游更新。 |
| 白板 transform | `plugin.js` 的 `renderCamera()` 每幀更新 `.world` 的 `transform`，並更新 grid transform。 | transform 是正確的動畫 seam，但大型 layer 的 raster／composite 成本仍需實測。 |
| 相機工作節流 | 拖曳期間只留在 camera transform path；掛載、釋放、標籤與自動探索延後到手勢結束或 timer。 | 這個方向符合「動畫期間少做非必要工作」的原則；跨列動畫需確認 `cameraFocusFrame` 期間是否仍讓昂貴工作進入每幀。 |
| 媒體 windowing | `updateMediaVisibility()` 取得 visible、retained、load 三種集合；`MediaMaterializer` 對非可視卡片 unmount，對遠處卡片 release；目前保留範圍為 2 個 viewport。 | 已有虛擬化，但 overscan 是固定 screen-space margin；低 zoom 時仍可能保留較多卡片。 |
| 卡片與標籤 | 卡片位於 `.world`；標籤在獨立 `.labels-layer`，縮放改變時重新計算已掛載標籤位置。 | 標籤的 `left`／`top`／`width` 寫入是跨列動畫的主要可疑主執行緒工作。 |
| 圖片 | 先載入 thumbnail；畫面高度達門檻後以最多 4 路併發載入 original；原圖替換前等待 `decode()`。 | queue 與釋放策略已避免無限載入；需在 trace 中區分網路、decode、raster 與 DOM 更新。 |
| layer hint | `.world.is-moving` 只在縮放 raster 需要時動態設定 `will-change: transform`；純平移不提升整個 world；`.grid-layer` 與 `.labels-layer` 常駐 `will-change: transform`。 | 避免平移結束後等待整個 world 重新 raster；grid／labels 常駐 hint 是否有益仍應用 layer borders 驗證。 |

相機與媒體範圍的具體實作可參考：[camera-navigation.js](../camera-navigation.js)、[plugin.js](../plugin.js)、[media-materializer.js](../media-materializer.js)、[styles.css](../styles.css)。這些是本專案的觀察，不是外部效能保證。

## 1. DOM virtualization／windowing

### 官方原則

List virtualization（也叫 windowing）只渲染目前可見內容，視窗移動時替換離開範圍的 DOM；官方說明指出這能讓渲染與捲動效能不隨完整資料集的 DOM 數量線性惡化。[web.dev：Virtualize large lists with react-window](https://web.dev/articles/virtualize-long-lists-react-window)

這個例子使用 React library，但原則本身與 framework 無關：classic JS 可以用座標索引、row bounds、overscan 集合與可重用 DOM 達到同樣效果。對 Bird View 而言，現有 `getNodesNearViewport()`、`MediaMaterializer.sync()` 與 `release()` 已經是手寫的 windowing seam。

### 本專案可採用做法

- 先保留現有的可視／保留／載入三層，不要因為「100–200 張」就把所有卡片常駐。
- 以實測的卡片數作為 overscan 上限，而不是只以固定 viewport 倍數決定；可以讓拖曳方向前方有較大的預載區、後方較小，並為跨列落點單獨預熱目標列。
- 低 zoom 時優先減少非必要 DOM（例如標籤詳細資料、按鈕與互動 metadata），不要為了讓跳躍看起來連續而盲目把整個 3-viewport retained window 擴大。
- 若跨列跳躍距離很大，允許先完成 camera transform，再批次掛載落點附近卡片；視覺上可保留 thumbnail placeholder，但不要在動畫每一幀同步建立大量 DOM。

### 風險與限制

- 過小的 window 會造成跨列落點短暫空白、選取目標不在 DOM、影片控制與右鍵行為延遲；`selectedNode` 必須維持例外保留。
- `content-visibility: auto` 可以作為額外的瀏覽器層級 windowing，而不是現有手動 windowing 的替代品。它會讓瀏覽器跳過 off-screen subtree 的 layout、style 與 paint；`auto` 仍讓內容留在 DOM 與 accessibility tree。[web.dev：Skip rendering work with `content-visibility`](https://web.dev/articles/content-visibility)；[MDN：content-visibility](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/content-visibility)
- `content-visibility` 需要正確的外部尺寸；使用 size containment 時應提供 `contain-intrinsic-size`，否則未渲染內容可能被當成空內容計算而造成尺寸跳動。[web.dev：content-visibility 的 contain-intrinsic-size 說明](https://web.dev/articles/content-visibility#specify_the_natural_size_of_an_element_with_contain-intrinsic-size)
- Bird View 使用絕對定位、祖先 transform、手動 hit testing／選取與卡片內互動控制；每張 `.media-card` 直接套 `content-visibility: auto` 可能改變「何時可命中、何時可繪製、何時可取得 layout」的時機。官方也提醒，若程式呼叫會強制渲染的 DOM API，可能抵銷 `content-visibility` 的收益。[web.dev：content-visibility 的 DOM API 注意事項](https://web.dev/articles/content-visibility#content-visibility)
- 因此 `content-visibility` 應先做可切換的 A/B 實驗，優先套在明確 chunk 的 row wrapper；目前卡片是散落在 `.world` 的絕對定位節點，沒有現成 row DOM wrapper，不能直接假設套用後一定有效。

## 2. `content-visibility` 與 `contain`

### 官方原則

CSS containment 讓瀏覽器知道某個 subtree 與外部較獨立，因此可以隔離 style、layout、paint 或 size 計算。[MDN：Using CSS containment](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Containment/Using)；規範定義則見 [W3C CSS Containment Module Level 3](https://www.w3.org/TR/css-contain-3/)。

`content-visibility: auto` 會啟用 layout、style、paint containment，並在元素不接近 viewport 時跳過內容渲染；`content-visibility: hidden` 則保留 rendering state，但不會自動在進入 viewport 時顯示內容。[MDN：content-visibility 的值與 containment 行為](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/content-visibility#values)

### 本專案建議

優先級低於「讓跨列動畫只更新相機層」與「確認 window size」。若要試：

1. 先針對一個可明確估算尺寸的 row wrapper，設定 `content-visibility: auto` 與合理的 `contain-intrinsic-size`。
2. 以相同資料、相同 zoom、相同跨列距離比較 Performance trace；比較 Recalculate Style、Layout、Paint、Composite Layers、卡片可互動性與首次顯示延遲。
3. 若保留現有每張卡片的手動 release，確認 `content-visibility` 沒有讓「已掛載但不可見」與「已釋放」兩種狀態變得難以推理。

`contain: paint` 或 `contain: strict` 也不能當成通用加速開關。containment 會改變 subtree 對外的 layout／paint 邊界；卡片有 overflow、container query、影片控制、原圖重換與旋轉，必須逐項測試 clipping、focus、context menu、標籤與影片播放。若只是要把卡片從 DOM 移除，現有 `release()` 的語意更直接、可預期。

## 3. CSS `transform`、`will-change` 與 compositing

### 官方原則

動畫盡量使用 `transform` 與 `opacity`，因為可避免部分 layout／paint 工作並走較便宜的 composite path；但這個好處成立的前提是瀏覽器能以合適的 layer 處理，而且合成層數量本身也有成本。[web.dev：Stick to compositor-only properties and manage layer count](https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count)；[web.dev：Animations and performance](https://web.dev/articles/animations-and-performance)

`will-change` 只是 rendering hint，不是「開啟 GPU 加速」的保證。MDN 明確建議只在確實要變化的少數元素上使用、不要套用到過多元素，因為可能增加記憶體與更複雜的 rendering；可在動畫前設定，動畫結束後移除。[MDN：will-change](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/will-change)

W3C 的 Will Change 規範也說明，元素與其內容可能被提升為獨立 layer，讓 transform 改變時不必重繪其他內容，但 layer 不是無成本的抽象。[W3C：CSS Will Change Module Level 1](https://www.w3.org/TR/css-will-change/)

### 本專案判斷

- `.world` 的單一 camera transform 是合理的主動畫 seam；不要把每張 `.media-card` 都加 `will-change: transform`。那會把 100–200 張圖片／卡片轉成大量候選 layer，可能比原本更慢。
- `.world.is-moving` 只在縮放造成 raster 尺寸變化時出現、settle 後移除；純平移不提升整個 world，避免放開後等待大型 layer 重新 raster。仍必須用 Layer Borders、GPU memory 與 trace 驗證收益。
- `.grid-layer` 與 `.labels-layer` 的常駐 `will-change` 應視為可疑的獨立實驗，不要和 `.world` 的效果混為一談。若 layer borders 顯示沒有收益，移除常駐 hint 可能降低記憶體壓力。
- 變更 `transform` 不代表每幀只剩 composite。跨列動畫若同時更新標籤 `left`／`top`／`width`、class 或圖片狀態，仍可能觸發 style/layout/paint；必須看 trace，不可只看程式碼中的 `transform` 字串。

## 4. `requestAnimationFrame` 與 pan/zoom rendering

### 官方原則

`requestAnimationFrame()` 會在下一次 repaint 前呼叫 callback，通常與顯示器更新頻率同步；它是 one-shot，持續動畫必須在 callback 內再次排程，並且應使用 callback 的 timestamp 計算進度，以免高更新率螢幕上動畫速度錯誤。[MDN：Window.requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)

Chrome DevTools 的官方文件把 `Request Animation Frame`、`Animation Frame Fired`、style/layout invalidation、Image Decode、Paint 與 Composite Layers 串成可追蹤的事件；Performance panel 也能分辨 dropped frame 與 partially presented frame。[Chrome DevTools：Performance features reference](https://developer.chrome.com/docs/devtools/performance/reference/)；[Chrome DevTools：Timeline event reference](https://developer.chrome.com/docs/devtools/performance/timeline-reference)

### 本專案可採用做法

- 保留目前 `updateCamera()` 的 rAF coalescing；不要在 pointermove、wheel、keydown 各自建立獨立的每幀更新迴圈。
- 讓 camera animation 的每幀只更新必要的 transform／grid；將標籤重排、DOM mount/release、選取重算、探索查詢與圖片品質切換延後到動畫完成或低頻排程。
- 對 Ctrl＋方向鍵跨列聚焦，採用「動畫中的輕量模式」：保留相機位置插值，暫停非必要 label detail／DOM 變更，落點穩定後一次更新標籤與媒體 window。這是本專案的候選設計，不是外部文件保證，需確保選取、鍵盤焦點與可見內容不會錯位。
- 若動畫仍有明顯長幀，可按距離、scale 差距或掛載節點數自適應縮短 duration，或在低階裝置／`prefers-reduced-motion` 下關閉平滑聚焦。不要單純把所有動畫改成 CSS transition，因為目前 camera 狀態需要可取消、可插值並與媒體 window 協調。

## 5. 圖片 loading、decode 與 raster

### 官方原則

`HTMLImageElement.decode()` 回傳 Promise，直到圖片已解碼且可以安全加入 DOM；先解碼再把圖片呈現，可以避免「加入 DOM 的下一幀」因解碼而延遲。[MDN：HTMLImageElement.decode()](https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/decode)

`decoding="async"` 是提示瀏覽器不要讓其他 DOM 內容等待圖片同步解碼；對 JavaScript 動態插入圖片時，差異可能比較明顯。[MDN：`<img>` 的 decoding 說明](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/img#decoding)

瀏覽器原生 `loading="lazy"` 會把 offscreen 圖片延後到接近 viewport 才載入；官方同時提醒，初始 viewport 內的圖片不應盲目 lazy-load，且 `loading` 距離門檻由瀏覽器決定。[web.dev：Browser-level image lazy loading](https://web.dev/articles/browser-level-image-lazy-loading)；[MDN：`<img>` 的 loading 說明](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/img#loading)

### 本專案判斷

- 目前原圖在 `load` 後等待 `decode()` 再替換 thumbnail，這是合理的防止突然卡幀做法，應保留。
- 縮圖目前在 `load` callback 直接顯示；若 Performance trace 出現 thumbnail 的 Image Decode／Paint 尖峰，可試著在 `load` 後等待短 timeout 受控的 `decode()`，再切換 visibility。風險是 decode 會延後縮圖出現，且若把 queue slot 持有到 decode 完成，可能降低載入吞吐；應以「動畫流暢度 vs 首次顯示延遲」衡量。
- 已有 `MediaLoadQueue` 的四路併發與遠處 release，不要同時再無條件加上 browser lazy loading，否則會形成兩套門檻，可能讓跨列落點載入太晚。原生 lazy loading 比較適合在放棄自訂 queue、或用來處理真正由瀏覽器管理的長頁面時使用。
- 原圖顯示門檻應與 zoom 和畫面實際尺寸掛鉤；低 zoom 時大量 original decode／raster 會增加 GPU memory 與 paint 壓力。這部分目前已有 `ORIGINAL_IMAGE_MIN_HEIGHT`，改動前先在 trace 確認是否真的進入 original path。

## 6. 建議的驗證順序

先建立可重現案例：同一批 100、150、200 張圖片，固定 viewport 與 zoom；分別錄製「拉遠後拖曳」和「Ctrl＋方向鍵跨一列／跨兩列」。Chrome 官方建議使用 Performance panel、FPS meter、paint flashing、layer borders 與 GPU／raster 資訊定位，而不是只用主觀 FPS 感覺。[Chrome DevTools：Analyze runtime performance](https://developer.chrome.com/docs/devtools/performance)；[Chrome DevTools：Discover rendering performance issues](https://developer.chrome.com/docs/devtools/rendering/performance/)

每次只改一個變因，記錄：

- dropped／partially presented frames、最長 frame duration、Animation Frame Fired 時間。
- Recalculate Style、Layout、Paint、Composite Layers、Image Decode、Image Resize 的總時間。
- `materializedNodes`、`mountedLabelNodes`、可視／保留節點數、目前 zoom 與是否正在載入 original。
- 跨列動畫期間是否執行 `updateMountedLabelPositions()`，以及標籤的 `left`／`top`／`width` 寫入是否造成 layout 或 paint。

可用以下症狀表快速判斷方向：

| Trace 症狀 | 優先調查 | 不要先做的事 |
| --- | --- | --- |
| Animation Frame Fired 內 Recalculate Style／Layout 很高，且與 label 更新同時出現 | 動畫期間延後 label layout；讓落點後一次定位 | 不要先增加 `will-change` |
| Paint 很高，paint flashing 覆蓋大量卡片或 label | 減少動畫期間非必要 DOM、label detail、box-shadow；必要時再測試 row/card containment | 不要只把 transform 改成 `translate3d` 就宣稱完成 |
| Composite Layers 或 GPU memory 很高 | 檢查 `.world` 尺寸、layer 數、常駐 `.grid-layer`／`.labels-layer` hint | 不要把每張卡片提升成 layer |
| Image Decode／Image Resize 佔尖峰 | 先用 `PaintImage` 比對 `srcWidth`／`srcHeight` 與實際 `width`／`height`；過取樣就改成 bounded raster（見上方 2026-08-07 段落），而不是調整交換時機 | 不要無條件提高併發數 |
| script／mount/release 長任務高 | 收斂 window、批次 DOM 變更、預先建立 row bounds／索引 | 不要只調 CSS |
| trace 幾乎沒有上述成本但仍卡 | 檢查 Eagle Chromium／GPU／影片解碼與裝置環境；比較硬體加速設定 | 不要把所有問題歸因於 DOM 數量 |

## 建議優先級與風險

### P0：先量測，不改產品行為

1. 對兩種重現路徑各錄一份 Performance trace。
2. 暫時以 DevTools Local Overrides 或 console style toggle 測試「動畫期間不更新 labels」的效果；只要能顯著改善，就把優化 seam 放在 camera／label 協調層。
3. 把節點數、標籤數、原圖載入數與 frame duration 對齊記錄，確認卡頓是 DOM、layout、paint、composite 還是 decode。

### P1：最可能對目前症狀有效

- 將跨列相機動畫拆成「輕量 camera transform」與「完成後的標籤／媒體同步」兩階段。
- 讓 overscan 依 zoom、方向與跳躍落點調整，並限制低 zoom 時的 retained card／label 數量；保留 selected node 與落點預熱例外。
- 保留動態 `.world.is-moving` hint，但用 trace 決定是否需要常駐 grid／labels hint；避免 per-card `will-change`。

### P2：有條件實驗

- 在 row wrapper 或明確尺寸 chunk 上試 `content-visibility: auto` + `contain-intrinsic-size`；目前沒有 row DOM wrapper，直接套卡片的收益與風險都較難預測。
- 若 trace 確認縮圖 decode 在動畫期間造成長幀，再試縮圖 `decode()` 後交換；須測量首張顯示延遲與 queue 吞吐。
- 若 200 張以外仍要擴展到數千張，才評估 canvas/WebGL 或更深的 retained-mode rendering；這會牽涉文字、鍵盤選取、右鍵、標籤編輯、影片與 accessibility，並不是目前症狀的低風險修正。

## 不建議的直覺修正

- 不要把所有卡片永久 `will-change: transform` 或 `translateZ(0)`；官方明確警告 layer 數與 GPU texture memory 會反過來傷害效能。[web.dev：Manage layer count](https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count)
- 不要只因為使用 `transform` 就假設每幀是 compositor-only；label 的 layout、圖片 decode、raster 與 layer upload 仍可能出現在同一幀。
- 不要在沒有尺寸模型與瀏覽器版本驗證時，對絕對定位卡片全面套 `content-visibility: auto`；它可能改變 rendering、hit testing 與 DOM layout API 的時機。[MDN：content-visibility](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/content-visibility)
- 不要單純提高圖片併發上限；更多同時 decode／resize 可能讓主執行緒或 GPU 更忙，且會放大記憶體壓力。
- 不要把 `setTimeout`、CSS transition 或 `requestAnimationFrame` 任一者當成普遍答案；要以 trace 判斷長幀所在的 pipeline 階段。

## 來源分組

- Rendering pipeline、動畫與 compositing：[web.dev Rendering performance](https://web.dev/articles/rendering-performance)、[web.dev Animations and performance](https://web.dev/articles/animations-and-performance)、[web.dev Stick to compositor-only properties](https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count)
- Windowing 與 DOM rendering：[web.dev Virtualize large lists](https://web.dev/articles/virtualize-long-lists-react-window)、[web.dev content-visibility](https://web.dev/articles/content-visibility)、[MDN Using CSS containment](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Containment/Using)
- CSS 規範與 hints：[W3C CSS Containment Module Level 3](https://www.w3.org/TR/css-contain-3/)、[W3C CSS Will Change Module Level 1](https://www.w3.org/TR/css-will-change/)、[MDN will-change](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/will-change)
- Animation timing 與圖片：[MDN requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)、[MDN HTMLImageElement.decode](https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/decode)、[MDN img](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/img)、[web.dev browser-level image lazy loading](https://web.dev/articles/browser-level-image-lazy-loading)
- 實測工具：[Chrome DevTools Performance](https://developer.chrome.com/docs/devtools/performance)、[Chrome DevTools Performance reference](https://developer.chrome.com/docs/devtools/performance/reference/)、[Chrome Rendering tab](https://developer.chrome.com/docs/devtools/rendering/performance/)

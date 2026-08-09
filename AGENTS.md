# Agent instructions

## 專案定位

這是 Eagle 的 Window Plugin，提供白板式圖片／影片瀏覽與探索功能。專案沒有 bundler 或編譯步驟；`index.html` 直接以 classic `<script>` 載入 JavaScript，Eagle 執行時使用瀏覽器全域物件，Node 測試則透過 CommonJS shim 載入相同模組。

先讀 `README.md` 了解產品行為，再依本文件處理程式碼變更。

## 架構與模組

- `bird-view-core.js`：純邏輯核心，包含等高列排版、相機幾何、方向鍵、探索選擇、標籤與格式化工具。優先把可純化的邏輯放在這裡，並以單元測試驗證。
- `board-state.js`：管理 nodes／rows 的白板狀態，負責取代、附加、在探索列後插入與重新排版。
- `board-history.js`：管理白板階段歷史，只保存素材參照、旋轉、相機與選取 ID；限制歷史階段與素材總數，不保存 DOM 或媒體資料。
- `row-load-coordinator.js`：以 channel 管理非同步載入。每次失效都會提高 generation；過期結果不可提交到畫面。
- `exploration-source.js`：相關素材、未評分素材、AI 相似素材與 hybrid exploration 的查詢、快取、篩選與選擇。
- `folder-item-source.js`：把 Eagle 選取的資料夾（含子資料夾）轉成排序後的素材批次。
- `folder-content-intake.js`：管理資料夾內容 session、漸進顯示、摘要 hydration、失效結果與部分失敗 retry；不直接修改 board 或 DOM。
- `library-content-target.js`：解析 Tag／資料夾 metadata target，協調 Eagle 查詢與 folder-content intake；不直接修改 UI。
- `media-load-queue.js`／`media-materializer.js`：分別管理媒體載入併發與 DOM 卡片生命週期。可視素材掛載、附近素材保留，遠處素材釋放。
- `image-downscaler.js`：把 Eagle 的全解析度母檔解碼成有上限的 `ImageBitmap`。優先以 `fetch` + `createImageBitmap` 按目標尺寸解碼，其次從已載入的 `<img>` 取得，兩者皆不可用時回傳 `null` 讓 caller 退回顯示母檔。不編碼、不產生 URL；bitmap 的所有權交給 caller。
- `viewport-work-scheduler.js`：決定 viewport 維護何時執行、執行哪一部分。平移只跑媒體覆蓋、縮放只跑品質判斷、其餘等相機停下才做完整 pass；不直接碰 DOM 或 board 狀態。
- `camera-navigation.js`／`selection-navigation.js`：相機平移／縮放／聚焦與鍵盤選取。
- `selection-model.js`：管理單選、Ctrl/Cmd 切換、Shift 區間選取、active 素材與多選集合。
- `bulk-metadata.js`：以有限併發儲存批次 metadata，讓部分失敗只回滾失敗素材。
- `selection-tag-overflow.js`：選取素材 Tag 的可用寬度收合與搜尋選擇。
- `auto-explore-settings.js`／`settings-presets.js`：設定面板、篩選器正規化與 localStorage preset。
- `settings-snapshot.js`：設定 schema、legacy migration、正規化與 `bird-view-settings` storage；不直接修改 plugin state 或 UI。
- `anchored-popover.js`／`folder-browser.js`／`tag-editor.js`／`folder-picker.js`／`video-player.js`：可獨立測試的 UI 模組。
- `video-thumbnail.js`：擷取影片目前畫面、暫存 PNG 與 Eagle custom thumbnail 的檔案生命週期；不直接管理 plugin state。
- `plugin.js`：唯一主要整合層，接 Eagle API、DOM、事件、狀態與上述模組。新增功能前先確認是否能放進既有模組，避免繼續擴大這個整合層。

模組應提供小而深的 interface：由 caller 傳入依賴與 callback，把複雜行為留在模組 implementation 內。修改 seam 時，同時檢查所有 caller 與測試 adapter。

## Script 載入順序

`index.html` 的順序就是瀏覽器端的模組依賴順序，不能任意重排：

```text
bird-view-core.js
board-state.js
board-history.js
row-load-coordinator.js
anchored-popover.js
selection-tag-overflow.js
media-load-queue.js
exploration-source.js
auto-explore-settings.js
settings-presets.js
settings-snapshot.js
folder-item-source.js
folder-content-intake.js
library-content-target.js
folder-browser.js
folder-picker.js
video-player.js
video-thumbnail.js
image-downscaler.js
media-materializer.js
viewport-work-scheduler.js
tag-editor.js
camera-navigation.js
bulk-metadata.js
selection-model.js
selection-navigation.js
plugin.js (defer)
```

新增模組時，保留目前的 UMD-like browser/CommonJS 包裝方式，並在 `index.html` 放到所有依賴之後、所有使用者之前。`test/script-load-order.test.js` 會檢查這項契約。

## 必須維持的不變條件

- 非同步查詢在選取、資料夾、探索篩選或 library 改變後可能已失效；使用 `row-load-coordinator` 的 generation／token，不要讓舊結果覆蓋新狀態。
- 同一個 loading channel 不應重複工作；取消或失效時必須清除 loading 狀態。
- 原圖載入失敗或逾時時保留縮圖並提供 retry，不可讓一次失敗阻塞後續載入。
- 媒體遠離 viewport 時要釋放；`MediaLoadQueue` 的原圖載入併發上限目前是 4。
- Eagle API 能力可能不存在（例如 AI Search、資料夾查詢或 context menu）；沿用既有 fallback 與 graceful no-op 行為。
- 設定資料使用既有 localStorage keys：`bird-view-settings`、`bird-view-presets`。變更格式前先考慮舊資料正規化／相容性。
- 白板上一頁只保留最多 10 個階段、總計最多 5,000 個素材參照；不可保存媒體 DOM、影片元素、Canvas 或原始檔內容。切換 Eagle library 時清除歷史。
- 使用者可見行為變更要同步更新 `README.md`；純內部重構則不必把實作細節寫進 README。

## 測試與驗證

```bash
npm run test:unit         # test/*.test.js
npm run test:integration  # test/integration/*.test.js
npm test                  # 全部測試
npm run test:coverage     # 覆蓋率報告
```

- 純邏輯、排版、相機、探索篩選、狀態轉換優先放在 `test/`。
- 需要 DOM、Happy DOM、Eagle 假 API 或 `plugin.js` 整合流程放在 `test/integration/`。
- `test-support/plugin-harness.js` 會在 VM 中載入 `plugin.js`，並提供 fake Eagle API；不要讓測試依賴實際 Eagle。
- `npm test`、`npm run test:integration` 與 `npm run test:coverage` 會先建立忽略版控的 `.test-cache`。不要手動提交或修改其中的打包檔。
- 行為變更先跑對應的 targeted test，再跑 `npm test`。完成前檢查 `git diff` 與 `git status`。

## 修改流程

1. 讀 `README.md`、本文件與目標模組的測試，先確認現有 interface 和不變條件。
2. 找到最深、最適合的 module seam；避免把純邏輯、非同步查詢或 UI 狀態直接塞進 `plugin.js`。
3. 先修改或新增對應層級的測試，再實作行為；保留依賴注入與可測試的 callback interface。
4. 若新增或移動模組，更新 `index.html` script 順序並確認 `test/script-load-order.test.js`。
5. 執行測試，確認使用者可見變更是否需要更新 README。

遵循現有 JavaScript 風格（兩格縮排、分號、雙引號）與最小必要變更；除非任務明確要求，不要引入 bundler、框架或新的 runtime dependency。

# PDF renderer research

日期：2026-08-10

## 結論

目前想要的行為是「進入 PDF 後，把每一頁拆成白板上的可視節點」。這不是瀏覽器單純嵌入整份 PDF 能提供的能力，因此需要一個能取得頁面尺寸並把指定頁面渲染到 Canvas 的 PDF renderer。

第一選擇是 PDF.js 的 display layer。它提供 document/page/render 的逐頁模型，官方 generic build 也包含 display layer 與 worker；Apache 2.0 授權與目前的 classic script、無 bundler 架構較容易配合。

但不應直接把 `pdfjs-dist` 當成 Eagle 執行時從 npm 載入的依賴。較合適的分發方式是固定一個經測試的 PDF.js 版本，將需要的 prebuilt runtime asset 與 worker 放入外掛，並由一個 adapter 封裝載入。`pdfjs-dist` 可以作為取得與更新這些資產的開發依賴，是否保留在 `package.json` 要等資產分發方式確定後再決定。

## 方案比較

| 方案 | 能否拆成頁面節點 | 對本專案的適合度 | 主要代價 |
| --- | --- | --- | --- |
| PDF.js / `pdfjs-dist` | 可以；可取得文件、頁面尺寸並逐頁渲染 Canvas | 推薦 | 需要固定版本、worker、離線資產與 `file://` 載入驗證 |
| `<iframe>`／`<object>`／`<embed>` | 通常只能嵌入整份文件，由瀏覽器 PDF viewer 接管 | 不適合白板頁面模式 | 頁面 DOM 不由外掛控制，控制列與跨環境行為不一致 |
| `pdf-lib` | 不是以頁面渲染為主要用途 | 不適合 | 適合建立、修改、合併、拆分 PDF，但仍缺少顯示 renderer |
| MuPDF.js | 可以，且有 WASM renderer、文字、註解與編輯能力 | 暫不推薦 | ESM/WASM 載入較重；官方文件列出 AGPL 或商業授權，需先處理授權風險 |

## 來源與限制

- PDF.js 官方文件將 display layer 定義為用來渲染 PDF 與取得文件資訊的 API；官方範例使用 `getDocument()` 取得文件，再逐頁操作。來源：[Getting Started](https://mozilla.github.io/pdf.js/getting_started/?lang=en)、[Examples](https://mozilla.github.io/pdf.js/examples/index.html)、[API reference](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html)。
- PDF.js 的 prebuilt layout 包含 `pdf.mjs`、`pdf.worker.mjs` 與可能需要的 CMap／其他資產；官方 Getting Started 明確說明 worker 在 `file://` URL 不會啟用，這是 Eagle Window Plugin 必須用實際 runtime 驗證的風險。來源：[PDF.js Getting Started](https://mozilla.github.io/pdf.js/getting_started/?lang=en)。
- PDF.js 以 URL 載入時會使用 Fetch API 或 XHR，仍受 same-origin／CORS 規則影響；因此不能先假設 Eagle 的 `item.fileURL` 一定能直接交給 `getDocument({ url })`。來源：[pdfjsLib API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html)。
- MDN 將 `iframe`、`embed` 與 `object` 描述為可嵌入 PDF 的元素，但也指出這類嵌入由外部資源／瀏覽器處理，並不提供本專案需要的逐頁 Canvas 控制。來源：[General embedding technologies](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Structuring_content/General_embedding_technologies)、[`<embed>` reference](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/embed)。
- pdf-lib 官方定位是建立與修改 PDF，並提供頁面合併、拆分與繪圖能力；根據官方列出的能力可推論，它不是本需求所需的既有 PDF 頁面 raster renderer。來源：[PDF-LIB](https://pdf-lib.js.org/)。
- MuPDF.js 官方文件列出頁面渲染、文字、註解與編輯能力，但同時說明其 ESM/WASM 形態與 AGPL／商業雙授權；這使它比較適合授權與載入成本都已被接受的高階文件產品。來源：[MuPDF.js FAQ](https://mupdfjs.readthedocs.io/en/latest/faq/index.html)。

## 對 Bird View 的建議

1. 先做一個 `pdf-source` adapter，實際驗證 Eagle 是否能提供可供 PDF.js 使用的 URL 或 bytes；若 `fileURL` 不能讀取，再研究 Eagle 的檔案讀取能力，不要把這個問題藏在頁面 renderer 裡。
2. 將 PDF.js 載入與 worker 放在獨立 module，不讓 `plugin.js` 直接知道 `PDFDocumentProxy`、`PDFPageProxy` 或 render task。
3. 頁面只在可視範圍附近渲染，Canvas 解析度依目前顯示尺寸設定；相機移動時保留既有畫面，停止後才升級解析度，並在離開 PDF 時取消 render task、釋放 Canvas 與文件資源。
4. 若只需要「雙擊後開啟整份 PDF」，則完全不需要 PDF renderer；可以沿用 Eagle 開啟素材的路徑。只有「拆頁攤在白板上」才值得引入 PDF.js。

## 本輪落地

- 固定 vendored PDF.js 3.11.174，包含 generic runtime、worker、CMap 與 standard fonts；沒有把 `pdfjs-dist` 加成 Eagle runtime 的 npm loader。
- `pdf-runtime.js` 會優先使用注入的本機 bytes reader，讀取失敗才退回 `fileURL`；`pdf-board.js` 負責文件生命週期、頁面尺寸與虛擬頁面 item。
- PDF 頁面沿用 Bird View 的 viewport/media queue，只在可視範圍附近建立 Canvas，離開 PDF 時取消 render task 並釋放文件與 Canvas。
- 已用 fake Eagle/PDF.js integration test 驗證進入、返回與資源清理；實際 Eagle Window Plugin 的 worker、`file://` 與多頁 PDF 仍需現場驗證。

## 尚未確認

- 實際 Eagle 版本是否允許 PDF.js worker 從外掛目錄啟動。
- Eagle item 的 `fileURL` 是否能被 PDF.js 以 URL 或 Fetch 讀取，或需要轉成 bytes。
- 目前 Eagle 內建 Chromium 對 PDF.js 所選 build 的 ESM／WebAssembly／Canvas 能力。

這些都需要用實際 Eagle 開發者模式與至少一份多頁 PDF 驗證；Happy DOM 測試只能驗證 session、頁面節點與 fallback，不足以宣稱 Eagle PDF rendering 已完成。

# Bird View 平移操作最佳實務

研究日期：2026-07-29  
適用情境：classic JavaScript、DOM media cards、可平移／縮放的 Eagle 白板

本文整理 Pointer Events、瀏覽器輸入排程，以及 Android／iOS 原生捲動模型，並對照 Bird View 目前的平移實作。研究結論不是 Eagle 內建 Chromium 的實測結果；真正採用慣性或邊界效果前，仍應在 Eagle 中做可回退的 A/B 驗證。

## 結論先行

平移和縮放的最佳體感不同：

- **滑鼠／觸控拖曳：直接操控、1:1 跟手。** 不應在拖曳開始時做加速，否則游標與畫面會產生延遲感。
- **放開後的慣性：可選的第二階段。** 它應從最近一小段移動估算初速度，再以摩擦力逐步減速；不能把拖曳本身改成有延遲的動畫。
- **鍵盤平移：才適合做加速／減速。** 目前 Bird View 的平滑鍵盤平移是固定像素／秒，未來若覺得方向鍵起步慢，可沿用平滑縮放的速度模型。
- **邊界回彈：只在產品需要有限白板時加入。** Bird View 目前允許把視野拖到白板內容外，先不應為了模仿原生 ScrollView 而加入硬邊界。

這個區分與原生平台的模型一致：Android 將拖曳速度交給 `VelocityTracker`，再交給 fling／friction 動畫；Android `OverScroller` 另外提供邊界與 `springBack`。iOS `UIScrollView` 也把 dragging、decelerating 與 `decelerationRate` 分成不同狀態。[Android：Track touch and pointer movements](https://developer.android.com/develop/ui/views/touch-and-input/gestures/movement)、[Android：OverScroller](https://developer.android.com/reference/android/widget/OverScroller)、[Apple：UIScrollView](https://developer.apple.com/documentation/uikit/uiscrollview)

## 目前 Bird View 的判斷

| 項目 | 目前行為 | 判斷 |
| --- | --- | --- |
| 拖曳模型 | `beginPan()` 記住起始 camera 與 pointer，使用 `startCamera + pointerDelta` | 正確；不會因事件遺失而累積漂移，也能讓內容 1:1 跟手 |
| 點擊／拖曳辨識 | 左鍵移動超過 4px 才進入平移；中鍵立即平移 | 合理；可保留這個 threshold |
| 事件生命週期 | `pointermove`／`pointerup`／`pointercancel` 暫時掛在 `window` | 能追蹤離開 viewport 的拖曳，但可改成 viewport 的 Pointer Capture，讓所有事件屬於同一個 gesture |
| 觸控瀏覽器行為 | `.viewport { touch-action: none; user-select: none; }` | 正確；自訂平移需要先宣告不要讓瀏覽器接手原生 pan／pinch |
| 更新節奏 | `updateCamera()` 以 `requestAnimationFrame` 合併畫面更新 | 正確；連續輸入不應每個事件都做完整 render |
| 昂貴工作 | 平移期間延後 label、中央選取與自動探索；media window 以 120ms 節流持續執行 | 正確。但 media window 不能一起延後——整個手勢都不載入，等於平移到目的地才開始抓圖 |
| 裝飾層 | 平移期間暫時隱藏 grid 與 labels，放開後恢復 | 減少移動中不影響定位的合成內容；仍需以 Eagle Performance trace 確認收益 |
| 鍵盤平移 | 平滑模式使用共用的鍵盤操作加速反應；按住加速，放開後減速，完成後選取中央素材 | 符合鍵盤連續操作的建議模型 |
| 慣性 | 放開立即停止 | 是目前唯一明顯可考慮的體感增強，但不是必須 |
| 邊界 | 沒有 clamp／回彈 | 對可自由瀏覽的白板合理；若未來限制內容範圍，再加入 soft boundary |

## 1. 手勢接收：Pointer Capture 與 `touch-action`

`touch-action: none` 會關閉瀏覽器對該區域的原生平移與縮放，避免瀏覽器在自訂手勢途中發出 `pointercancel` 並接手操作；MDN 也建議自訂拖曳／縮放的區域在手勢開始前宣告 `touch-action`。[MDN：touch-action](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/touch-action)

Pointer Capture 可在 `pointerdown` 後呼叫 `setPointerCapture(pointerId)`，讓後續事件持續送到指定元素，即使 pointer 已經離開元素命中範圍；Pointer Events 規範也提供 `lostpointercapture`、`pointerup` 與 `pointercancel` 作為完整生命週期。[MDN：Pointer events](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events/)、[W3C：Pointer Events](https://www.w3.org/TR/pointerevents/)

對 Bird View 的建議：

1. 保留 `.viewport` 的 `touch-action: none`。
2. 在真正開始平移的 pointer 上呼叫 `elements.viewport.setPointerCapture(event.pointerId)`。
3. 將 cleanup 集中到 `pointerup`、`pointercancel`、`lostpointercapture` 與 `window.blur`；避免不同結束路徑漏掉 `isPanning` 或 timer。
4. 若未來支援多指手勢，使用 `pointerId` 管理 active pointer；目前的單一 `startPointer` 模型不應直接擴充成 pinch。

這不是說目前掛在 `window` 的做法一定錯；它已經解決滑鼠離開 viewport 後仍能收尾的問題。Pointer Capture 的價值是讓 gesture ownership 更明確，並把觸控／筆／滑鼠的生命週期收斂到同一個元素。

## 2. 拖曳期間：直接操控與 rAF

拖曳中的 camera translation 應直接使用 pointer 位移，不使用追趕動畫、低通濾波或「加速反應」。使用者移動 100px，畫面就應移動 100px；平滑感來自穩定的 frame timing，而不是讓畫面落後游標。

連續的 `pointermove` 可能以高於螢幕更新率的頻率抵達。Chrome 會對連續輸入做 frame alignment／coalescing，並提供 `getCoalescedEvents()` 讓需要完整軌跡的繪圖應用取得中間事件；一般相機平移只需要最新位置，不需要逐一重播所有 coalesced event。[Chrome for Developers：Aligned input events](https://developer.chrome.com/blog/aligning-input-events/)、[MDN：getCoalescedEvents](https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent/getCoalescedEvents)

因此目前 `updateCamera()` 的 rAF coalescing 是合適方向：事件處理器只更新 camera state，實際 DOM transform 在下一個 repaint 前集中執行。平移期間繼續避免 mount／release、label layout、原圖切換、中央選取與探索查詢；這些工作在手勢結束後批次處理即可。

## 3. 放開後慣性：建議採用的模型

如果實機確認白板拖曳「放開太硬」，可以加入慣性，但要把它視為另一個 camera state：

```text
dragging  --pointerup-->  decelerating  --velocity≈0-->  settled
```

建議流程：

1. 拖曳期間記錄最近約 50–100ms 的 `{x, y, timestamp}`，不要用整段拖曳距離除以總時間。
2. `pointerup` 時計算最後速度，限制最大速度，避免短促的異常事件造成飛出畫面。
3. 以 `requestAnimationFrame` 更新：`camera += velocity * elapsedSeconds`。
4. 使用時間相關的指數衰減，例如 `velocity *= exp(-friction * elapsedSeconds)`，不要假設每台機器固定 60 FPS。
5. 新的 pointerdown、wheel、鍵盤平移、聚焦或選取變更都取消慣性。
6. 慣性期間仍走 camera transform-only path；速度接近 0 後才執行 `flushViewportWork()`。

Android 的 `OverScroller.fling()` 以 pixels／second 的初速度開始，並支援 friction、邊界與 springback；這正是「拖曳直接跟手、放開後另行減速」的成熟分層。[Android：OverScroller fling](https://developer.android.com/reference/android/widget/OverScroller#fling(int,%20int,%20int,%20int,%20int,%20int,%20int,%20int))

第一版不建議把 friction 做成設定項目。慣性距離和白板密度、zoom、素材數量及 Eagle Chromium 效能都有關，應先用固定保守值與 A/B 測試確認，再決定是否需要「滑動感」選項。

## 4. 邊界與回彈

若未來要限制 camera 不離開內容 bounds，建議採三段式：

- 拖曳中允許小幅 overscroll，使用阻力函數讓越靠近邊界越難拖。
- 放開後若超出 bounds，執行短促 springback。
- 慣性撞到邊界時停止該軸速度或進入 springback，不讓慣性穿過內容邊界。

Android `OverScroller` 明確區分合法範圍、overfling 範圍與 `springBack()`；Apple `UIScrollView` 也將 edge effect、zoom bouncing 與 deceleration 分開管理。[Android：OverScroller bounds and springBack](https://developer.android.com/reference/android/widget/OverScroller#springBack(int,%20int,%20int,%20int,%20int,%20int))、[Apple：UIScrollView](https://developer.apple.com/documentation/uikit/uiscrollview)

但 Bird View 是白板而非文件捲動區，空白區本身可能是可接受的瀏覽空間。除非使用者明確覺得「拖到空白處迷路」，否則不要先引入 bounds、回彈與額外狀態。

## 建議實作順序

### P0：保留目前行為

- 保留直接 1:1 拖曳、4px threshold、rAF camera transform，以及平移期間延後 label／選取／探索。media window 需要持續執行並依移動方向預載。
- 不為滑鼠／觸控拖曳增加起步加速，也不增加 pointer drag speed 設定。

### P1：低風險改善

- 將 `beginPan()` 改成 Pointer Capture，補 `lostpointercapture` cleanup。
- 將可互動元素判斷集中化，除了 `button`／`input` 也涵蓋 `select`、`textarea`、`video` 與明確標記的編輯控制。
- 加入「已拖曳」旗標，避免超過 threshold 後在 pointerup 觸發不預期的 click／dblclick 行為。
- 已將鍵盤平移與平滑縮放共用同一個「鍵盤操作加速反應」設定；方向鍵按住時加速，放開後減速，後續只需以 Eagle 實機調整反應係數。

### P2：實機 A/B

- 只在滑鼠快速拖曳確實需要時加入慣性。
- 先固定 friction 與 max velocity，不立即增加設定項目。
- 比較無慣性、短慣性、長慣性的主觀控制感與 Performance trace；確認慣性期間沒有重新掛載大量 DOM 或觸發原圖 decode。

### 暫不建議

- 不要把每個 `pointermove` 都直接觸發完整 media／label 更新。
- 不要為每張 card 加 `will-change: transform`。
- 不要用 `getCoalescedEvents()` 重播相機位置；那是繪圖等需要完整軌跡的情境，對 camera 反而增加工作。
- 不要在沒有有限內容邊界的產品模型下加入硬 clamp。

## 來源

- [W3C Pointer Events](https://www.w3.org/TR/pointerevents/)
- [MDN Pointer events](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events/)
- [MDN touch-action](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/touch-action)
- [Chrome for Developers：Aligned input events](https://developer.chrome.com/blog/aligning-input-events/)
- [MDN PointerEvent.getCoalescedEvents](https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent/getCoalescedEvents)
- [Android：Track touch and pointer movements](https://developer.android.com/develop/ui/views/touch-and-input/gestures/movement)
- [Android：OverScroller](https://developer.android.com/reference/android/widget/OverScroller)
- [Apple：UIScrollView](https://developer.apple.com/documentation/uikit/uiscrollview)

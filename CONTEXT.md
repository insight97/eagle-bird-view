# Bird View

Bird View is Eagle's whiteboard-style window for browsing and exploring image and video content from a library.

## Language

**Folder-content intake**:
The process of turning selected Eagle folders into an ordered set of media content available for Bird View browsing, including nested-folder scope and progressive availability.
_Avoid_: folder browser, folder query, folder loader

**PDF board session**:
A temporary browsing context entered from a parent Board, where one PDF appears as virtual page media before the user returns to that same Board; it does not join Board history or change Eagle metadata.
_Avoid_: PDF mode, PDF viewer

## Navigation map

| User flow | Integration entry | Deep module | Tests |
| --- | --- | --- | --- |
| Eagle selection | `plugin.js:loadSelectedItems` | `row-load-coordinator.js`, `folder-item-source.js` | `test/integration/plugin-startup.test.js` |
| Board stage replacement and previous/next-board restore | `plugin.js:renderItems` / `restorePreviousBoard` / `restoreNextBoard` | `board-history.js`, `board-state.js` | `test/board-history.test.js`, `test/integration/plugin-startup.test.js`, `test/integration/media-label.test.js` |
| Enter and leave a PDF board session | `plugin.js:openPdfBoard` / `leavePdfBoard` | `pdf-board.js`, `pdf-runtime.js`, `media-materializer.js` | `test/pdf-board.test.js`, `test/integration/pdf-board.test.js`, `test/pdf-materializer.test.js` |
| Selected folder contents | `plugin.js:handleFolderBrowserSelect` / `loadSelectedItems` | `folder-browser.js`, `folder-item-source.js`, `folder-content-intake.js` | `test/folder-item-source.test.js`, `test/folder-content-intake.test.js`, `test/integration/plugin-startup.test.js` |
| Tag metadata target | `plugin.js:loadTagFromMetadataTarget` | `library-content-target.js`, `folder-content-intake.js` | `test/library-content-target.test.js`, `test/integration/media-label.test.js` |
| Folder metadata target | `plugin.js:loadFolderFromMetadataTarget` | `folder-content-intake.js` | `test/folder-content-intake.test.js`, `test/integration/media-label.test.js` |
| Initial media mount | `plugin.js:renderItems` | `board-state.js`, `media-materializer.js` | `test/integration/plugin-startup.test.js`, `test/integration/original-image-load.test.js` |
| Pan, zoom, keyboard focus | `plugin.js:handleWheel` / `handleKeyDown` | `camera-navigation.js`, `selection-navigation.js` | `test/camera-navigation.test.js`, `test/selection-navigation.test.js` |
| Single and multiple selection | `plugin.js` media-card click handlers | `selection-navigation.js`, `media-materializer.js` | `test/selection-navigation.test.js`, `test/integration/multi-selection.test.js` |
| Batch rating, tags, and folders | `plugin.js:updateSelectionStatus` / metadata commit intents | `metadata-committer.js`, `tag-editor.js`, `folder-picker.js` | `test/metadata-committer.test.js`, `test/tag-editor.test.js`, `test/folder-picker.test.js` |
| Exploration rows | `plugin.js:exploreNextRow` / `loadNextUnratedRow` | `exploration-source.js`, `row-load-coordinator.js` | `test/exploration-source.test.js`, `test/core-exploration.test.js` |
| Settings and presets | `plugin.js:updateBoardSettings` | `settings-snapshot.js`, `settings-presets.js` | `test/settings-snapshot.test.js`, `test/integration/settings-presets.test.js` |

## Async channel ownership

| Channel | Started by | Invalidation owner | Result may commit at |
| --- | --- | --- | --- |
| `selected` | `plugin.js:loadSelectedItems` | `plugin.js` when a folder is selected, `clearBoard()`, or the library changes | `renderItems`, `appendItemsToBoard`, or empty-state handling |
| `folder-content` | `folder-content-intake.js:start` / `startFolder` / `loadMore`; selected, sidebar, and folder metadata routes use it directly | `folder-content-intake.js` for folder resolution, new sessions, reset, and stale target resolution | shared `handleFolderContentStart` / `handleFolderContentBatch` callbacks |
| `library-content-target` | `library-content-target.js:load` for Tag targets | `library-content-target.js`, with Tag board reset requested by `plugin.js` | target `onBeforeStart`, then shared `handleFolderContentBatch`; `handleLibraryContentTargetResult` only reports Tag status |
| `exploration` | `plugin.js:exploreNextRow` / `exploreFromSelectionTarget` | `plugin.js` after library, metadata, or exploration-setting changes | `insertExplorationItemsAfterNode` |
| `unrated` | `plugin.js:loadNextUnratedRow` | `plugin.js` after library, filter, or metadata changes | `insertExplorationItemsAfterNode` |
| PDF page metrics | `pdf-board.js` after the first page commits the PDF board session | `pdf-board.js` generation when the session leaves or is superseded | `plugin.js:refreshPdfPageLayout`, only while the same session revision remains active |

When changing an async flow, update the row-load coordinator generation and the owning channel row above together. An `isCurrent()` check without the matching invalidation owner is incomplete.

## Eagle smoke checklist

Run this manually in an actual Eagle window before claiming a runtime or rendering fix. Prepare a test library containing one image, one video, a folder with one or two items, and a folder large enough to require multiple batches. Record the Eagle version, test library, date, and result.

| Result | Scenario | Notes |
| --- | --- | --- |
| [ ] Pass [ ] Fail | Select one image and one video; both appear without panning or zooming. | |
| [ ] Pass [ ] Fail | Select a folder containing one or two media items; the thumbnail is visible immediately after loading. | |
| [ ] Pass [ ] Fail | Select a folder containing more than one progressive batch; the first batch appears before the remainder, and “載入更多” completes the rest. | |
| [ ] Pass [ ] Fail | Start a folder or exploration load, change the Eagle library, and confirm old results never return to the board. | |
| [ ] Pass [ ] Fail | Pan and zoom rapidly; visible media remains mounted and distant media is released, without labels or cards appearing only after another gesture. | |
| [ ] Pass [ ] Fail | Disable or make unavailable an optional Eagle API such as AI Search; the documented fallback remains usable. | |

Run record: `Date: ____` · `Eagle version: ____` · `Test library: ____` · `Tester: ____`

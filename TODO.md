# TODO — Document Layout Repair Workspace

Tracking file for the whole build. Every requirement from the spec is listed here so
nothing is missed and nothing out of scope creeps in.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done

---

## Phase 0 — Project setup & toolchain

- [x] Vite + React 19 + TypeScript scaffold
- [x] Strict TypeScript config, `@/*` path alias
- [x] Vitest + Testing Library wiring
- [x] Base design tokens and workspace layout shell
- [x] Scripts: `dev`, `build`, `preview`, `lint`, `typecheck`, `test`, `test:e2e`
- [x] Playwright wired for browser-level canvas verification
- [x] Git repo + public GitHub remote
- [x] TODO.md scope tracker

## Phase 1 — Viewport & page rendering (Module A)

Renderer decision: **hybrid canvas stack** — Canvas2D page-texture layer at the bottom,
WebGL2 instanced overlay layer for the 10k boxes, Canvas2D interaction layer on top for
handles, snap guides and labels. All three share one camera transform.

- [x] World/screen coordinate model, `Camera { worldX, worldY, scale }`
- [x] `worldToScreen` / `screenToWorld` inverses + `zoomAtScreenPoint` unit tests
- [x] World→clip `mat3` builder for the WebGL layer, world→device transform for 2D layers
- [x] High-DPI backing store sizing, `devicePixelRatio` change handling
- [x] Layer stack with a shared reused render frame and per-layer dirty flags
- [x] Single `requestAnimationFrame` scheduler, no per-frame allocation
- [x] Pan (drag / space-drag), wheel zoom-to-cursor, trackpad pinch, 10%–500% clamp
- [x] Multi-page world layout (vertical page stack with gutters), page culling
- [x] Deterministic synthetic page content generator shared by textures and extraction data
- [x] Page textures rasterized in a worker via `OffscreenCanvas` → `ImageBitmap`
- [x] Texture level-of-detail by zoom + LRU bitmap cache with explicit `close()`
- [x] Real glyph rendering on pages, with box widths that match the printed ink
- [x] FPS / frame-time / draw-count HUD and zoom readout
- [x] Dev scripts for screenshots and pan frame-rate measurement

## Phase 2 — Web Worker & spatial indexing (Module C)

- [x] Typed worker protocol (request/response + push events, no `any`)
- [x] Worker client with request correlation, transfer lists and disposal
- [x] Extraction payload parsing + normalization inside the worker
- [x] Structure-of-arrays geometry buffers transferred to the main thread
- [x] QuadTree built in the worker over world-space rects
- [x] `O(log N)` point hit-test + rect range query, topmost-first resolution
- [x] Incremental index updates on mutation (insert / update / remove)
- [x] Stress Test Document generator: 100 pages, 11,513 boxes
- [x] UI toggle to load the benchmark dataset
- [x] Unit tests: QuadTree vs. brute force, hit-test ordering, latency guard

## Phase 3 — WebGL instanced overlay renderer (Module A)

- [x] WebGL2 context with 2D fallback path, context-loss recovery
- [x] Instanced quad program: per-instance rect, class colour, state flags
- [x] Single draw call for all visible boxes, border + fill in the fragment shader
- [x] Viewport culling from the document's page grid, cached for a padded envelope
      so ordinary panning only updates the transform uniform
- [x] Debug toggle that disables culling, to measure raw instance throughput
- [x] Zoom-independent border width, crisp edges at any devicePixelRatio
- [x] Level-of-detail: boxes collapse to a solid class tint below ~3 device pixels
- [x] Hover and selection deliberately moved to the interaction layer, so pointer
      movement never rebuilds the instance buffer
- [x] Buffer reuse (no per-frame allocation), explicit GL resource disposal

## Phase 4 — Transactional state & bounding box editor (Modules B, D)

- [x] Document store: pages, nodes, reading order, tables
- [x] Command/patch transaction engine with inverse patches
- [x] Undo/redo stack, minimum 50 levels, drag gestures coalesced into one transaction
- [x] Keyboard bindings (Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z)
- [x] Selection model (single, additive, marquee)
- [x] Box move + 8-handle resize with a zoom-independent grab radius
- [x] Handles gated by on-screen size, so small boxes stay draggable rather than
      being swallowed by their own handles
- [x] Re-label a box (class picker)
- [x] Snapping: edges snap to nearby block edges, with guides drawn between the two
      boxes they align
- [x] Mutations replayed into the worker index; stream updates never corrupt local edits
- [x] Unit tests: inverse correctness, randomized undo round-trip, 50+ depth, snap
      solver vs. linear scan, handle hit-testing
- [x] Playwright coverage: drag/undo/redo, gesture coalescing, re-label, marquee
- [x] Marquee replaces the selection; Cmd/Ctrl adds to it; clearing it repaints
- [x] Inspector lists the whole multi-selection, and re-labelling applies to all of it
- [x] A drag ends when the button is released off-window, off-element or while hidden

## Phase 5 — Tree view & bi-directional grounding (Module D)

- [x] Hierarchical tree of pages → blocks → lines / cells
- [x] Virtualized tree rendering: a 100-page document is 121 rows with ~28 mounted
- [x] Canvas selection/hover → ancestors revealed, row scrolled into view and highlighted
- [x] Tree selection/hover → canvas highlight; double-click eases the camera onto the box
- [x] JSON pane: the selected subtree as the payload it will export, page-local
- [x] Markdown pane: reading order, tables and key-value pairs rendered as Markdown
- [x] Unit tests: tree flattening, ancestor reveal, JSON and Markdown serialization
- [x] Playwright coverage: both grounding directions, virtualization, camera focus

## Phase 6 — Reading-order graph tool (Module B)

- [x] Directed reading-order edges rendered as arrows between blocks
- [x] Sequence badges (1 → 2 → 3) with LOD
- [x] Drag a connection handle to re-parent a linkage
- [x] Cycles are unrepresentable: order is stored as a per-page sequence, so every
      operation is a permutation and numbering is just array position
- [x] Re-link commits as one transaction; undo restores the previous order
- [x] Tool modes, so the reading-order tool and box editing never fight over a drag
- [x] Unit tests: sequence moves, permutation invariant, geometry-derived order,
      arrow trimming against both blocks
- [x] Playwright coverage: graph visibility per tool, re-link by drag, drop on empty
      paper, box editing left to the select tool
- [x] Edge culling against the visible world rect

## Phase 7 — Table grid mesh corrector (Module B)

- [x] Table mesh model: global dividers plus per-cell spans, with every cell rectangle
      derived from the dividers rather than stored
- [x] Editable mesh overlay on detected tables
- [x] Drag row/column dividers with live cell bbox recalculation
- [x] Cell split: inserts a divider, creating the cells that appear in every other row
- [x] Cell merge across the span of the selected cells, reusing the ordinary selection
- [x] Unmerge, restoring the cells the merge hid
- [x] All mesh edits as single undoable transactions, ordered so cell rectangles are
      never derived from a grid they do not belong to
- [x] Node creation replayed into the worker's spatial index as an insert
- [x] Divider grab zones capped at a third of their tracks, so thin rows stay clickable
- [x] Unit tests: divider clamping, split/merge/unmerge plans, and a tiling invariant
      that every present cell covers its grid cell exactly once after any edit
- [x] Playwright coverage: split by column and row, merge and unmerge, divider drag,
      and that clicking a merged cell selects the merge rather than a swallowed fragment
- [x] Merging carries the text of every cell it swallows; the hidden cells keep theirs
      so undo restores each fragment in place
- [x] A cell created by a split is empty and carries no confidence, so it reads as work
      for a human rather than as a verified box
- [x] Divider segments under a merged cell are neither drawn nor grabbable
- [x] A wash over the table while the mesh tool is active, because the printed rules
      stay where they were inked — the mesh corrects the model, not the scan

## Phase 8 — Live streaming ingestion (Module C)

- [x] SSE mock endpoint served by a Vite plugin, in both `dev` and `preview`
- [x] In-app fallback stream generator for static hosting
- [x] Out-of-order page extraction events with partial payloads
- [x] The worker owns the `EventSource`, so payload bytes never reach the main thread
- [x] Worker-side reconciliation: chunks buffered until the document is sized, whole
      blocks per chunk so no chunk depends on another, reading order recovered from the
      order the model stated rather than the order chunks arrived
- [x] Pages appear as they arrive; each page owns a list of contiguous node spans, so
      chunks from different pages can interleave without breaking culling
- [x] Appends extend the document in place, so a stream update cannot reset selection
      or invalidate an edit already in the undo stack
- [x] Stream control panel: connect/disconnect, throughput, event log
- [x] Long-task budget measured live with `PerformanceObserver`, windowed to the run:
      zero long tasks on a GPU-backed browser, worst worker event 0.3–0.5ms
- [x] Unit tests: chunk splitting invariants, arrival-order independence, and that a
      shuffled stream reconstructs exactly the document a batch load produces
- [x] Playwright coverage: SSE ingestion, out-of-order log, disconnect/reconnect,
      editing mid-stream, and the in-worker fallback with the endpoint blocked

## Phase 9 — Verification, docs, polish

- [ ] `ARCHITECTURE.md`: viewport matrix & render pipeline, worker strategy, spatial index, memory/FPS techniques
- [ ] `README.md`: run instructions, feature tour, keyboard map
- [ ] Docker build for one-command run
- [ ] Performance evidence: DevTools trace + screenshot, capture instructions
- [ ] Memory-leak check across repeated load/undo/redo cycles
- [ ] Full test suite green, lint + typecheck clean

---

## Benchmark targets

| Metric | Target |
| --- | --- |
| Viewport frame rate | 60 FPS sustained pan/zoom with 10k boxes |
| Main-thread blocking | < 16ms long tasks during live ingestion |
| Hit-test latency | < 2ms click-to-selection across 10k nodes |
| Memory | no growth across repeated load/undo/redo cycles |

## Explicitly out of scope

- Real backend, auth, persistence beyond the in-memory session
- Real OCR/model inference — extraction payloads are mocked
- DOM-based overlay rendering for boxes (forbidden by the spec)

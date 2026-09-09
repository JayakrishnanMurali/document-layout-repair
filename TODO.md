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
- [x] Scripts: `dev`, `build`, `preview`, `lint`, `typecheck`, `test`
- [x] Git repo + public GitHub remote
- [x] TODO.md scope tracker

## Phase 1 — Viewport & canvas rendering engine (Module A)

- [ ] World/screen coordinate model and viewport transform (`scale`, `translate`)
- [ ] `worldToScreen` / `screenToWorld` inverse transforms with unit tests
- [ ] High-DPI backing store sizing (`devicePixelRatio`), crisp strokes, no texture blur
- [ ] Layered canvas stack: page raster layer, overlay layer, interaction layer
- [ ] Render scheduler: single `requestAnimationFrame` loop, dirty-flag driven
- [ ] Pan (drag + space-drag), wheel zoom-to-cursor, pinch zoom, 10%–500% clamp
- [ ] Multi-page document layout in world space (vertical page stack with gutters)
- [ ] Procedural page textures (synthetic scans) rendered off the main thread
- [ ] Page texture level-of-detail selection by zoom to avoid blur/shimmer
- [ ] Viewport culling of overlay boxes (only visible objects submitted to the GPU/2D ctx)
- [ ] Batched overlay drawing (one path per style class, not one call per box)
- [ ] Level-of-detail: labels and handles suppressed below readable zoom
- [ ] FPS / frame-time / draw-count HUD

## Phase 2 — Web Worker & spatial indexing (Module C)

- [ ] Typed worker protocol (request/response + event messages, no `any`)
- [ ] Worker client wrapper with request correlation and disposal
- [ ] Extraction payload parsing + normalization inside the worker
- [ ] Structure-of-arrays geometry buffers, transferred (zero-copy) to the main thread
- [ ] QuadTree built in the worker over world-space rects
- [ ] `O(log N)` point hit-test + rect range query in the worker
- [ ] Incremental index updates on mutation (insert / update / remove)
- [ ] Stress Test Document generator: 100 pages, 10,000 boxes
- [ ] UI toggle to load the benchmark dataset
- [ ] Unit tests: QuadTree correctness vs. brute force, hit-test ordering

## Phase 3 — Transactional state & bounding box editor (Modules B, D)

- [ ] Document store: nodes, pages, reading order, tables
- [ ] Command/patch based transaction engine with inverse patches
- [ ] Undo/redo stack, minimum 50 levels, coalescing for drag gestures
- [ ] Keyboard bindings (Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z)
- [ ] Selection model (single, additive, marquee)
- [ ] Box move + 8-handle resize with pixel-perfect hit slop
- [ ] Re-label a box (class picker)
- [ ] Snapping: box edges snap to nearby block edges with visible guide lines
- [ ] Store never mutated directly during stream updates (no corrupted states)
- [ ] Unit tests: transaction inverse correctness, 50+ undo depth, snap solver

## Phase 4 — Tree view & bi-directional grounding (Module D)

- [ ] Hierarchical tree of pages → blocks → lines / cells
- [ ] Virtualized tree rendering (windowed, handles 10k nodes)
- [ ] Canvas selection/hover → tree scroll-into-view + highlight
- [ ] Tree selection/hover → canvas highlight + optional camera focus
- [ ] JSON / Markdown inspector for the selected node

## Phase 5 — Reading-order graph tool (Module B)

- [ ] Directed reading-order edges rendered as arrows between blocks
- [ ] Sequence badges (1 → 2 → 3) with LOD
- [ ] Drag a connection handle to re-parent a linkage
- [ ] Cycle prevention and order renumbering as a single transaction
- [ ] Culling for edges (only visible segments drawn)

## Phase 6 — Table grid mesh corrector (Module B)

- [ ] Table mesh model (row/column dividers derived into cells)
- [ ] Editable mesh overlay on detected tables
- [ ] Drag row/column dividers with live cell bbox recalculation
- [ ] Cell split (horizontal / vertical)
- [ ] Cell merge across a selected span
- [ ] All mesh edits as undoable transactions

## Phase 7 — Live streaming ingestion (Module C)

- [ ] SSE mock endpoint served by a Vite dev/preview middleware plugin
- [ ] In-app fallback stream generator for static hosting
- [ ] Out-of-order page extraction events, partial payloads
- [ ] Worker-side reconciliation buffer, no main-thread parsing
- [ ] Live partial page rendering without dropping frames
- [ ] Stream control panel: connect/disconnect, throughput, event log
- [ ] Long-task budget check (< 16ms) during ingestion

## Phase 8 — Verification, docs, polish

- [ ] `ARCHITECTURE.md`: viewport matrix & render pipeline, worker strategy, spatial index, memory/FPS techniques
- [ ] `README.md`: run instructions, feature tour, keyboard map
- [ ] Optional Docker build for one-command run
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

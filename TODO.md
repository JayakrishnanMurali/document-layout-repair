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
- [x] FPS / frame-time / draw-count HUD and zoom readout

## Phase 2 — Web Worker & spatial indexing (Module C)

- [ ] Typed worker protocol (request/response + push events, no `any`)
- [ ] Worker client with request correlation, transfer lists and disposal
- [ ] Extraction payload parsing + normalization inside the worker
- [ ] Structure-of-arrays geometry buffers transferred to the main thread
- [ ] QuadTree built in the worker over world-space rects
- [ ] `O(log N)` point hit-test + rect range query, topmost-first resolution
- [ ] Incremental index updates on mutation (insert / update / remove)
- [ ] Stress Test Document generator: 100 pages, 10,000 boxes
- [ ] UI toggle to load the benchmark dataset
- [ ] Unit tests: QuadTree vs. brute force, hit-test ordering, latency guard

## Phase 3 — WebGL instanced overlay renderer (Module A)

- [ ] WebGL2 context with 2D fallback path, context-loss recovery
- [ ] Instanced quad program: per-instance rect, class colour, state flags
- [ ] Single draw call for all visible boxes, border + fill in the fragment shader
- [ ] Viewport culling feeding the instance buffer from the spatial index
- [ ] Zoom-independent border width, crisp edges at any devicePixelRatio
- [ ] Level-of-detail: fill-only below readable zoom, labels above it
- [ ] Hover / selected / edited visual states without rebuilding buffers
- [ ] Buffer reuse (no per-frame allocation), explicit GL resource disposal

## Phase 4 — Transactional state & bounding box editor (Modules B, D)

- [ ] Document store: pages, nodes, reading order, tables
- [ ] Command/patch transaction engine with inverse patches
- [ ] Undo/redo stack, minimum 50 levels, drag gestures coalesced into one transaction
- [ ] Keyboard bindings (Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z)
- [ ] Selection model (single, additive, marquee)
- [ ] Box move + 8-handle resize with pixel-perfect hit slop
- [ ] Re-label a box (class picker)
- [ ] Snapping: edges snap to nearby block edges with visible guide lines
- [ ] Mutations replayed into the worker index; stream updates never corrupt local edits
- [ ] Unit tests: inverse correctness, 50+ undo depth, snap solver

## Phase 5 — Tree view & bi-directional grounding (Module D)

- [ ] Hierarchical tree of pages → blocks → lines / cells
- [ ] Virtualized tree rendering (windowed, handles 10k nodes)
- [ ] Canvas selection/hover → tree scroll-into-view + highlight
- [ ] Tree selection/hover → canvas highlight + camera focus
- [ ] JSON / Markdown inspector for the selected node

## Phase 6 — Reading-order graph tool (Module B)

- [ ] Directed reading-order edges rendered as arrows between blocks
- [ ] Sequence badges (1 → 2 → 3) with LOD
- [ ] Drag a connection handle to re-parent a linkage
- [ ] Cycle prevention and order renumbering as a single transaction
- [ ] Edge culling against the visible world rect

## Phase 7 — Table grid mesh corrector (Module B)

- [ ] Table mesh model (row/column dividers derived into cells)
- [ ] Editable mesh overlay on detected tables
- [ ] Drag row/column dividers with live cell bbox recalculation
- [ ] Cell split (horizontal / vertical)
- [ ] Cell merge across a selected span
- [ ] All mesh edits as undoable transactions

## Phase 8 — Live streaming ingestion (Module C)

- [ ] SSE mock endpoint served by a Vite dev/preview middleware plugin
- [ ] In-app fallback stream generator for static hosting
- [ ] Out-of-order page extraction events with partial payloads
- [ ] Worker-side reconciliation buffer, no main-thread parsing
- [ ] Live partial page rendering without dropping frames
- [ ] Stream control panel: connect/disconnect, throughput, event log
- [ ] Long-task budget check (< 16ms) during ingestion

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

# Document Layout Repair Workspace

A human-in-the-loop workspace for repairing AI document layout extractions: multi-page
scans overlaid with thousands of interactive bounding boxes, a directed reading-order
graph, editable table meshes, and a live extraction stream — held at 60 FPS with the
expensive work off the main thread.

**[Live demo](https://document-layout-repair.vercel.app)** ·
**[Architecture](./ARCHITECTURE.md)** ·
**[Performance evidence](./docs/perf)**

The overlay is one instanced WebGL2 draw call over a viewport-culled buffer. Extraction
payloads are parsed, spatially indexed and reconciled inside Web Workers. Every canvas
mutation goes through an invertible-patch transaction stack.

## Run it

```bash
npm install
npm run dev            # http://localhost:5173
```

Or with Docker, which builds and serves the production bundle including the mock
extraction stream endpoint:

```bash
docker build -t layout-repair .
docker run --rm -p 4173:4173 layout-repair    # http://localhost:4173
```

## The three datasets

Switch between them with the buttons at the top left. The benchmark is the second one.

| Dataset | What it is |
| --- | --- |
| **Sample document** | 6 pages, 743 boxes — comfortable for editing |
| **Stress test document** | **100 pages, 11,513 boxes** — the benchmark, seed `0x5eed01` |
| **Live extraction** | 40 pages arriving over SSE, out of order and interleaved |

The pages are synthetic scans generated deterministically from a seed and typeset with
real text. The same generator produces the extraction payloads, so every bounding box
lands on the ink it describes and every tree label quotes the text actually printed.

## Measured

| Metric | Target | Measured |
| --- | --- | --- |
| Frame rate, continuous pan with the 100-page document | 60 FPS | 59–60 FPS · frame 0.10 ms · p95 0.20–0.30 ms |
| …with culling off, all 11,513 boxes submitted | 60 FPS | 59–60 FPS · frame 0.10 ms · p95 0.20 ms |
| …pan at 500% zoom, 42 page tiles composited | 60 FPS | 56–60 FPS · frame 0.30 ms · p95 0.50 ms |
| Main-thread blocking during live SSE ingestion | < 16 ms | 0 long tasks · worst worker event 0.30 ms |
| Click-to-selection across 11,513 boxes | < 2 ms | 0.1–0.6 ms including the worker round trip |
| Heap across 20 load / edit / undo / redo cycles | no leak | 4.5 → 5.1 MB, decelerating, flat by the last five |

Taken from a production build in a GPU-backed Chromium window at `devicePixelRatio` 2. The
workspace reports all of them live in its own HUD; [`docs/perf`](./docs/perf) holds the
DevTools traces, the HUD captures and the commands that reproduce them.

One finding worth flagging, because it contradicts the obvious expectation: **viewport
culling makes no measurable difference on the WebGL2 path** — one instanced draw call
costs the same for 11,513 quads as for 3,884. It is the difference between 60 and 30 FPS
on the 2D fallback, where cost is per box. Both toggles are in the toolbar so the
comparison is checkable rather than asserted; the numbers are in
[`docs/perf`](./docs/perf).

## What you can do

**Navigate** — drag to pan, wheel to zoom toward the cursor, pinch on a trackpad, 10% to
500%. The frame HUD reads `idle` when nothing is being redrawn, which is the intended
behaviour: rendering is driven by dirty flags, so an untouched workspace draws no frames.

**Select & edit** (default tool) — click to select the most specific box under the pointer;
shift-drag a marquee; drag to move, drag a handle to resize, with edges snapping to nearby
blocks and guides drawn between the two boxes they align. Re-label one box or a whole
selection from the inspector.

**Reading order** — the sequence renders as a directed graph with numbered badges. Drag a
block's connector onto another block to make that block the next one read.

**Table mesh** — drag a row or column divider to reshape a table; select a cell to split
it, or marquee several cells and merge them. The scan itself is immutable: the mesh
corrects the model's grid, not the printed rules, so the page is washed out underneath
while the tool is active.

**Ground it both ways** — selecting or hovering a box reveals and highlights its row in the
structure tree; selecting or hovering a row highlights the box, and double-clicking eases
the camera onto it. The inspector describes the selection as properties, as the JSON that
would be exported, and as Markdown — which is how you check that reading order, table
shape and key-value pairing actually came out right.

**Everything undoes.** A whole drag is one step, and the stack holds 100.

## Keyboard

| Key | Action |
| --- | --- |
| drag · space+drag · middle-drag | pan |
| wheel · ctrl+wheel | zoom to cursor · trackpad pinch |
| `+` `−` | zoom in / out from the centre |
| `1` · `0` | actual size · fit the whole document |
| arrows | pan by a step |
| shift-drag | marquee select (with ⌘/ctrl: add to the selection) |
| shift-click | toggle one box in the selection |
| ⌘Z · ⇧⌘Z | undo · redo |
| Esc | clear the selection, or cancel a drag |

## Scope

Built: virtualized WebGL2 overlay with viewport culling and level of detail; tiled page
rasterization in a worker; quadtree hit-testing in a worker; box move/resize with snapping;
re-labelling; marquee selection; the reading-order graph with drag re-linking; the table
mesh with divider dragging, cell split, merge and unmerge; the virtualized structure tree
with bi-directional grounding; JSON and Markdown inspectors; SSE ingestion with worker-side
reconciliation and an in-worker fallback; a patch-based transaction stack with 100 levels.

Consciously left out, and why:

- **Real PDF or image rasterization.** Pages are synthetic scans generated from a seed. It
  keeps the repository free of binary fixtures and makes every box verifiable against the
  ink, which a stock PDF would not.
- **A backend, auth, and persistence.** Edits live in the session. The transaction stack is
  the part worth building; a save endpoint is not.
- **Model inference.** Extraction payloads are mocked, with realistic confidence noise so
  the low-confidence highlighting has something real to point at.
- **Word-level geometry.** Without it, splitting a table cell cannot divide the cell's text,
  so the new cell is left empty and marked unverified rather than guessing.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Dev server, with the mock stream endpoint |
| `npm run build` · `npm run preview` | Typecheck and build · serve the build with the endpoint |
| `npm run typecheck` · `npm run lint` | TypeScript project check · ESLint |
| `npm test` | Vitest suite — 198 tests |
| `npm run test:e2e` | Playwright suite — 50 tests |
| `npm run perf:pan` | Frame statistics before, during and after a continuous pan |
| `npm run perf:trace` | A DevTools timeline recording plus the HUD mid-pan |
| `npm run perf:stream` | The stream panel captured mid-ingestion |
| `npm run perf:memory` | Heap after repeated load / edit / undo / redo cycles |

The performance scripts take `GPU=1` to open a GPU-backed window. Without it Chromium
rasterizes on the CPU and the numbers are not representative — the same pan that holds
60 FPS reports 11 FPS headless.

## Stack

React 19 · TypeScript (strict) · Vite · WebGL2 and Canvas 2D · native Web Workers ·
Zustand for the chrome's state and a custom patch engine for the document's · Vitest ·
Playwright.

Nothing beyond that: the coordinate math, the instanced renderer, the quadtree, the tile
cache and the transaction engine are the parts worth owning.

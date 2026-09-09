# Document Layout Repair Workspace

A human-in-the-loop workspace for reviewing and repairing AI document layout extractions:
multi-page scans overlaid with thousands of interactive bounding boxes, a directed
reading-order graph, editable table meshes, and a live extraction stream.

Overlay rendering is one instanced WebGL2 draw call over a viewport-culled buffer.
Extraction payloads are parsed, spatially indexed and reconciled inside Web Workers. Every
canvas mutation goes through an invertible-patch transaction stack.

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — coordinate math, render pipeline, thread
  protocols, spatial indexing, memory and frame-rate techniques, and the trade-offs.
- **[docs/performance](./docs/performance)** — DevTools traces, HUD captures, measured
  results and how to reproduce them.

## Run it

```bash
npm install
npm run dev            # http://localhost:5173
```

Or with Docker, which builds and serves the production bundle **including** the mock
extraction stream endpoint:

```bash
docker build -t layout-repair .
docker run --rm -p 4173:4173 layout-repair    # http://localhost:4173
```

## The three datasets

The toolbar switches between them.

| Dataset | What it is |
| --- | --- |
| **Sample document** | 6 pages, 743 boxes — comfortable for editing |
| **Stress test document** | **100 pages, 11,513 boxes** — the benchmark |
| **Live extraction** | 40 pages delivered over SSE, out of order and interleaved |

The pages are synthetic scans generated deterministically from a seed, typeset with real
text. The same generator produces the extraction payloads, so every bounding box lands on
the ink it describes and every tree label quotes the text actually printed.

## Measured against the brief

| Metric | Target | Measured |
| --- | --- | --- |
| Frame rate, continuous pan with the 100-page document | 60 FPS | 57–60 FPS, p95 0.2–0.4 ms |
| …with culling off, all 11,513 boxes submitted | 60 FPS | 60 FPS, p95 0.2 ms |
| Main-thread blocking during live ingestion | < 16 ms | no long tasks; worst worker event 0.3–0.5 ms |
| Click-to-selection across 11,513 boxes | < 2 ms | 0.1–0.6 ms including the worker round trip |
| Memory across repeated load / undo / redo cycles | no leak | flat after warm-up; 18 cycles move the heap 0.7 MB |

Numbers from a GPU-backed Chromium window at `devicePixelRatio` 2. The workspace reports
all of them live in its own HUD, and
[docs/performance](./docs/performance) has the traces and the commands.

## What you can do

**Navigate** — drag to pan, wheel to zoom toward the cursor, pinch on a trackpad, 10% to
500%.

**Select & edit** (default tool) — click a box to select the most specific one under the
pointer; shift-drag a marquee; drag to move, drag a handle to resize, with edges snapping
to nearby blocks and guides drawn between the two boxes they align. Re-label one box or a
whole selection from the inspector.

**Reading order** — the sequence renders as a directed graph with numbered badges. Drag a
block's connector onto another block to make that block the next one read.

**Table mesh** — drag a row or column divider to reshape a table; select a cell to split
it, or marquee several cells and merge them. The scan is immutable: the mesh corrects the
model's grid, not the printed rules, so the page is washed out underneath while the tool is
active.

**Ground it both ways** — selecting or hovering a box reveals and highlights its row in the
structure tree; selecting or hovering a row highlights the box, and double-clicking eases
the camera onto it. The inspector describes the selection as properties, as the JSON that
would be exported, and as Markdown — which is how you check that reading order, table shape
and key-value pairing actually came out right.

**Everything undoes.** A whole drag is one step, and the stack holds 100.

## Keyboard

| Key | Action |
| --- | --- |
| drag / space+drag / middle-drag | pan |
| wheel · ctrl+wheel | zoom to cursor · trackpad pinch |
| `+` `−` | zoom in / out from the centre |
| `1` | actual size |
| `0` | fit the whole document |
| arrows | pan by a step |
| shift-drag | marquee select (⌘/ctrl too: add to the selection) |
| shift-click | toggle one box in the selection |
| ⌘Z / ⇧⌘Z | undo / redo |
| Esc | clear the selection, or cancel a drag |

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Dev server, with the mock stream endpoint |
| `npm run build` | Typecheck and build for production |
| `npm run preview` | Serve the production build, with the stream endpoint |
| `npm run typecheck` · `npm run lint` | TypeScript project check · ESLint |
| `npm test` | Vitest suite (189 tests) |
| `npm run test:e2e` | Playwright suite (49 tests) |
| `npm run perf:pan` | Frame statistics before, during and after a continuous pan |
| `npm run perf:trace` | A DevTools timeline recording plus the HUD mid-pan |
| `npm run perf:memory` | Heap after repeated load / edit / undo / redo cycles |

The performance scripts take `GPU=1` to open a GPU-backed window. Without it Chromium
rasterizes on the CPU, and the numbers are not representative — see
[docs/performance](./docs/performance).

## Stack

React 19 · TypeScript (strict) · Vite · WebGL2 and Canvas 2D · native Web Workers ·
Zustand for the chrome's state, a custom patch-based engine for the document's ·
Vitest · Playwright.

No canvas or state library beyond that: the coordinate math, the instanced renderer, the
quadtree, the tile cache and the transaction engine are the parts worth owning.

# Architecture

A human-in-the-loop workspace for repairing document layout extractions: multi-page
scans, thousands of interactive bounding boxes, a reading-order graph, editable table
meshes, and a live extraction stream — at 60 FPS, with the expensive work off the main
thread.

This document covers the four things worth explaining: the coordinate math and render
pipeline, how the threads talk, how hit-testing is indexed, and where the frame time and
the memory go. It closes with the trade-offs I made deliberately.

---

## 1. Threads and ownership

```
┌───────────────────────────── main thread ─────────────────────────────┐
│                                                                       │
│  React chrome            ViewportRenderEngine          LayoutEditor   │
│  toolbar, tree,          camera, rAF loop,             selection,     │
│  inspector, panels       per-layer dirty flags         transactions   │
│        │                          │                         │         │
│        └── zustand stores ─────────┴─────────────────────────┘         │
│            (selection, history, stream status — never geometry)        │
└───────┬───────────────────────────────────────────────────┬───────────┘
        │ typed request/response                            │ typed
        │                                                   │
┌───────▼──────────────────┐                    ┌───────────▼───────────┐
│  extraction worker       │                    │  page raster worker   │
│  · parses model payloads │                    │  · paints synthetic   │
│  · normalizes to typed   │                    │    scans into tiles   │
│    arrays                │                    │  · OffscreenCanvas →  │
│  · owns the QuadTree     │                    │    ImageBitmap        │
│  · owns the EventSource  │                    │  · yields between     │
│    for the live stream   │                    │    tiles so a stale   │
│  · answers hit-tests     │                    │    queue can be       │
│                          │                    │    dropped            │
└──────────────────────────┘                    └───────────────────────┘
```

Three rules hold the design together:

**React never participates in a frame.** It mounts a container; everything after that is
imperative. The stores mirror only what the chrome renders — selection ids, history depth,
stream status. Geometry is deliberately absent from them, because a drag would otherwise
re-render the workspace sixty times a second to show numbers nobody reads mid-gesture.

**The worker owns the authority for anything it can answer asynchronously.** Hit-testing
is a click, not a frame, so it can afford a round trip and lives behind the quadtree.
Culling is per frame, so it cannot, and runs on the main thread over data the worker sent.

**Payload bytes never reach the main thread.** The extraction worker holds the
`EventSource` itself. It parses, reconciles and indexes, and sends back only dense typed
arrays for the range it appended.

---

## 2. Coordinate systems and the transformation matrix

Three spaces, in `src/canvas/viewport/camera.ts`:

| Space | Unit | Used by |
| --- | --- | --- |
| **world** | 1 unit = 1 CSS pixel at 100% zoom | document layout, node bounds, all editing |
| **screen** | CSS pixels from the viewport's top-left | pointer input, hit tolerances |
| **device** | physical pixels | canvas backing stores, stroke widths, handles |

The camera is three numbers — the world point at the viewport's top-left, and the scale:

```ts
type Camera = { worldX: number; worldY: number; scale: number }

screen = (world − cameraOrigin) × scale
world  = screen ÷ scale + cameraOrigin
```

### Zoom to cursor

Zooming keeps the world point under the pointer pinned to that same screen position. Solve
`worldToScreen(next, anchorWorld) = anchorScreen` for the new origin:

```ts
anchorWorld = screenToWorld(camera, anchorScreen)
next.worldX = anchorWorld.x − anchorScreen.x / nextScale
```

Scale is clamped to 10%–500% **before** the origin is derived, so the anchor stays pinned
even when the requested zoom is clamped away — a unit test asserts exactly that, because
clamping after the fact is the usual way this drifts.

Wheel response is exponential (`scale × e^(−Δy·k)`), which makes zoom feel linear in
perceived magnification and, being multiplicative, means a scroll and its reverse cancel
exactly.

### The 2D layers: world → device

```ts
const pixelsPerWorldUnit = camera.scale * devicePixelRatio
context.setTransform(
  pixelsPerWorldUnit, 0, 0, pixelsPerWorldUnit,
  −camera.worldX * pixelsPerWorldUnit,
  −camera.worldY * pixelsPerWorldUnit,
)
```

The page-raster layer is the exception: it composites in **snapped device pixels** rather
than through this transform. Under a scaled transform, adjacent tiles land on fractional
device boundaries and leave hairline gaps; over a canvas cleared to the workspace colour
those gaps read as a black grid across the page. Rounding each tile edge from its world
position makes tile *n*'s right edge and tile *n+1*'s left edge round to the same device
pixel, so a gap is arithmetically impossible. A Playwright test asserts that no
workspace-coloured pixel survives once a page fills the viewport.

### The WebGL layer: world → clip

The overlay needs a `mat3` from world space to clip space, with Y flipped so world Y grows
downward like everywhere else:

```
        ⎡ 2s/W      0     −2s·cx/W − 1 ⎤        s = camera.scale
  M  =  ⎢   0    −2s/H     2s·cy/H + 1 ⎥        W, H = viewport in CSS pixels
        ⎣   0       0            1     ⎦        cx, cy = camera origin
```

`devicePixelRatio` is deliberately absent: the GL viewport already covers the whole
backing store, so clip space is resolution independent. It is written into a reused
`Float32Array(9)` each frame rather than allocated, and a test checks it against
`worldToScreen` for an arbitrary interior point — two independent derivations of the same
transform that must agree.

### High-DPI handling

The engine sizes every backing store to `round(cssSize × devicePixelRatio)` and re-measures
when the ratio changes — including the case where a window is dragged between displays,
which changes `devicePixelRatio` without resizing the container, so it is checked at the
top of each frame rather than only on resize.

Everything measured in screen pixels — handle size, grab radii, border weights, snap
tolerances, hairlines — is multiplied by the ratio at draw time and divided by it at
hit-test time. Hairlines are drawn on half-pixel centres so a one-pixel line lands on one
pixel rather than across two.

---

## 3. The render pipeline

Five stacked canvases in one container, composited by the browser in CSS z-order, all
driven by one camera:

| # | Layer | Context | Repainted when |
| --- | --- | --- | --- |
| 1 | page rasters | 2D | camera moves, a tile arrives |
| 2 | bounding boxes | **WebGL2** | camera moves, geometry changes |
| 3 | reading-order graph | 2D | camera moves, order changes, tool switches |
| 4 | table mesh | 2D | camera moves, mesh changes, hovered divider changes |
| 5 | interaction chrome | 2D | pointer moves, selection changes |

The split is the point. Hovering a box repaints layer 5 — a few outlines and a label —
and touches nothing else. Dragging a table divider repaints 4 and 5. Panning repaints 1
and 2 and updates one uniform. There is no frame in which all five are redrawn for a
reason that only concerned one of them.

`RenderScheduler` coalesces every request in a frame into a single `requestAnimationFrame`
callback, and the engine renders only the layers whose dirty flag is set. An idle
workspace costs nothing: no rAF loop spins when nothing has changed.

### The overlay: one draw call

All visible boxes go into one interleaved instance buffer — 28 bytes each: a `vec4` world
rectangle, two `ubyte4` colours, and a border width in device pixels — and one
`drawArraysInstanced` call over a unit quad. The cost of a frame is independent of how
many boxes are in it, which is what lets all 11,513 be submitted at once and still hold 60
FPS.

Two details that matter for a document overlay:

- **Border weight is measured in device pixels in the fragment shader**, from the
  fragment's distance to the nearest edge. A 2-pixel border stays 2 pixels at 10% and at
  500% zoom, instead of scaling with the geometry into either a hairline or a slab.
- **A box can never vanish between device pixels.** The vertex shader clamps the drawn
  size to at least one device pixel, and below a few pixels the CPU collapses the box to a
  solid tint of its class colour — at that size a border and a fill occupy the same pixel,
  and drawing both just makes a grey smear.

A 2D fallback renderer reads the same packed buffer, so culling and level of detail behave
identically where WebGL2 is unavailable; only the submission cost differs.

### Culling

`OverlayInstanceBuffer` walks the node spans of the pages the viewport touches. Pages are
laid out on a grid, so which pages are visible is arithmetic, and each page owns a list of
contiguous node id spans — so the scan is proportional to what is on screen rather than to
the size of the document. At 10% zoom over the benchmark that is 4,831 rectangles scanned
and 3,884 kept, in about 1–2 ms.

The result is cached for an **envelope** 35% larger than the viewport. Ordinary panning
stays inside it and re-uses the packed buffer, so only the transform uniform changes; the
buffer is repacked when the viewport leaves the envelope, when the zoom changes (level of
detail depends on it), or when the document changes. A debug toggle disables culling
entirely, which is how the renderer's raw instance throughput was measured rather than
asserted.

---

## 4. Worker communication

Both workers use the same shape: a discriminated-union request type, a discriminated-union
response type, and a correlation id per request. No `any` crosses the boundary, and
`postMessage` payloads are checked against the protocol at compile time through a small
typed view of the worker scope (`src/workers/typedWorkerScope.ts`) — pulling in the full
`WebWorker` lib alongside `DOM` collides on dozens of declarations, and these workers only
ever need `onmessage` and `postMessage`.

### Page raster worker

Requests a whole-page thumbnail or a single tile; replies with a transferred
`ImageBitmap`. It awaits `createImageBitmap` between rasters, which yields to its own
message queue — so a `dropPendingRequests` sent when the zoom crosses a level-of-detail
boundary takes effect immediately instead of behind a queue of tiles nobody will look at.

### Extraction worker

Owns document state: payload parsing, normalization into structure-of-arrays geometry, the
quadtree, and the live stream. It answers three kinds of message:

- `loadDocument` — generates, parses and indexes a benchmark document, posting progress
  every few pages and yielding between chunks so a 100-page load never blocks anything.
- `hitTest` — a point query, answered in about 0.1 ms; the round trip brings
  click-to-selection to 0.1–0.6 ms end to end.
- `patchNodeGeometry` — a committed edit replayed into the index. Bounds **and flags**
  travel together: hiding a cell by merging has to stop it answering hit-tests, and an
  unknown node id is treated as an insert rather than a move, because splitting a table
  cell creates nodes.

### What crosses the boundary

Geometry moves as transferred typed arrays. A batch load sends the whole document once
(~300 KB for 11,513 nodes); a stream event sends only the range it appended.

The worker keeps its own copy rather than sharing the buffers, and this is a deliberate
trade: transferring neuters the sender's arrays, and the worker still needs geometry to
answer hit-tests. A `SharedArrayBuffer` would remove the copy, at the cost of COOP/COEP
headers on every deployment and cross-thread mutation ordering to reason about. For
~300 KB, copying is the cheaper engineering decision.

---

## 5. Spatial indexing and hit-testing

`src/spatial/QuadTree.ts` — a region quadtree over world-space rectangles, node capacity
8, maximum depth 12. Each node keeps its items as parallel arrays (`itemIds[i]` describes
the rectangle at `itemRects[i·4]`), so a point query answers containment in one
cache-friendly pass without dereferencing document state.

A rectangle that straddles a split stays at the node that fully contains it. That is what
keeps an item stored exactly once, so removal never has to search sibling branches, and an
edit is `remove` + `insert` in `O(log N)`.

### Resolving overlap

Overlap is the norm in a layout tree: a line sits inside a paragraph, a key label inside a
key-value pair. A point query therefore returns a candidate set, and
`LayoutSpatialIndex` resolves it by **smallest area** — which is what "the most specific
box" means geometrically. Clicking a line of text selects the line, not the paragraph that
contains it, and the full candidate list is returned alongside so a future
alt-click could cycle outward.

Tests compare the tree against brute force over 10,000 random rectangles for 200 point
probes and 40 viewport-sized range queries, and separately assert that the average point
query stays well inside the 2 ms click-to-selection budget.

### Why culling does not use it

Two different queries with different constraints:

- **Hit-testing** must be exact, is triggered by a click, and can afford a thread hop.
  `O(log N)` quadtree, in the worker.
- **Culling** runs every frame on the main thread and cannot round-trip. It exploits the
  document's own partition instead: pages on a grid, each owning contiguous node spans.
  Proportional to what is on screen, no index required, no duplicate structure to keep in
  sync.

Marquee selection uses the same span walk as culling, for the same reason — it needs an
answer within the gesture.

---

## 6. Transactional state

Snapshotting an 11,000-node document per keystroke is not viable, so history is built from
**invertible patches** (`src/state/history/`). Applying a mutation returns the mutation
that undoes it; a transaction is the two lists.

```ts
type LayoutMutation =
  | { kind: 'setNodeBounds'; nodeId; bounds }
  | { kind: 'setNodeRecord'; record }     // a split creates cells
  | { kind: 'setNodeClass'; nodeId; classId }
  | { kind: 'setNodeText'; nodeId; text }
  | { kind: 'setNodePresence'; nodeId; isPresent }
  | { kind: 'setReadingOrder'; pageIndex; nodeIds }
  | { kind: 'setTableMesh'; pageIndex; tableNodeId; columnEdges; rowEdges; cells }
```

Geometry lives in typed arrays and is mutated in place; the *record* of what changed is
what makes it reversible. The undo stack is proportional to what was edited, not to the
document, and holds 100 transactions — twice the depth the brief asks for.

**A drag is one undo step.** A gesture emits a patch per frame, but keeps only the *first*
inverse it sees for each thing it touches — the one that restores the pre-gesture state —
and collapses the intermediate positions on release. A 200-frame drag commits a single
transaction. A randomized 240-edit sequence, undone to the bottom, is asserted to restore
the document byte for byte.

Two ordering rules are load-bearing:

- A **table mesh is replaced as one value**. Dividers and cells always change together
  when a cell is split or merged, and applying them separately would leave cell
  rectangles briefly derived from a grid they do not belong to.
- Within a table transaction, **nodes are created before the mesh that sizes them**, and
  cells are hidden only *after* the mesh has been reshaped.

A test asserts the invariant that matters: after any split, merge, unmerge, divider drag or
undo, every present cell covers its grid cell exactly once, and its node bounds match the
mesh.

---

## 7. The live stream

Pages arrive out of order and interleaved, over Server-Sent Events from a Vite plugin that
runs in both `dev` and `preview`. The point of a real endpoint rather than a timer is that
chunked transfer, arrival order and a droppable connection are all real.

Reconciliation is built on arrival order being meaningless:

- **A chunk carries whole blocks** — a root and all its children — so it never refers to a
  parent that has not arrived, and chunks can be applied in any order.
- **Every chunk repeats the page's reading order**, so the correct sequence is recovered by
  filtering that list to the blocks that have actually landed. Appending in arrival order
  would scramble it.
- **Table meshes are ordered by position**, not arrival, so anything serialized from them
  is identical whether the document was streamed or loaded in one batch.
- **Chunks that arrive before the document has been sized wait in a buffer** and are
  replayed once the header lands. A stream is not obliged to deliver its header first.

Each page therefore owns a *list* of contiguous node spans rather than one — which is what
lets chunks from different pages interleave without breaking the span walk that culling and
marquee selection depend on.

Appends extend the document **in place**: the object identity is preserved, so the canvas
engine and the editor keep the same reference and only have to be told it grew. A stream
update cannot reset the selection or invalidate an edit already in the undo stack, and
there is a test that edits mid-stream and undoes it after the stream finishes.

The correctness proof is one test: a shuffled chunk stream reconstructs *exactly* the
document a batch load produces — node counts, per-page counts, reading order, table
meshes, text and source ids.

If the endpoint is unreachable — a static deployment with no server behind it — the worker
generates the same event sequence itself, so the workspace behaves identically either way.

---

## 8. Memory management

Nothing here is garbage collected on its own, so each is owned explicitly:

**`ImageBitmap`s** are backed by driver memory. The page raster cache is an LRU keyed by
page, level and tile, capped at 96 tiles and 128 thumbnails, and **`close()` is called on
every eviction and teardown path** — including bitmaps that arrive after the cache was
disposed.

**Page rasters are tiled with level of detail.** A 100-page document at full resolution
would be gigabytes. Instead: a whole-page thumbnail at ⅛ texel per world unit (~136 KB)
used while zoomed out and as the instant fallback under missing tiles, and 512-texel tiles
at power-of-two levels chosen so the texels drawn stay within a factor of two of the device
pixels they cover. Only visible tiles are ever rasterized.

**GL resources** — program, VAO, buffers — are deleted on disposal, and the instance
buffer grows in powers of two so a deep zoom-out does not reallocate every frame.

**Per-frame allocation is designed out** of the hot paths: the render frame object, the
`mat3`, the visible-page list, tile draw commands and the frame-statistics ring buffer are
all reused. The frame statistics are a fixed-size `Float32Array`, so measuring the frame
rate cannot itself grow during a long pan.

**Every subscription is disposable.** The render engine, input controller, both workers,
the `ResizeObserver`s, the editor subscription and the window listeners are all torn down
when the viewport unmounts, which is what makes repeated preset switching flat rather than
cumulative.

Measured: 18 load / edit / undo / redo cycles over the 100-page document, with 90
edit/undo/redo passes, move the heap from 4.4 MB to 5.1 MB with a decelerating trend that
is flat by the last few cycles — V8 warm-up, not accumulation. `npm run perf:memory`
reproduces it, reading the real used heap over the DevTools protocol because
`performance.memory` is quantized and cannot show a slow leak.

---

## 9. Frame-rate techniques, in one list

1. One instanced draw call for every visible box; frame cost independent of box count.
2. Culling over page spans, cached for a padded envelope so panning updates one uniform.
3. Per-layer dirty flags across five canvases; hovering repaints outlines, not the document.
4. Page rasterization entirely in a worker; the main thread only calls `drawImage`.
5. Tile level of detail, so texels drawn stay within 2× of the device pixels they cover.
6. Tiles composited on snapped device pixels — correctness, and no resampling of a
   fractional edge.
7. Expensive resampling reserved for minification; magnifying a placeholder thumbnail uses
   the cheap filter.
8. No per-frame allocation in the render loop.
9. Level of detail on chrome too: badges, connectors and handles appear only once they are
   large enough to read or aim at.
10. Geometry never passes through React; a drag is one camera write and one repaint per
    pointer event.

---

## 10. Deliberate trade-offs

**Hit-testing round-trips to a worker.** It costs a fraction of a millisecond and keeps a
single authority for the index. The alternative — a second quadtree on the main thread —
means two structures to keep in sync across every edit, undo and stream append.

**The worker keeps its own copy of the geometry.** ~300 KB, in exchange for not needing
`SharedArrayBuffer`, COOP/COEP headers, or cross-thread mutation ordering.

**Pages are laid out on a grid, not a single column.** A hundred A4 pages stacked
vertically run 180,000 world units deep and reveal a handful of pages at minimum zoom; a
grid puts ~9,000 boxes on screen at once, which is the case worth being fast at.

**The scan is immutable.** Dragging a table divider corrects the model's grid, not the
printed rules — those stay where they were inked. The mesh tool washes the page underneath
to make that legible rather than looking like a rendering fault.

**Splitting a cell leaves the new cell empty**, carrying no confidence, so it reads as work
for a human. Nothing can divide a cell's text without word-level geometry, which the
extraction payload does not carry. Merging, by contrast, concatenates — dropping text there
would silently lose content.

**Reading order is a sequence, not parent pointers.** Cycles are therefore unrepresentable:
every operation is a permutation of the same nodes, and sequence numbers are array
positions, so nothing needs renumbering.

**Interaction is gated by on-screen size, not zoom thresholds.** A text line is nine pixels
tall at 40% zoom; ungated, the eight resize handles' grab radii cover the whole box and it
can never be moved. Handles appear once there is room for them, and a table divider's grab
zone is capped at a third of its adjacent tracks so the middle of every cell stays
clickable.

## What I would do next

- Word-level geometry in the payload, so splitting a cell could divide its text.
- `SharedArrayBuffer` behind a capability check, removing the geometry copy where the
  headers can be set.
- Batched geometry patches during a multi-node drag; today each committed transaction is
  one message, which is fine at current selection sizes but would not be for thousands.
- A WebGL layer for the reading-order graph, if a document ever had enough edges on screen
  for the 2D path to matter.

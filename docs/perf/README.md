# Performance evidence

Everything here is reproducible from the scripts in [`scripts/`](../../scripts). The
in-app HUD reports the same numbers live, so nothing has to be taken on trust.

## Recorded traces

| File | What it shows |
| --- | --- |
| `01-pan-stress-100-pages-fps.png` | Frame HUD during a continuous pan over the 100-page benchmark, 3,884 boxes on screen |
| `02-pan-zoomed-in-500-percent-fps.png` | Frame HUD during a pan at 500% zoom, 42 page tiles composited |
| `03-sse-ingestion-long-tasks.png` | Stream panel two thirds through an SSE run: worst worker event, and main-thread long tasks |
| `04-memory-cycles.md` | Heap after 20 load / edit / undo / redo cycles |
| `trace-pan-stress-100-pages.json.gz` | DevTools timeline recording of the pan in (1) |
| `trace-pan-zoomed-in-500-percent.json.gz` | DevTools timeline recording of the pan in (2) |

The two `trace-*.json.gz` files are Chrome DevTools timeline recordings. Open the
**Performance** panel and drop one onto it — DevTools loads a gzipped trace directly, no
need to unzip.

The screenshots are the workspace's own HUD, captured **during** the pan and **during**
ingestion rather than after them, so the numbers shown are the ones under load.

![Frame statistics during a pan over the 100-page benchmark](./01-pan-stress-100-pages-fps.png)

![Stream panel during SSE ingestion](./03-sse-ingestion-long-tasks.png)

## Measured results

Captured on a GPU-backed Chromium window, 1440×900 CSS at `devicePixelRatio` 2.

| Metric | Target | Measured |
| --- | --- | --- |
| Frame rate, continuous pan, 100-page document | 60 FPS | 57–60 FPS, 0.1–0.2 ms per frame, p95 0.2–0.4 ms |
| Frame rate with culling switched off (all 11,513 boxes submitted) | 60 FPS | 60 FPS, p95 0.2 ms |
| Main-thread long tasks during live ingestion | < 16 ms | **none**; worst worker event 0.3–0.5 ms |
| Click-to-selection across 11,513 boxes | < 2 ms | 0.1–0.6 ms, including the worker round trip |
| Heap across 20 load / edit / undo / redo cycles | no growth | 4.4 → 5.1 MB, decelerating and flat by the last four — see `04-memory-cycles.md` |

`frame` is the time this application spends producing a frame — culling, buffer upload,
draw calls, 2D chrome. It excludes the compositor, which is why the frame rate is the
honest headline number and the trace is included alongside it.

## Reproducing

```bash
npm run build
npm run preview                       # in one terminal

# Frame statistics before, during and after a continuous pan
GPU=1 npm run perf:pan -- "Stress test document" 2600
GPU=1 CULLING=off npm run perf:pan -- "Stress test document" 2600

# A DevTools timeline recording plus the HUD mid-pan
GPU=1 npm run perf:trace -- "Stress test document" docs/perf/pan.json 2600

# The stream panel captured mid-ingestion
GPU=1 npm run perf:stream -- docs/perf/03-sse-ingestion-long-tasks.png

# Heap after repeated load / edit / undo / redo cycles
npm run perf:memory -- 18
```

`GPU=1` opens a real GPU-backed window. **Without it Chromium rasterizes on the CPU**
through SwiftShader, which is not representative: the same pan that holds 60 FPS on a GPU
reports 11 FPS headless, and ingestion picks up long tasks that are canvas painting rather
than anything this application does. Every number above was taken with `GPU=1`.

## Where the frame time goes

At 10% zoom over the whole benchmark document:

- **culling** — one pass over the node spans of the pages the viewport touches: 4,831
  rectangles scanned, 3,884 kept. Roughly 1–2 ms, and it does not run again while panning
  inside the cached envelope, only the transform uniform changes.
- **overlay** — one instanced draw call, independent of how many boxes it contains.
- **page rasters** — `drawImage` per visible tile, snapped to device pixels. Tiles are
  rasterized in a worker, never on the main thread.
- **chrome** — selection outlines, handles, snap guides, reading-order arrows: their own
  canvases, repainted only when they change rather than every frame.

## What culling is actually worth

The obvious expectation is that viewport culling is what makes this fast. Measured, it is
not — and that is worth stating plainly, because it is the instanced renderer doing the
work:

Continuous pan over the 100-page benchmark at 10% zoom:

| Overlay renderer | Culling | Boxes submitted | FPS | Frame time |
| --- | --- | --- | --- | --- |
| WebGL2 | on | 3,884 | 60 | 0.10 ms |
| WebGL2 | **off** | 11,513 | 60 | 0.10 ms |
| Canvas2D | on | 3,884 | 60 | 3.60 ms |
| Canvas2D | **off** | 11,513 | **30** | **10.70 ms** |

On the WebGL2 path, one instanced draw call costs the same for 11,513 quads as for 3,884,
so switching culling off changes nothing measurable. On the 2D path the cost is per box,
and culling is the difference between 60 FPS and 30 — which is exactly why the brief rules
out a DOM overlay, and why the toolbar can switch renderers: the claim is checkable rather
than asserted.

Culling still earns its place. It bounds the instance buffer upload — 322 KB versus half a
kilobyte once the viewport is zoomed in on a handful of boxes — it keeps the 2D fallback
usable, and it is what the workspace would need first if boxes gained per-instance state
that had to be repacked per frame.

Both toggles are in the toolbar, so any of these rows can be reproduced by hand:

```bash
GPU=1 RENDERER=canvas2d CULLING=off npm run perf:pan -- "Stress test document" 2600
```

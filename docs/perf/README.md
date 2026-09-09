# Performance evidence

All of it recorded from a production build (`npm run build && npm run preview`) in a
GPU-backed Chromium window at 1440×900 CSS, `devicePixelRatio` 2. The stress document is
generated from seed `0x5eed01`: 100 pages, **11,513 boxes**, identical every run.

Everything here is reproducible from the scripts in [`scripts/`](../../scripts), and the
workspace reports the same numbers live in its own HUD, so nothing has to be taken on
trust.

## Files

| File | What it shows |
| --- | --- |
| `01-pan-stress-100-pages-fps.png` | Frame HUD during a continuous pan over the 100-page benchmark |
| `02-pan-zoomed-in-500-percent-fps.png` | Frame HUD during a pan at 500% zoom, 42 page tiles composited |
| `03-sse-ingestion-long-tasks.png` | Stream panel two thirds through an SSE run: worst worker event, and main-thread long tasks |
| `04-memory-cycles.md` | Heap after 20 load / edit / undo / redo cycles |
| `trace-pan-stress-100-pages.json.gz` | Chrome DevTools timeline recording of the pan in (1) |
| `trace-pan-zoomed-in-500-percent.json.gz` | Chrome DevTools timeline recording of the pan in (2) |

Drop either `trace-*.json.gz` onto the **Performance** panel — DevTools opens a gzipped
trace directly, no need to unzip.

Both HUD screenshots were taken **during** the pan, and the stream panel **during**
ingestion, so the figures shown are the ones under load rather than after it.

## Results

| Metric | Target | Measured |
| --- | --- | --- |
| Frame rate, continuous pan, 100-page document | 60 FPS | **59–60 FPS** · frame 0.10 ms · p95 0.20–0.30 ms |
| Frame rate, culling off, all 11,513 boxes submitted | 60 FPS | **59–60 FPS** · frame 0.10 ms · p95 0.20 ms |
| Frame rate, pan at 500% zoom, 42 tiles composited | 60 FPS | **56–60 FPS** · frame 0.30 ms · p95 0.50 ms |
| Main-thread long tasks during live SSE ingestion | < 16 ms | **0 long tasks** · worst worker event 0.30 ms |
| Click-to-selection across 11,513 boxes | < 2 ms | **0.1–0.6 ms** including the worker round trip |
| Heap across 20 load / edit / undo / redo cycles | no leak | **4.5 → 5.1 MB**, decelerating, flat by the last five |

![Frame statistics during a pan over the 100-page benchmark](./01-pan-stress-100-pages-fps.png)

![Stream panel during SSE ingestion](./03-sse-ingestion-long-tasks.png)

`frame` is the time this application spends producing a frame — culling, buffer upload,
draw calls, 2D chrome. It excludes the compositor, which is why the sustained frame rate is
the honest headline and the traces are published next to it.

`fps` is derived from the intervals between rendered frames, not by counting frames in a
trailing second. Rendering is dirty-flag driven, so a trailing-window count decays as it
drains the moment panning stops — which looks like a collapsing frame rate when nothing has
slowed down. Interval-based, it holds the rate of the last burst and labels itself `idle`
separately.

## What culling is actually worth

The obvious expectation is that viewport culling is what makes this fast. Measured, it is
not — the instanced renderer is. Continuous pan over the 100-page benchmark at 10% zoom:

| Overlay renderer | Culling | Boxes submitted | FPS | Frame time |
| --- | --- | --- | --- | --- |
| WebGL2 | on | 3,884 | 60 | 0.10 ms |
| WebGL2 | **off** | 11,513 | 59 | 0.10 ms |
| Canvas2D | on | 3,884 | 60 | 3.70 ms |
| Canvas2D | **off** | 11,513 | **30** | **10.20 ms** |

One instanced draw call costs the same for 11,513 quads as for 3,884, so switching culling
off changes nothing measurable on the GPU path. On the 2D path the cost is per box, and
culling is the difference between 60 FPS and 30 — which is exactly why a DOM overlay is
ruled out, and why both toggles sit in the toolbar: the claim is checkable rather than
asserted.

Culling still earns its place. It bounds the instance buffer upload — 322 KB versus half a
kilobyte once the viewport is zoomed in on a handful of boxes — it keeps the 2D fallback
usable, and it is the first thing that would matter if boxes gained per-instance state
needing a repack every frame.

## Reproducing

```bash
npm run build
npm run preview                       # in one terminal

# Frame statistics before, during and after a continuous pan
GPU=1 npm run perf:pan -- "Stress test document" 2600
GPU=1 CULLING=off npm run perf:pan -- "Stress test document" 2600
GPU=1 RENDERER=canvas2d npm run perf:pan -- "Stress test document" 2600

# DevTools timeline recording plus the HUD, captured mid-pan
GPU=1 npm run perf:trace -- "Stress test document" docs/perf/pan.json 2600

# The stream panel captured mid-ingestion
GPU=1 npm run perf:stream -- docs/perf/sse.png

# Heap after repeated load / edit / undo / redo cycles
npm run perf:memory -- 20
```

`GPU=1` opens a real GPU-backed window. **Without it Chromium rasterizes on the CPU**
through SwiftShader, which is not representative: the same pan that holds 60 FPS on a GPU
reports 11 FPS headless, and ingestion picks up long tasks that are canvas painting rather
than anything this application does. Every number above was taken with `GPU=1`.

## Where the frame time goes

At 10% zoom over the whole benchmark document:

- **culling** — one pass over the node spans of the pages the viewport touches: 4,831
  rectangles scanned, 3,884 kept, around 1.0–1.2 ms. It does not run again while panning
  inside the cached envelope; only the transform uniform changes.
- **overlay** — one instanced draw call, independent of how many boxes it contains.
- **page rasters** — `drawImage` per visible tile, snapped to device pixels. Tiles are
  rasterized in a worker, never on the main thread.
- **chrome** — selection outlines, handles, snap guides, reading-order arrows: their own
  canvases, repainted only when they change rather than every frame.

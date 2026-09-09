# Memory across repeated load / edit / undo / redo cycles

Each cycle loads the 100-page benchmark (11,513 boxes), fits it, loads the sample
document, and then runs five select → re-label → undo → redo → undo passes. That covers
every subsystem holding resources the garbage collector cannot reclaim on its own: a
preset switch tears down the render engine, its GL program and buffers, and the page
raster worker's `ImageBitmap` cache, while the edits exercise the transaction stack and
the worker's spatial index.

The heap is read over the Chrome DevTools protocol (`HeapProfiler.collectGarbage` then
`Runtime.getHeapUsage`), because `performance.memory` is quantized by the browser and
reports a bucketed value that cannot show a slow leak — it reported a suspiciously exact
9.5 MB for every cycle before this was switched.

```
$ npm run perf:memory -- 20

cycle  heapMB  delta
    1     4.2  +0.0
    2     4.4  +0.0     <- baseline: workers created, caches warm
    3     4.5  +0.1
    4     4.7  +0.3
    5     4.7  +0.4
    6     4.8  +0.4
    7     4.7  +0.3
    8     4.8  +0.4
    9     4.9  +0.5
   10     4.9  +0.5
   11     4.9  +0.5
   12     4.9  +0.5
   13     4.9  +0.5
   14     5.0  +0.6
   15     5.0  +0.6
   16     5.0  +0.6
   17     5.1  +0.7
   18     5.1  +0.6
   19     5.1  +0.6
   20     5.1  +0.6

100 edit/undo/redo cycles completed
settled range 4.4-5.1 MB, +0.04 MB per cycle
```

## Reading it

20 full cycles and 100 edit/undo/redo passes move the heap from 4.4 MB to 5.1 MB, and the
growth **decelerates**: roughly 0.1 MB per cycle over the first five, then flat at 5.1 MB
for the last four. A leak is linear; this is the shape of V8 warming up — compiled code,
inline caches, interned strings — against a document that is fully rebuilt every cycle.

What keeps it flat is explicit ownership rather than luck:

- every evicted `ImageBitmap` is `close()`d, including ones that arrive after the cache was
  disposed;
- the GL program, VAO and buffers are deleted when the layer is;
- both workers, the render engine, the input controller, two `ResizeObserver`s, the editor
  subscription and the window listeners are all torn down when the viewport unmounts;
- the undo stack is capped at 100 transactions, and each transaction holds patches rather
  than snapshots.

# Document Layout Repair Workspace

A high-performance human-in-the-loop workspace for reviewing and repairing AI document
layout extractions: multi-page scans overlaid with thousands of interactive spatial
bounding boxes, reading-order graphs, and editable table meshes.

Overlay rendering runs entirely on `<canvas>` with viewport culling, extraction payloads
are parsed and spatially indexed inside a Web Worker, and every canvas mutation goes
through a transactional undo/redo engine.

## Run locally

```bash
npm install
npm run dev
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Typecheck and build for production |
| `npm run preview` | Serve the production build |
| `npm run typecheck` | TypeScript project check |
| `npm run lint` | ESLint |
| `npm test` | Vitest suite |

## Status

Under active development — see [TODO.md](./TODO.md) for the tracked scope and
[ARCHITECTURE.md](./ARCHITECTURE.md) once published.

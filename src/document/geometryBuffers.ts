import type { LayoutGeometry } from './layoutTypes'

export const INITIAL_NODE_CAPACITY = 2048

/**
 * Capacity is read from the buffers themselves — one entry per node in every array
 * except `bounds`, which holds four.
 */
export function getLayoutGeometryCapacity(geometry: LayoutGeometry): number {
  return geometry.classIds.length
}

export function createLayoutGeometry(capacity = INITIAL_NODE_CAPACITY): LayoutGeometry {
  return {
    bounds: new Float32Array(capacity * 4),
    classIds: new Uint8Array(capacity),
    pageIndexes: new Uint16Array(capacity),
    parentIds: new Int32Array(capacity),
    confidences: new Float32Array(capacity),
    flags: new Uint8Array(capacity),
    nodeCount: 0,
  }
}

/**
 * Grows the geometry buffers in place, doubling until they hold `requiredNodeCount`.
 *
 * Splitting a table cell creates nodes, so the buffers cannot be fixed at load size.
 * The `LayoutGeometry` object identity is preserved and the arrays are swapped, which is
 * safe because every reader — the culler, the layers, the worker — re-reads the arrays
 * off the object rather than holding on to them.
 */
export function ensureLayoutGeometryCapacity(
  geometry: LayoutGeometry,
  requiredNodeCount: number,
): void {
  const capacity = getLayoutGeometryCapacity(geometry)
  if (requiredNodeCount <= capacity) {
    return
  }

  let nextCapacity = Math.max(capacity, INITIAL_NODE_CAPACITY)
  while (nextCapacity < requiredNodeCount) {
    nextCapacity *= 2
  }

  const grown = createLayoutGeometry(nextCapacity)
  grown.bounds.set(geometry.bounds)
  grown.classIds.set(geometry.classIds)
  grown.pageIndexes.set(geometry.pageIndexes)
  grown.parentIds.set(geometry.parentIds)
  grown.confidences.set(geometry.confidences)
  grown.flags.set(geometry.flags)

  geometry.bounds = grown.bounds
  geometry.classIds = grown.classIds
  geometry.pageIndexes = grown.pageIndexes
  geometry.parentIds = grown.parentIds
  geometry.confidences = grown.confidences
  geometry.flags = grown.flags
}

/** Exactly-sized copies of the live buffers, for transfer to another thread. */
export function copyLayoutGeometry(geometry: LayoutGeometry): LayoutGeometry {
  const { nodeCount } = geometry
  return {
    bounds: geometry.bounds.slice(0, nodeCount * 4),
    classIds: geometry.classIds.slice(0, nodeCount),
    pageIndexes: geometry.pageIndexes.slice(0, nodeCount),
    parentIds: geometry.parentIds.slice(0, nodeCount),
    confidences: geometry.confidences.slice(0, nodeCount),
    flags: geometry.flags.slice(0, nodeCount),
    nodeCount,
  }
}

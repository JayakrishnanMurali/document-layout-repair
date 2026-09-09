import { rectContainsRect, rectsIntersect, type Rect } from '@/canvas/geometry'
import { collectVisiblePageIndexes, type DocumentPageLayout } from '@/document/pageLayout'
import {
  NODE_FLAG_REMOVED,
  readNodeBounds,
  type LayoutDocument,
  type LayoutNodeId,
} from '@/document/layoutTypes'

const boundsScratch: Rect = { x: 0, y: 0, width: 0, height: 0 }
const visiblePageIndexesScratch: number[] = []

export type RectQueryMode = 'contained' | 'intersecting'

/**
 * Main-thread rectangle query, used for marquee selection.
 *
 * Like viewport culling, it walks only the pages the rectangle touches and then their
 * contiguous node ranges — the worker's quadtree stays reserved for point hit-testing,
 * which is the query that has to be exact rather than bounded.
 */
export function collectNodesInWorldRect(
  layoutDocument: LayoutDocument,
  pageLayout: DocumentPageLayout,
  worldRect: Rect,
  mode: RectQueryMode = 'contained',
  maximumResults = 2000,
): LayoutNodeId[] {
  const results: LayoutNodeId[] = []
  const pageIndexes = collectVisiblePageIndexes(pageLayout, worldRect, visiblePageIndexesScratch)

  for (const pageIndex of pageIndexes) {
    const range = layoutDocument.pageNodeRanges[pageIndex]
    if (!range) {
      continue
    }

    const lastNodeId = range.firstNodeId + range.nodeCount
    for (let nodeId = range.firstNodeId; nodeId < lastNodeId; nodeId += 1) {
      if ((layoutDocument.geometry.flags[nodeId] & NODE_FLAG_REMOVED) !== 0) {
        continue
      }

      const nodeBounds = readNodeBounds(layoutDocument.geometry, nodeId, boundsScratch)
      const isMatch =
        mode === 'contained'
          ? rectContainsRect(worldRect, nodeBounds)
          : rectsIntersect(worldRect, nodeBounds)

      if (isMatch) {
        results.push(nodeId)
        if (results.length >= maximumResults) {
          return results
        }
      }
    }
  }

  return results
}

/** A node and every descendant, so moving a paragraph carries its lines with it. */
export function collectSubtreeNodeIds(
  layoutDocument: LayoutDocument,
  rootNodeIds: readonly LayoutNodeId[],
  results: Set<LayoutNodeId>,
): Set<LayoutNodeId> {
  const pending = [...rootNodeIds]

  while (pending.length > 0) {
    const nodeId = pending.pop()
    if (nodeId === undefined || results.has(nodeId)) {
      continue
    }
    results.add(nodeId)
    for (const childId of layoutDocument.childIdsByNodeId[nodeId] ?? []) {
      pending.push(childId)
    }
  }

  return results
}

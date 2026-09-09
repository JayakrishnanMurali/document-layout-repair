import { rectContainsPoint, rectContainsRect, rectsIntersect, type Point, type Rect } from '@/canvas/geometry'
import {
  collectVisiblePageIndexes,
  getPageIndexAtWorldPoint,
  type DocumentPageLayout,
} from '@/document/pageLayout'
import {
  NODE_FLAG_REMOVED,
  NO_LAYOUT_NODE_ID,
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

/**
 * Block-level node under a world point, resolved on the main thread.
 *
 * The worker's quadtree answers "the most specific box", which is a line or a cell — but
 * the reading-order tool links whole blocks. A page holds a couple of dozen blocks, so
 * scanning them is both exact and synchronous, which is what a drag needs.
 */
export function findBlockNodeAtWorldPoint(
  layoutDocument: LayoutDocument,
  pageLayout: DocumentPageLayout,
  worldPoint: Point,
): LayoutNodeId {
  const pageIndex = getPageIndexAtWorldPoint(pageLayout, worldPoint)
  if (pageIndex < 0) {
    return NO_LAYOUT_NODE_ID
  }

  const blockNodeIds =
    layoutDocument.readingOrderByPage[pageIndex]?.nodeIds ??
    layoutDocument.rootNodeIdsByPage[pageIndex] ??
    []

  let bestNodeId = NO_LAYOUT_NODE_ID
  let smallestArea = Number.POSITIVE_INFINITY

  for (const nodeId of blockNodeIds) {
    if ((layoutDocument.geometry.flags[nodeId] & NODE_FLAG_REMOVED) !== 0) {
      continue
    }
    const nodeBounds = readNodeBounds(layoutDocument.geometry, nodeId, boundsScratch)
    if (!rectContainsPoint(nodeBounds, worldPoint)) {
      continue
    }
    const area = nodeBounds.width * nodeBounds.height
    if (area < smallestArea) {
      smallestArea = area
      bestNodeId = nodeId
    }
  }

  return bestNodeId
}

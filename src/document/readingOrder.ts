import type { LayoutNodeId } from '@/document/layoutTypes'

/**
 * Reading order is stored as a sequence per page, not as a set of parent pointers.
 *
 * That choice is what makes a cycle unrepresentable: every operation is a permutation of
 * the same nodes, so "block 4 follows block 9 follows block 4" cannot be expressed at
 * all, and sequence numbers never need renumbering — they are array indexes.
 */

export type ReadingOrderMoveResult = {
  nodeIds: LayoutNodeId[]
  /** Position the moved node ended up at, for feedback. */
  movedToIndex: number
}

/**
 * Moves `movedNodeId` so that it immediately follows `afterNodeId`.
 *
 * Returns null when the move is not expressible or would change nothing: dropping a
 * block on itself, on a node from another page, or where it already sits.
 */
export function moveNodeAfter(
  sequence: readonly LayoutNodeId[],
  movedNodeId: LayoutNodeId,
  afterNodeId: LayoutNodeId,
): ReadingOrderMoveResult | null {
  if (movedNodeId === afterNodeId) {
    return null
  }

  const movedIndex = sequence.indexOf(movedNodeId)
  const afterIndex = sequence.indexOf(afterNodeId)
  if (movedIndex < 0 || afterIndex < 0) {
    return null
  }
  if (movedIndex === afterIndex + 1) {
    return null
  }

  const nodeIds = [...sequence]
  nodeIds.splice(movedIndex, 1)
  const insertionIndex = nodeIds.indexOf(afterNodeId) + 1
  nodeIds.splice(insertionIndex, 0, movedNodeId)

  return { nodeIds, movedToIndex: insertionIndex }
}

/** Moves `movedNodeId` to the front of the page's reading order. */
export function moveNodeToStart(
  sequence: readonly LayoutNodeId[],
  movedNodeId: LayoutNodeId,
): ReadingOrderMoveResult | null {
  const movedIndex = sequence.indexOf(movedNodeId)
  if (movedIndex <= 0) {
    return null
  }

  const nodeIds = [...sequence]
  nodeIds.splice(movedIndex, 1)
  nodeIds.unshift(movedNodeId)

  return { nodeIds, movedToIndex: 0 }
}

/** One-based position of a node in its page's reading order, or 0 when absent. */
export function getReadingOrderPosition(
  sequence: readonly LayoutNodeId[],
  nodeId: LayoutNodeId,
): number {
  return sequence.indexOf(nodeId) + 1
}

/**
 * Recomputes reading order from geometry: column by column, then top to bottom.
 *
 * Offered as a reset for a page whose order the model got badly wrong, so a reviewer can
 * start from a sane guess instead of dragging every block into place.
 */
export function deriveReadingOrderFromGeometry(
  nodeIds: readonly LayoutNodeId[],
  bounds: Float32Array,
  columnGapInWorldUnits = 24,
): LayoutNodeId[] {
  const sorted = [...nodeIds]

  sorted.sort((left, right) => {
    const leftOffset = left * 4
    const rightOffset = right * 4
    const leftX = bounds[leftOffset]
    const rightX = bounds[rightOffset]

    // Blocks whose horizontal spans are clearly disjoint belong to different columns.
    const isLeftBeforeRight = leftX + bounds[leftOffset + 2] + columnGapInWorldUnits <= rightX
    const isRightBeforeLeft = rightX + bounds[rightOffset + 2] + columnGapInWorldUnits <= leftX
    if (isLeftBeforeRight) {
      return -1
    }
    if (isRightBeforeLeft) {
      return 1
    }

    return bounds[leftOffset + 1] - bounds[rightOffset + 1]
  })

  return sorted
}

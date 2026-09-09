import type { Rect } from '@/canvas/geometry'
import { NODE_FLAG_REMOVED, type LayoutDocument, type LayoutNodeId } from '@/document/layoutTypes'

/** How close, in screen pixels, an edge must come before it snaps. */
export const SNAP_TOLERANCE_IN_SCREEN_PIXELS = 6

export type SnapGuideOrientation = 'vertical' | 'horizontal'

export type SnapGuide = {
  orientation: SnapGuideOrientation
  /** World x for a vertical guide, world y for a horizontal one. */
  worldPosition: number
  /** Extent of the guide along the other axis, in world units. */
  spanStart: number
  spanEnd: number
}

/**
 * Candidate edges to snap against, as sorted parallel arrays.
 *
 * `spanStarts`/`spanEnds` record the perpendicular extent of the box that contributed
 * each edge, which is what lets a guide be drawn between the two boxes it aligns rather
 * than across the whole page.
 */
export type SnapCandidateEdges = {
  positions: Float64Array
  spanStarts: Float64Array
  spanEnds: Float64Array
  count: number
}

export type SnapCandidates = {
  verticalEdges: SnapCandidateEdges
  horizontalEdges: SnapCandidateEdges
}

const EMPTY_EDGES: SnapCandidateEdges = {
  positions: new Float64Array(0),
  spanStarts: new Float64Array(0),
  spanEnds: new Float64Array(0),
  count: 0,
}

export const EMPTY_SNAP_CANDIDATES: SnapCandidates = {
  verticalEdges: EMPTY_EDGES,
  horizontalEdges: EMPTY_EDGES,
}

function buildSortedEdges(
  positions: number[],
  spanStarts: number[],
  spanEnds: number[],
): SnapCandidateEdges {
  const order = positions.map((_unused, index) => index)
  order.sort((left, right) => positions[left] - positions[right])

  const sortedPositions = new Float64Array(order.length)
  const sortedSpanStarts = new Float64Array(order.length)
  const sortedSpanEnds = new Float64Array(order.length)

  order.forEach((sourceIndex, targetIndex) => {
    sortedPositions[targetIndex] = positions[sourceIndex]
    sortedSpanStarts[targetIndex] = spanStarts[sourceIndex]
    sortedSpanEnds[targetIndex] = spanEnds[sourceIndex]
  })

  return {
    positions: sortedPositions,
    spanStarts: sortedSpanStarts,
    spanEnds: sortedSpanEnds,
    count: order.length,
  }
}

/**
 * Collects the snap edges of every box on one page, minus the boxes being dragged.
 *
 * A page holds roughly a hundred boxes, so this runs once per gesture and every frame of
 * the drag then costs two binary searches.
 */
export function collectSnapCandidates(
  layoutDocument: LayoutDocument,
  pageIndex: number,
  excludedNodeIds: ReadonlySet<LayoutNodeId>,
): SnapCandidates {
  const ranges = layoutDocument.nodeRangesByPage[pageIndex] ?? []
  if (ranges.length === 0) {
    return EMPTY_SNAP_CANDIDATES
  }

  const { geometry } = layoutDocument
  const verticalPositions: number[] = []
  const verticalSpanStarts: number[] = []
  const verticalSpanEnds: number[] = []
  const horizontalPositions: number[] = []
  const horizontalSpanStarts: number[] = []
  const horizontalSpanEnds: number[] = []

  for (const range of ranges) {
    const lastNodeId = range.firstNodeId + range.nodeCount
    for (let nodeId = range.firstNodeId; nodeId < lastNodeId; nodeId += 1) {
      if (excludedNodeIds.has(nodeId) || (geometry.flags[nodeId] & NODE_FLAG_REMOVED) !== 0) {
        continue
      }

      const offset = nodeId * 4
      const left = geometry.bounds[offset]
      const top = geometry.bounds[offset + 1]
      const right = left + geometry.bounds[offset + 2]
      const bottom = top + geometry.bounds[offset + 3]

      verticalPositions.push(left, right)
      verticalSpanStarts.push(top, top)
      verticalSpanEnds.push(bottom, bottom)

      horizontalPositions.push(top, bottom)
      horizontalSpanStarts.push(left, left)
      horizontalSpanEnds.push(right, right)
    }
  }

  return {
    verticalEdges: buildSortedEdges(verticalPositions, verticalSpanStarts, verticalSpanEnds),
    horizontalEdges: buildSortedEdges(horizontalPositions, horizontalSpanStarts, horizontalSpanEnds),
  }
}

export type NearestEdge = {
  index: number
  position: number
  distance: number
}

/** Binary search for the candidate edge closest to `value`, within `tolerance`. */
export function findNearestEdge(
  edges: SnapCandidateEdges,
  value: number,
  tolerance: number,
): NearestEdge | null {
  if (edges.count === 0) {
    return null
  }

  let low = 0
  let high = edges.count - 1
  while (low < high) {
    const middle = (low + high) >>> 1
    if (edges.positions[middle] < value) {
      low = middle + 1
    } else {
      high = middle
    }
  }

  let bestIndex = -1
  let bestDistance = Number.POSITIVE_INFINITY

  for (const candidateIndex of [low - 1, low, low + 1]) {
    if (candidateIndex < 0 || candidateIndex >= edges.count) {
      continue
    }
    const distance = Math.abs(edges.positions[candidateIndex] - value)
    if (distance < bestDistance) {
      bestIndex = candidateIndex
      bestDistance = distance
    }
  }

  if (bestIndex < 0 || bestDistance > tolerance) {
    return null
  }

  return { index: bestIndex, position: edges.positions[bestIndex], distance: bestDistance }
}

function createGuide(
  orientation: SnapGuideOrientation,
  edges: SnapCandidateEdges,
  edgeIndex: number,
  position: number,
  movingSpanStart: number,
  movingSpanEnd: number,
): SnapGuide {
  return {
    orientation,
    worldPosition: position,
    spanStart: Math.min(edges.spanStarts[edgeIndex], movingSpanStart),
    spanEnd: Math.max(edges.spanEnds[edgeIndex], movingSpanEnd),
  }
}

export type MoveSnapResult = {
  offsetX: number
  offsetY: number
  guides: SnapGuide[]
}

/**
 * Snaps a box being moved. Both edges on an axis are candidates; the closer one wins, so
 * a box can align by its left or its right edge depending on which is nearer.
 */
export function solveMoveSnap(
  rect: Rect,
  candidates: SnapCandidates,
  toleranceInWorldUnits: number,
): MoveSnapResult {
  const guides: SnapGuide[] = []
  const right = rect.x + rect.width
  const bottom = rect.y + rect.height

  const nearestLeft = findNearestEdge(candidates.verticalEdges, rect.x, toleranceInWorldUnits)
  const nearestRight = findNearestEdge(candidates.verticalEdges, right, toleranceInWorldUnits)
  const nearestTop = findNearestEdge(candidates.horizontalEdges, rect.y, toleranceInWorldUnits)
  const nearestBottom = findNearestEdge(candidates.horizontalEdges, bottom, toleranceInWorldUnits)

  let offsetX = 0
  if (nearestLeft && (!nearestRight || nearestLeft.distance <= nearestRight.distance)) {
    offsetX = nearestLeft.position - rect.x
    guides.push(
      createGuide('vertical', candidates.verticalEdges, nearestLeft.index, nearestLeft.position, rect.y, bottom),
    )
  } else if (nearestRight) {
    offsetX = nearestRight.position - right
    guides.push(
      createGuide('vertical', candidates.verticalEdges, nearestRight.index, nearestRight.position, rect.y, bottom),
    )
  }

  let offsetY = 0
  if (nearestTop && (!nearestBottom || nearestTop.distance <= nearestBottom.distance)) {
    offsetY = nearestTop.position - rect.y
    guides.push(
      createGuide('horizontal', candidates.horizontalEdges, nearestTop.index, nearestTop.position, rect.x, right),
    )
  } else if (nearestBottom) {
    offsetY = nearestBottom.position - bottom
    guides.push(
      createGuide('horizontal', candidates.horizontalEdges, nearestBottom.index, nearestBottom.position, rect.x, right),
    )
  }

  return { offsetX, offsetY, guides }
}

export type EdgeSnapSelection = {
  snapsLeftEdge: boolean
  snapsRightEdge: boolean
  snapsTopEdge: boolean
  snapsBottomEdge: boolean
}

export type EdgeSnapResult = {
  left: number
  top: number
  right: number
  bottom: number
  guides: SnapGuide[]
}

/** Snaps only the edges a resize handle controls, leaving the others untouched. */
export function solveEdgeSnap(
  left: number,
  top: number,
  right: number,
  bottom: number,
  selection: EdgeSnapSelection,
  candidates: SnapCandidates,
  toleranceInWorldUnits: number,
): EdgeSnapResult {
  const guides: SnapGuide[] = []
  const result: EdgeSnapResult = { left, top, right, bottom, guides }

  if (selection.snapsLeftEdge) {
    const nearest = findNearestEdge(candidates.verticalEdges, left, toleranceInWorldUnits)
    if (nearest) {
      result.left = nearest.position
      guides.push(createGuide('vertical', candidates.verticalEdges, nearest.index, nearest.position, top, bottom))
    }
  }
  if (selection.snapsRightEdge) {
    const nearest = findNearestEdge(candidates.verticalEdges, right, toleranceInWorldUnits)
    if (nearest) {
      result.right = nearest.position
      guides.push(createGuide('vertical', candidates.verticalEdges, nearest.index, nearest.position, top, bottom))
    }
  }
  if (selection.snapsTopEdge) {
    const nearest = findNearestEdge(candidates.horizontalEdges, top, toleranceInWorldUnits)
    if (nearest) {
      result.top = nearest.position
      guides.push(
        createGuide('horizontal', candidates.horizontalEdges, nearest.index, nearest.position, left, right),
      )
    }
  }
  if (selection.snapsBottomEdge) {
    const nearest = findNearestEdge(candidates.horizontalEdges, bottom, toleranceInWorldUnits)
    if (nearest) {
      result.bottom = nearest.position
      guides.push(
        createGuide('horizontal', candidates.horizontalEdges, nearest.index, nearest.position, left, right),
      )
    }
  }

  return result
}

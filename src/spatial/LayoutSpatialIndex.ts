import { computeDocumentBounds } from '@/document/pageLayout'
import {
  NODE_FLAG_REMOVED,
  NO_LAYOUT_NODE_ID,
  getNodeArea,
  type LayoutDocument,
  type LayoutNodeId,
  type PageNodeRange,
} from '@/document/layoutTypes'
import type { Rect } from '@/canvas/geometry'
import { QuadTree } from './QuadTree'

export type HitTestOutcome = {
  /** The most specific box under the point, or `NO_LAYOUT_NODE_ID`. */
  nodeId: LayoutNodeId
  /** Every box under the point, most specific first. */
  candidateNodeIds: LayoutNodeId[]
}

/**
 * The document's spatial index: a quadtree over world-space node rectangles, used to
 * answer "what did the reviewer click on?" in `O(log N)`.
 *
 * Overlap is the norm in a layout tree — a line sits inside a paragraph, a key label
 * inside a key-value pair — so a point query returns a candidate set and this resolves
 * it by smallest area, which is what "most specific box" means geometrically.
 */
export class LayoutSpatialIndex {
  private readonly tree: QuadTree
  private readonly candidateScratch: number[] = []

  constructor(pageCount: number) {
    const documentBounds = computeDocumentBounds(pageCount)
    this.tree = new QuadTree({
      x: documentBounds.x - 64,
      y: documentBounds.y - 64,
      width: documentBounds.width + 128,
      height: documentBounds.height + 128,
    })
  }

  get size(): number {
    return this.tree.size
  }

  clear(): void {
    this.tree.clear()
  }

  insertPageRange(document: LayoutDocument, range: PageNodeRange): void {
    const { bounds } = document.geometry
    const lastNodeId = range.firstNodeId + range.nodeCount

    for (let nodeId = range.firstNodeId; nodeId < lastNodeId; nodeId += 1) {
      const offset = nodeId * 4
      this.tree.insert(
        nodeId,
        bounds[offset],
        bounds[offset + 1],
        bounds[offset + 2],
        bounds[offset + 3],
      )
    }
  }

  insertNode(document: LayoutDocument, nodeId: LayoutNodeId): void {
    const offset = nodeId * 4
    const { bounds } = document.geometry
    this.tree.insert(nodeId, bounds[offset], bounds[offset + 1], bounds[offset + 2], bounds[offset + 3])
  }

  /** Re-indexes a node after an edit. The previous rectangle locates it in `O(log N)`. */
  updateNode(document: LayoutDocument, nodeId: LayoutNodeId, previousBounds: Rect): void {
    const offset = nodeId * 4
    const { bounds } = document.geometry
    this.tree.update(
      nodeId,
      previousBounds,
      bounds[offset],
      bounds[offset + 1],
      bounds[offset + 2],
      bounds[offset + 3],
    )
  }

  removeNode(nodeId: LayoutNodeId, bounds: Rect): void {
    this.tree.remove(nodeId, bounds.x, bounds.y, bounds.width, bounds.height)
  }

  hitTest(document: LayoutDocument, worldX: number, worldY: number): HitTestOutcome {
    const candidates = this.candidateScratch
    candidates.length = 0
    this.tree.queryPoint(worldX, worldY, candidates)

    const visibleCandidates = candidates.filter(
      (nodeId) => (document.geometry.flags[nodeId] & NODE_FLAG_REMOVED) === 0,
    )
    visibleCandidates.sort(
      (left, right) => getNodeArea(document.geometry, left) - getNodeArea(document.geometry, right),
    )

    return {
      nodeId: visibleCandidates[0] ?? NO_LAYOUT_NODE_ID,
      candidateNodeIds: visibleCandidates,
    }
  }

  queryRect(rect: Rect, results: number[]): number[] {
    return this.tree.queryRect(rect, results)
  }
}

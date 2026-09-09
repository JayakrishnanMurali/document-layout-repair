import type { Point } from '@/canvas/geometry'
import {
  CONNECTOR_RADIUS_IN_SCREEN_PIXELS,
  getConnectorWorldPosition,
} from '@/canvas/layers/ReadingOrderLayer'
import { NO_LAYOUT_NODE_ID, readNodeBounds, type LayoutNodeId } from '@/document/layoutTypes'
import { findBlockNodeAtWorldPoint } from '@/document/nodeQueries'
import { getPageIndexAtWorldPoint, type DocumentPageLayout } from '@/document/pageLayout'
import { moveNodeAfter } from '@/document/readingOrder'
import type { LayoutEditor } from '@/state/LayoutEditor'
import type { PointerGestureContext, PointerGestureHandler } from './pointerGestures'

/** Grabbing a connector is forgiving: the ring is small but the target is not. */
const CONNECTOR_GRAB_RADIUS_IN_SCREEN_PIXELS = CONNECTOR_RADIUS_IN_SCREEN_PIXELS + 5

export type ReadingOrderGestureHandlerOptions = {
  editor: LayoutEditor
  getPageLayout: () => DocumentPageLayout
  getIsActive: () => boolean
}

/**
 * Re-links reading order by dragging a block's connector onto another block.
 *
 * Dropping on block B means "B is read immediately after A". Because the order is stored
 * as a sequence, that is a move within a permutation — the numbering that follows is just
 * array position, and a cycle cannot be created at all.
 */
export class ReadingOrderGestureHandler implements PointerGestureHandler {
  readonly name = 'readingOrder'

  private readonly editor: LayoutEditor
  private readonly getPageLayout: () => DocumentPageLayout
  private readonly getIsActive: () => boolean

  private fromNodeId: LayoutNodeId = NO_LAYOUT_NODE_ID
  private fromPageIndex = -1

  constructor(options: ReadingOrderGestureHandlerOptions) {
    this.editor = options.editor
    this.getPageLayout = options.getPageLayout
    this.getIsActive = options.getIsActive
  }

  onPointerDown(_event: PointerEvent, context: PointerGestureContext): boolean {
    if (!this.getIsActive()) {
      return false
    }

    const connectorNodeId = this.findConnectorAtWorldPoint(context)
    if (connectorNodeId === NO_LAYOUT_NODE_ID) {
      return false
    }

    const layoutDocument = this.editor.getDocument()
    if (!layoutDocument) {
      return false
    }

    this.fromNodeId = connectorNodeId
    this.fromPageIndex = layoutDocument.geometry.pageIndexes[connectorNodeId]
    this.editor.selectNode(connectorNodeId, 'replace')
    this.editor.setPendingReadingOrderLink({
      fromNodeId: connectorNodeId,
      pointerWorldX: context.worldPoint.x,
      pointerWorldY: context.worldPoint.y,
      candidateNodeId: NO_LAYOUT_NODE_ID,
    })
    return true
  }

  onPointerMove(_event: PointerEvent, context: PointerGestureContext): void {
    if (this.fromNodeId === NO_LAYOUT_NODE_ID) {
      return
    }

    this.editor.setPendingReadingOrderLink({
      fromNodeId: this.fromNodeId,
      pointerWorldX: context.worldPoint.x,
      pointerWorldY: context.worldPoint.y,
      candidateNodeId: this.resolveCandidate(context.worldPoint),
    })
  }

  onPointerUp(_event: PointerEvent, context: PointerGestureContext): void {
    const fromNodeId = this.fromNodeId
    const candidateNodeId = this.resolveCandidate(context.worldPoint)
    this.reset()

    const layoutDocument = this.editor.getDocument()
    if (!layoutDocument || fromNodeId === NO_LAYOUT_NODE_ID || candidateNodeId === NO_LAYOUT_NODE_ID) {
      return
    }

    const pageIndex = layoutDocument.geometry.pageIndexes[fromNodeId]
    const sequence = layoutDocument.readingOrderByPage[pageIndex]?.nodeIds ?? []
    const move = moveNodeAfter(sequence, candidateNodeId, fromNodeId)
    if (!move) {
      return
    }

    this.editor.commit('Re-link reading order', [
      { kind: 'setReadingOrder', pageIndex, nodeIds: move.nodeIds },
    ])
    this.editor.selectNode(candidateNodeId, 'replace')
  }

  onCancel(): void {
    this.reset()
  }

  getCursor(context: PointerGestureContext): string | null {
    if (!this.getIsActive()) {
      return null
    }
    return this.findConnectorAtWorldPoint(context) === NO_LAYOUT_NODE_ID ? null : 'crosshair'
  }

  private reset(): void {
    this.fromNodeId = NO_LAYOUT_NODE_ID
    this.fromPageIndex = -1
    this.editor.setPendingReadingOrderLink(null)
  }

  /** A drop only counts on a different block of the same page. */
  private resolveCandidate(worldPoint: Point): LayoutNodeId {
    const layoutDocument = this.editor.getDocument()
    if (!layoutDocument || this.fromNodeId === NO_LAYOUT_NODE_ID) {
      return NO_LAYOUT_NODE_ID
    }

    const candidateNodeId = findBlockNodeAtWorldPoint(
      layoutDocument,
      this.getPageLayout(),
      worldPoint,
    )
    if (candidateNodeId === NO_LAYOUT_NODE_ID || candidateNodeId === this.fromNodeId) {
      return NO_LAYOUT_NODE_ID
    }
    if (layoutDocument.geometry.pageIndexes[candidateNodeId] !== this.fromPageIndex) {
      return NO_LAYOUT_NODE_ID
    }

    return candidateNodeId
  }

  private findConnectorAtWorldPoint(context: PointerGestureContext): LayoutNodeId {
    const layoutDocument = this.editor.getDocument()
    if (!layoutDocument) {
      return NO_LAYOUT_NODE_ID
    }

    const pageIndex = getPageIndexAtWorldPoint(this.getPageLayout(), context.worldPoint)
    if (pageIndex < 0) {
      return NO_LAYOUT_NODE_ID
    }

    const toleranceInWorldUnits =
      CONNECTOR_GRAB_RADIUS_IN_SCREEN_PIXELS / context.screenPixelsPerWorldUnit
    const sequence = layoutDocument.readingOrderByPage[pageIndex]?.nodeIds ?? []
    const boundsScratch = { x: 0, y: 0, width: 0, height: 0 }

    let closestNodeId = NO_LAYOUT_NODE_ID
    let closestDistance = Number.POSITIVE_INFINITY

    for (const nodeId of sequence) {
      const connector = getConnectorWorldPosition(
        readNodeBounds(layoutDocument.geometry, nodeId, boundsScratch),
      )
      const distance = Math.hypot(
        connector.x - context.worldPoint.x,
        connector.y - context.worldPoint.y,
      )
      if (distance <= toleranceInWorldUnits && distance < closestDistance) {
        closestNodeId = nodeId
        closestDistance = distance
      }
    }

    return closestNodeId
  }
}

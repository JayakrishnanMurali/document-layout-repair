import { rectContainsPoint, type Point, type Rect } from '@/canvas/geometry'
import type { LayoutDocument, LayoutNodeId } from '@/document/layoutTypes'
import { readNodeBounds } from '@/document/layoutTypes'
import { collectSubtreeNodeIds } from '@/document/nodeQueries'
import { getPageBounds, type DocumentPageLayout } from '@/document/pageLayout'
import type { LayoutEditor } from '@/state/LayoutEditor'
import type { LayoutMutation } from '@/state/history/layoutMutations'
import {
  clampRectToBounds,
  findHandleAtWorldPoint,
  getHandleCursor,
  getResizeEdges,
  resizeRectByEdges,
  type BoxHandleId,
} from './boxHandles'
import type { PointerGestureContext, PointerGestureHandler } from './pointerGestures'
import {
  SNAP_TOLERANCE_IN_SCREEN_PIXELS,
  collectSnapCandidates,
  solveEdgeSnap,
  solveMoveSnap,
  type SnapCandidates,
} from './snapping'

type MoveGesture = {
  kind: 'move'
  pressWorldPoint: Point
  nodeIds: LayoutNodeId[]
  originalBounds: Rect[]
  /** Snapping follows the primary box; the rest of the selection moves by the same offset. */
  primaryOriginalBounds: Rect
  pageBounds: Rect
  snapCandidates: SnapCandidates
}

type ResizeGesture = {
  kind: 'resize'
  handleId: BoxHandleId
  nodeId: LayoutNodeId
  originalBounds: Rect
  pressWorldPoint: Point
  pageBounds: Rect
  snapCandidates: SnapCandidates
}

type ActiveGesture = MoveGesture | ResizeGesture

export type BoxEditGestureHandlerOptions = {
  editor: LayoutEditor
  getPageLayout: () => DocumentPageLayout
}

/**
 * Moves and resizes the selected boxes.
 *
 * A gesture snapshots the original rectangles and the page's snap edges once on press,
 * so each pointer move is two binary searches and a handful of writes into the geometry
 * buffers — no allocation, no re-cull, no React.
 */
export class BoxEditGestureHandler implements PointerGestureHandler {
  readonly name = 'boxEdit'

  private readonly editor: LayoutEditor
  private readonly getPageLayout: () => DocumentPageLayout
  private activeGesture: ActiveGesture | null = null

  constructor(options: BoxEditGestureHandlerOptions) {
    this.editor = options.editor
    this.getPageLayout = options.getPageLayout
  }

  onPointerDown(event: PointerEvent, context: PointerGestureContext): boolean {
    if (event.shiftKey) {
      return false
    }

    const layoutDocument = this.editor.getDocument()
    const primaryNodeId = this.editor.primarySelectedNodeId
    if (!layoutDocument || primaryNodeId < 0) {
      return false
    }

    const primaryBounds = this.editor.getNodeBounds(primaryNodeId)
    if (!primaryBounds) {
      return false
    }

    const handleId = findHandleAtWorldPoint(
      primaryBounds,
      context.worldPoint,
      context.screenPixelsPerWorldUnit,
    )
    if (handleId) {
      this.beginResize(layoutDocument, primaryNodeId, primaryBounds, handleId, context)
      return true
    }

    const nodeIdUnderPointer = this.editor.selectedNodeIds.find((nodeId) => {
      const bounds = this.editor.getNodeBounds(nodeId)
      return bounds !== null && rectContainsPoint(bounds, context.worldPoint)
    })
    if (nodeIdUnderPointer === undefined) {
      return false
    }

    this.beginMove(layoutDocument, context)
    return true
  }

  onPointerMove(_event: PointerEvent, context: PointerGestureContext): void {
    const gesture = this.activeGesture
    if (!gesture) {
      return
    }

    const toleranceInWorldUnits =
      SNAP_TOLERANCE_IN_SCREEN_PIXELS / context.screenPixelsPerWorldUnit

    if (gesture.kind === 'move') {
      this.updateMove(gesture, context, toleranceInWorldUnits)
    } else {
      this.updateResize(gesture, context, toleranceInWorldUnits)
    }
  }

  onPointerUp(): void {
    if (!this.activeGesture) {
      return
    }
    this.activeGesture = null
    this.editor.commitGesture()
  }

  onCancel(): void {
    if (!this.activeGesture) {
      return
    }
    this.activeGesture = null
    this.editor.abortGesture()
  }

  getCursor(context: PointerGestureContext): string | null {
    const primaryNodeId = this.editor.primarySelectedNodeId
    if (primaryNodeId < 0) {
      return null
    }

    const bounds = this.editor.getNodeBounds(primaryNodeId)
    if (!bounds) {
      return null
    }

    const handleId = findHandleAtWorldPoint(
      bounds,
      context.worldPoint,
      context.screenPixelsPerWorldUnit,
    )
    if (handleId) {
      return getHandleCursor(handleId)
    }

    return rectContainsPoint(bounds, context.worldPoint) ? 'move' : null
  }

  private beginMove(layoutDocument: LayoutDocument, context: PointerGestureContext): void {
    const movedNodeIds = [
      ...collectSubtreeNodeIds(layoutDocument, this.editor.selectedNodeIds, new Set<LayoutNodeId>()),
    ]
    const pageLayout = this.getPageLayout()
    const primaryNodeId = this.editor.primarySelectedNodeId
    const primaryPageIndex = layoutDocument.geometry.pageIndexes[primaryNodeId]

    this.activeGesture = {
      kind: 'move',
      pressWorldPoint: { ...context.worldPoint },
      nodeIds: movedNodeIds,
      originalBounds: movedNodeIds.map((nodeId) => ({
        ...readNodeBounds(layoutDocument.geometry, nodeId, { x: 0, y: 0, width: 0, height: 0 }),
      })),
      primaryOriginalBounds: {
        ...readNodeBounds(layoutDocument.geometry, primaryNodeId, {
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        }),
      },
      pageBounds: getPageBounds(pageLayout, primaryPageIndex),
      snapCandidates: collectSnapCandidates(
        layoutDocument,
        primaryPageIndex,
        new Set(movedNodeIds),
      ),
    }

    this.editor.beginGesture(
      this.editor.selectedNodeIds.length > 1 ? 'Move selection' : 'Move box',
    )
  }

  private beginResize(
    layoutDocument: LayoutDocument,
    nodeId: LayoutNodeId,
    bounds: Rect,
    handleId: BoxHandleId,
    context: PointerGestureContext,
  ): void {
    const pageLayout = this.getPageLayout()
    const pageIndex = layoutDocument.geometry.pageIndexes[nodeId]

    this.activeGesture = {
      kind: 'resize',
      handleId,
      nodeId,
      originalBounds: { ...bounds },
      pressWorldPoint: { ...context.worldPoint },
      pageBounds: getPageBounds(pageLayout, pageIndex),
      snapCandidates: collectSnapCandidates(layoutDocument, pageIndex, new Set([nodeId])),
    }

    this.editor.setActiveHandleId(handleId)
    this.editor.beginGesture('Resize box')
  }

  private updateMove(
    gesture: MoveGesture,
    context: PointerGestureContext,
    toleranceInWorldUnits: number,
  ): void {
    const rawOffsetX = context.worldPoint.x - gesture.pressWorldPoint.x
    const rawOffsetY = context.worldPoint.y - gesture.pressWorldPoint.y

    const primaryOriginalBounds = gesture.primaryOriginalBounds
    const draggedPrimaryBounds: Rect = {
      x: primaryOriginalBounds.x + rawOffsetX,
      y: primaryOriginalBounds.y + rawOffsetY,
      width: primaryOriginalBounds.width,
      height: primaryOriginalBounds.height,
    }

    const snap = solveMoveSnap(draggedPrimaryBounds, gesture.snapCandidates, toleranceInWorldUnits)
    const offsetX = rawOffsetX + snap.offsetX
    const offsetY = rawOffsetY + snap.offsetY

    const mutations: LayoutMutation[] = gesture.nodeIds.map((nodeId, index) => {
      const original = gesture.originalBounds[index]
      return {
        kind: 'setNodeBounds',
        nodeId,
        bounds: clampRectToBounds(
          { x: original.x + offsetX, y: original.y + offsetY, width: original.width, height: original.height },
          gesture.pageBounds,
        ),
      }
    })

    this.editor.setSnapGuides(snap.guides)
    this.editor.applyInGesture(mutations)
  }

  private updateResize(
    gesture: ResizeGesture,
    context: PointerGestureContext,
    toleranceInWorldUnits: number,
  ): void {
    const edges = getResizeEdges(gesture.handleId)
    const original = gesture.originalBounds
    const offsetX = context.worldPoint.x - gesture.pressWorldPoint.x
    const offsetY = context.worldPoint.y - gesture.pressWorldPoint.y

    const snapped = solveEdgeSnap(
      original.x + offsetX,
      original.y + offsetY,
      original.x + original.width + offsetX,
      original.y + original.height + offsetY,
      {
        snapsLeftEdge: edges.movesLeftEdge,
        snapsRightEdge: edges.movesRightEdge,
        snapsTopEdge: edges.movesTopEdge,
        snapsBottomEdge: edges.movesBottomEdge,
      },
      gesture.snapCandidates,
      toleranceInWorldUnits,
    )

    const resized = resizeRectByEdges(
      original,
      edges,
      snapped.left,
      snapped.top,
      snapped.right,
      snapped.bottom,
    )

    this.editor.setSnapGuides(snapped.guides)
    this.editor.applyInGesture([
      {
        kind: 'setNodeBounds',
        nodeId: gesture.nodeId,
        bounds: clampRectToBounds(resized, gesture.pageBounds),
      },
    ])
  }
}

import type { Point } from '@/canvas/geometry'
import type { LayoutDocument, TableMesh } from '@/document/layoutTypes'
import { getPageIndexAtWorldPoint, type DocumentPageLayout } from '@/document/pageLayout'
import {
  computeMeshDividerOcclusion,
  findDividerAtWorldPoint,
  type DividerReference,
} from '@/document/tableMesh'
import type { LayoutEditor } from '@/state/LayoutEditor'
import { applyDividerDrag } from '@/state/tableMeshCommands'
import type { PointerGestureContext, PointerGestureHandler } from './pointerGestures'

/** Grab tolerance for a divider, in screen pixels, so it is aimable at any zoom. */
const DIVIDER_GRAB_TOLERANCE_IN_SCREEN_PIXELS = 5

export type HighlightedDivider = DividerReference & { tableNodeId: number }

export type TableMeshGestureHandlerOptions = {
  editor: LayoutEditor
  getPageLayout: () => DocumentPageLayout
  getIsActive: () => boolean
  onHighlightedDividerChanged: (divider: HighlightedDivider | null) => void
}

/**
 * Drags a table's row and column dividers.
 *
 * The whole drag is one gesture, so every intermediate position repaints but only the
 * final grid enters history — and because cell rectangles are derived from the dividers,
 * every affected cell is recalculated on the way.
 */
export class TableMeshGestureHandler implements PointerGestureHandler {
  readonly name = 'tableMesh'

  private readonly editor: LayoutEditor
  private readonly getPageLayout: () => DocumentPageLayout
  private readonly getIsActive: () => boolean
  private readonly onHighlightedDividerChanged: (divider: HighlightedDivider | null) => void

  private draggedMesh: TableMesh | null = null
  private draggedDivider: DividerReference | null = null

  constructor(options: TableMeshGestureHandlerOptions) {
    this.editor = options.editor
    this.getPageLayout = options.getPageLayout
    this.getIsActive = options.getIsActive
    this.onHighlightedDividerChanged = options.onHighlightedDividerChanged
  }

  onPointerDown(_event: PointerEvent, context: PointerGestureContext): boolean {
    if (!this.getIsActive()) {
      return false
    }

    const hit = this.findDivider(context)
    if (!hit) {
      return false
    }

    this.draggedMesh = hit.mesh
    this.draggedDivider = hit.divider
    this.onHighlightedDividerChanged({ ...hit.divider, tableNodeId: hit.mesh.tableNodeId })
    this.editor.selectNode(hit.mesh.tableNodeId, 'replace')
    this.editor.beginGesture(
      hit.divider.axis === 'column' ? 'Move column divider' : 'Move row divider',
    )
    return true
  }

  onPointerMove(_event: PointerEvent, context: PointerGestureContext): void {
    if (!this.draggedMesh || !this.draggedDivider) {
      // Not dragging: keep the divider under the pointer highlighted.
      const hit = this.getIsActive() ? this.findDivider(context) : null
      this.onHighlightedDividerChanged(
        hit ? { ...hit.divider, tableNodeId: hit.mesh.tableNodeId } : null,
      )
      return
    }

    applyDividerDrag(
      this.editor,
      this.draggedMesh,
      this.draggedDivider,
      this.draggedDivider.axis === 'column' ? context.worldPoint.x : context.worldPoint.y,
    )
  }

  onPointerUp(_event: PointerEvent, context: PointerGestureContext): void {
    if (!this.draggedMesh) {
      return
    }
    this.draggedMesh = null
    this.draggedDivider = null
    this.editor.commitGesture()

    // Re-derive the highlight from where the pointer actually ended up, so it does not
    // stay lit on a divider the pointer has already left.
    const hit = this.getIsActive() ? this.findDivider(context) : null
    this.onHighlightedDividerChanged(
      hit ? { ...hit.divider, tableNodeId: hit.mesh.tableNodeId } : null,
    )
  }

  onCancel(): void {
    if (!this.draggedMesh) {
      return
    }
    this.draggedMesh = null
    this.draggedDivider = null
    this.onHighlightedDividerChanged(null)
    this.editor.abortGesture()
  }

  getCursor(context: PointerGestureContext): string | null {
    if (!this.getIsActive()) {
      return null
    }

    const hit = this.findDivider(context)
    if (!hit) {
      return null
    }
    return hit.divider.axis === 'column' ? 'col-resize' : 'row-resize'
  }

  private findDivider(
    context: PointerGestureContext,
  ): { mesh: TableMesh; divider: DividerReference } | null {
    const layoutDocument = this.editor.getDocument()
    if (!layoutDocument) {
      return null
    }

    const pageIndex = getPageIndexAtWorldPoint(this.getPageLayout(), context.worldPoint)
    if (pageIndex < 0) {
      return null
    }

    const toleranceInWorldUnits =
      DIVIDER_GRAB_TOLERANCE_IN_SCREEN_PIXELS / context.screenPixelsPerWorldUnit

    return findMeshDivider(layoutDocument, pageIndex, context.worldPoint, toleranceInWorldUnits)
  }
}

function findMeshDivider(
  layoutDocument: LayoutDocument,
  pageIndex: number,
  worldPoint: Point,
  toleranceInWorldUnits: number,
): { mesh: TableMesh; divider: DividerReference } | null {
  for (const mesh of layoutDocument.tableMeshesByPage[pageIndex] ?? []) {
    const divider = findDividerAtWorldPoint(
      mesh,
      worldPoint,
      toleranceInWorldUnits,
      computeMeshDividerOcclusion(layoutDocument, mesh),
    )
    if (divider) {
      return { mesh, divider }
    }
  }
  return null
}

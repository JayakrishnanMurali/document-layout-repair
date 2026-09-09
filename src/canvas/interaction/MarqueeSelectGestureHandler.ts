import type { Point, Rect } from '@/canvas/geometry'
import { collectNodesInWorldRect } from '@/document/nodeQueries'
import type { DocumentPageLayout } from '@/document/pageLayout'
import type { LayoutEditor } from '@/state/LayoutEditor'
import type { PointerGestureContext, PointerGestureHandler } from './pointerGestures'

/** Below this drag distance the gesture is treated as a shift-click, not a marquee. */
const MARQUEE_MINIMUM_DRAG_IN_SCREEN_PIXELS = 4

export type MarqueeSelectGestureHandlerOptions = {
  editor: LayoutEditor
  getPageLayout: () => DocumentPageLayout
  /** Shift-click with no drag: toggle whatever is under the pointer. */
  onToggleAtWorldPoint: (worldPoint: Point) => void
}

/**
 * Shift-drag rubber-band selection.
 *
 * Shift is what separates it from panning, which owns the plain drag on empty canvas.
 * Boxes must be fully enclosed to be picked up, so a marquee across a paragraph selects
 * its lines without also grabbing the page-wide blocks it happens to cross.
 *
 * A marquee replaces the selection, which is what a fresh sweep is expected to do; hold
 * Cmd/Ctrl as well to add to what is already selected. Shift-clicking without dragging
 * toggles the single box under the pointer.
 */
export class MarqueeSelectGestureHandler implements PointerGestureHandler {
  readonly name = 'marqueeSelect'

  private readonly editor: LayoutEditor
  private readonly getPageLayout: () => DocumentPageLayout
  private readonly onToggleAtWorldPoint: (worldPoint: Point) => void

  private anchorWorldPoint: Point | null = null
  private anchorScreenPoint: Point | null = null
  /** Selection to restore on cancel. */
  private selectionBeforeGesture: number[] = []
  /** Selection the marquee builds on: the previous one only when adding. */
  private retainedSelection: number[] = []

  constructor(options: MarqueeSelectGestureHandlerOptions) {
    this.editor = options.editor
    this.getPageLayout = options.getPageLayout
    this.onToggleAtWorldPoint = options.onToggleAtWorldPoint
  }

  onPointerDown(event: PointerEvent, context: PointerGestureContext): boolean {
    if (!event.shiftKey || !this.editor.getDocument()) {
      return false
    }

    this.anchorWorldPoint = { ...context.worldPoint }
    this.anchorScreenPoint = { ...context.screenPoint }
    this.selectionBeforeGesture = [...this.editor.selectedNodeIds]
    this.retainedSelection = event.metaKey || event.ctrlKey ? [...this.editor.selectedNodeIds] : []
    return true
  }

  onPointerMove(_event: PointerEvent, context: PointerGestureContext): void {
    if (!this.anchorWorldPoint) {
      return
    }

    const marqueeWorldRect = createRectBetween(this.anchorWorldPoint, context.worldPoint)
    this.editor.setMarqueeWorldRect(marqueeWorldRect)

    const layoutDocument = this.editor.getDocument()
    if (!layoutDocument) {
      return
    }

    const enclosedNodeIds = collectNodesInWorldRect(
      layoutDocument,
      this.getPageLayout(),
      marqueeWorldRect,
      'contained',
    )
    this.editor.setSelection([...new Set([...this.retainedSelection, ...enclosedNodeIds])])
  }

  onPointerUp(_event: PointerEvent, context: PointerGestureContext): void {
    const anchorScreenPoint = this.anchorScreenPoint
    const wasClickWithoutDrag =
      anchorScreenPoint !== null &&
      Math.hypot(
        context.screenPoint.x - anchorScreenPoint.x,
        context.screenPoint.y - anchorScreenPoint.y,
      ) < MARQUEE_MINIMUM_DRAG_IN_SCREEN_PIXELS

    this.reset()

    if (wasClickWithoutDrag) {
      // No sweep happened, so leave the existing selection alone and toggle one box.
      this.editor.setSelection(this.selectionBeforeGesture)
      this.onToggleAtWorldPoint(context.worldPoint)
    }
  }

  onCancel(): void {
    this.editor.setSelection(this.selectionBeforeGesture)
    this.reset()
  }

  private reset(): void {
    this.anchorWorldPoint = null
    this.anchorScreenPoint = null
    this.editor.setMarqueeWorldRect(null)
  }
}

function createRectBetween(first: Point, second: Point): Rect {
  return {
    x: Math.min(first.x, second.x),
    y: Math.min(first.y, second.y),
    width: Math.abs(second.x - first.x),
    height: Math.abs(second.y - first.y),
  }
}

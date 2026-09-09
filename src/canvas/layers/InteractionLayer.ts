import type { Rect } from '@/canvas/geometry'
import {
  BOX_HANDLE_IDS,
  HANDLE_SIZE_IN_SCREEN_PIXELS,
  MINIMUM_HANDLE_INTERACTION_SIZE_IN_SCREEN_PIXELS,
  getHandleWorldPosition,
} from '@/canvas/interaction/boxHandles'
import type { InteractionState } from '@/canvas/interaction/interactionTypes'
import { getConnectorWorldPosition } from '@/canvas/layers/ReadingOrderLayer'
import { HOVER_COLOR, SELECTION_COLOR } from '@/canvas/overlay/nodeClassStyles'
import type { CanvasBackingSize, RenderFrame, RenderLayer } from '@/canvas/renderTypes'
import {
  NODE_FLAG_LOW_CONFIDENCE,
  getLayoutNodeClassName,
  readNodeBounds,
  type LayoutDocument,
  type LayoutNodeId,
} from '@/document/layoutTypes'

const SELECTION_STROKE_WIDTH_IN_SCREEN_PIXELS = 2
const HOVER_STROKE_WIDTH_IN_SCREEN_PIXELS = 1.5
const SNAP_GUIDE_COLOR = 'rgba(255, 92, 179, 0.95)'
const SNAP_GUIDE_DASH_IN_SCREEN_PIXELS = [5, 4]
const MARQUEE_STROKE_COLOR = 'rgba(130, 182, 255, 0.9)'
const MARQUEE_FILL_COLOR = 'rgba(76, 154, 255, 0.12)'
const READING_ORDER_LINK_COLOR = 'rgba(34, 211, 238, 0.95)'
const READING_ORDER_CANDIDATE_COLOR = 'rgba(34, 211, 238, 0.95)'
const READING_ORDER_LINK_WIDTH_IN_SCREEN_PIXELS = 2
const LABEL_FONT_SIZE_IN_SCREEN_PIXELS = 11
const LABEL_PADDING_IN_SCREEN_PIXELS = 5
const LABEL_GAP_IN_SCREEN_PIXELS = 6
/** Below this on-screen width a box is too small to hang a label off. */
const MINIMUM_LABEL_WIDTH_IN_SCREEN_PIXELS = 26

function toRgba(color: readonly [number, number, number, number], alpha = color[3] / 255): string {
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`
}

/**
 * Top layer: selection outlines, resize handles, snap guides, marquee and labels.
 *
 * Kept separate from the box overlay so that hovering, dragging a handle or dropping a
 * snap guide repaints only this canvas — the instanced buffer of 10k boxes underneath is
 * untouched.
 *
 * Everything here is measured in device pixels rather than world units, which is what
 * makes a handle exactly 7 CSS pixels and a hairline exactly one device pixel at any
 * zoom or `devicePixelRatio`.
 */
export class InteractionLayer implements RenderLayer {
  readonly name = 'interaction'

  private readonly context: CanvasRenderingContext2D
  private readonly getDocument: () => LayoutDocument | null
  private readonly getInteractionState: () => InteractionState
  private readonly boundsScratch: Rect = { x: 0, y: 0, width: 0, height: 0 }

  private backingSize: CanvasBackingSize | null = null

  constructor(
    canvas: HTMLCanvasElement,
    getDocument: () => LayoutDocument | null,
    getInteractionState: () => InteractionState,
  ) {
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('Could not acquire a 2D context for the interaction layer')
    }
    this.context = context
    this.getDocument = getDocument
    this.getInteractionState = getInteractionState
  }

  resize(backingSize: CanvasBackingSize): void {
    this.backingSize = backingSize
  }

  render(frame: RenderFrame): void {
    if (!this.backingSize) {
      return
    }

    const { context } = this
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, this.backingSize.deviceWidth, this.backingSize.deviceHeight)

    const layoutDocument = this.getDocument()
    if (!layoutDocument) {
      return
    }

    const state = this.getInteractionState()
    const devicePixelsPerWorldUnit = frame.camera.scale * frame.devicePixelRatio

    if (state.hoveredNodeId >= 0 && !state.selectedNodeIds.includes(state.hoveredNodeId)) {
      this.strokeNodeOutline(
        layoutDocument,
        state.hoveredNodeId,
        frame,
        devicePixelsPerWorldUnit,
        toRgba(HOVER_COLOR),
        HOVER_STROKE_WIDTH_IN_SCREEN_PIXELS,
      )
    }

    for (const nodeId of state.selectedNodeIds) {
      this.strokeNodeOutline(
        layoutDocument,
        nodeId,
        frame,
        devicePixelsPerWorldUnit,
        toRgba(SELECTION_COLOR),
        SELECTION_STROKE_WIDTH_IN_SCREEN_PIXELS,
      )
    }

    this.drawSnapGuides(state, frame, devicePixelsPerWorldUnit)
    this.drawMarquee(state, frame, devicePixelsPerWorldUnit)
    this.drawPendingReadingOrderLink(layoutDocument, state, frame, devicePixelsPerWorldUnit)

    const primaryNodeId = state.selectedNodeIds[state.selectedNodeIds.length - 1]
    if (primaryNodeId !== undefined) {
      this.drawHandles(layoutDocument, primaryNodeId, frame, devicePixelsPerWorldUnit)
      this.drawNodeLabel(layoutDocument, primaryNodeId, frame, devicePixelsPerWorldUnit)
    } else if (state.hoveredNodeId >= 0) {
      this.drawNodeLabel(layoutDocument, state.hoveredNodeId, frame, devicePixelsPerWorldUnit)
    }
  }

  dispose(): void {
    // The canvas element is owned and removed by the render engine.
  }

  private toDeviceRect(
    layoutDocument: LayoutDocument,
    nodeId: LayoutNodeId,
    frame: RenderFrame,
    devicePixelsPerWorldUnit: number,
  ): Rect | null {
    if (nodeId < 0 || nodeId >= layoutDocument.geometry.nodeCount) {
      return null
    }

    const worldBounds = readNodeBounds(layoutDocument.geometry, nodeId, this.boundsScratch)
    return {
      x: (worldBounds.x - frame.camera.worldX) * devicePixelsPerWorldUnit,
      y: (worldBounds.y - frame.camera.worldY) * devicePixelsPerWorldUnit,
      width: worldBounds.width * devicePixelsPerWorldUnit,
      height: worldBounds.height * devicePixelsPerWorldUnit,
    }
  }

  private strokeNodeOutline(
    layoutDocument: LayoutDocument,
    nodeId: LayoutNodeId,
    frame: RenderFrame,
    devicePixelsPerWorldUnit: number,
    strokeColor: string,
    strokeWidthInScreenPixels: number,
  ): void {
    const deviceRect = this.toDeviceRect(layoutDocument, nodeId, frame, devicePixelsPerWorldUnit)
    if (!deviceRect) {
      return
    }

    const { context } = this
    const strokeWidth = strokeWidthInScreenPixels * frame.devicePixelRatio
    context.lineWidth = strokeWidth
    context.strokeStyle = strokeColor
    // Half-width inset keeps the stroke fully inside the box and on whole device pixels.
    context.strokeRect(
      Math.round(deviceRect.x) + strokeWidth / 2,
      Math.round(deviceRect.y) + strokeWidth / 2,
      Math.max(1, Math.round(deviceRect.width) - strokeWidth),
      Math.max(1, Math.round(deviceRect.height) - strokeWidth),
    )
  }

  private drawHandles(
    layoutDocument: LayoutDocument,
    nodeId: LayoutNodeId,
    frame: RenderFrame,
    devicePixelsPerWorldUnit: number,
  ): void {
    const deviceRect = this.toDeviceRect(layoutDocument, nodeId, frame, devicePixelsPerWorldUnit)
    if (!deviceRect) {
      return
    }

    // Handles are drawn exactly when they can be grabbed.
    const minimumHandleSize =
      MINIMUM_HANDLE_INTERACTION_SIZE_IN_SCREEN_PIXELS * frame.devicePixelRatio
    if (deviceRect.width < minimumHandleSize || deviceRect.height < minimumHandleSize) {
      return
    }

    const worldBounds = readNodeBounds(layoutDocument.geometry, nodeId, this.boundsScratch)
    const handleSize = HANDLE_SIZE_IN_SCREEN_PIXELS * frame.devicePixelRatio
    const { context } = this
    const state = this.getInteractionState()

    context.lineWidth = Math.max(1, frame.devicePixelRatio)

    for (const handleId of BOX_HANDLE_IDS) {
      const worldPosition = getHandleWorldPosition(worldBounds, handleId)
      const centerX = Math.round((worldPosition.x - frame.camera.worldX) * devicePixelsPerWorldUnit)
      const centerY = Math.round((worldPosition.y - frame.camera.worldY) * devicePixelsPerWorldUnit)
      const isActive = state.activeHandleId === handleId

      context.fillStyle = isActive ? toRgba(SELECTION_COLOR) : '#ffffff'
      context.strokeStyle = toRgba(SELECTION_COLOR)
      context.beginPath()
      context.rect(
        centerX - handleSize / 2,
        centerY - handleSize / 2,
        handleSize,
        handleSize,
      )
      context.fill()
      context.stroke()
    }
  }

  private drawSnapGuides(
    state: InteractionState,
    frame: RenderFrame,
    devicePixelsPerWorldUnit: number,
  ): void {
    if (state.snapGuides.length === 0) {
      return
    }

    const { context } = this
    context.save()
    context.lineWidth = Math.max(1, frame.devicePixelRatio)
    context.strokeStyle = SNAP_GUIDE_COLOR
    context.setLineDash(SNAP_GUIDE_DASH_IN_SCREEN_PIXELS.map((dash) => dash * frame.devicePixelRatio))
    context.beginPath()

    for (const guide of state.snapGuides) {
      if (guide.orientation === 'vertical') {
        // The +0.5 puts a one-pixel line on a pixel centre instead of straddling two.
        const deviceX = Math.round((guide.worldPosition - frame.camera.worldX) * devicePixelsPerWorldUnit) + 0.5
        context.moveTo(deviceX, (guide.spanStart - frame.camera.worldY) * devicePixelsPerWorldUnit)
        context.lineTo(deviceX, (guide.spanEnd - frame.camera.worldY) * devicePixelsPerWorldUnit)
      } else {
        const deviceY = Math.round((guide.worldPosition - frame.camera.worldY) * devicePixelsPerWorldUnit) + 0.5
        context.moveTo((guide.spanStart - frame.camera.worldX) * devicePixelsPerWorldUnit, deviceY)
        context.lineTo((guide.spanEnd - frame.camera.worldX) * devicePixelsPerWorldUnit, deviceY)
      }
    }

    context.stroke()
    context.restore()
  }

  private drawMarquee(
    state: InteractionState,
    frame: RenderFrame,
    devicePixelsPerWorldUnit: number,
  ): void {
    const marquee = state.marqueeWorldRect
    if (!marquee) {
      return
    }

    const { context } = this
    const deviceX = (marquee.x - frame.camera.worldX) * devicePixelsPerWorldUnit
    const deviceY = (marquee.y - frame.camera.worldY) * devicePixelsPerWorldUnit
    const deviceWidth = marquee.width * devicePixelsPerWorldUnit
    const deviceHeight = marquee.height * devicePixelsPerWorldUnit

    context.save()
    context.fillStyle = MARQUEE_FILL_COLOR
    context.fillRect(deviceX, deviceY, deviceWidth, deviceHeight)
    context.lineWidth = Math.max(1, frame.devicePixelRatio)
    context.strokeStyle = MARQUEE_STROKE_COLOR
    context.setLineDash([4 * frame.devicePixelRatio, 3 * frame.devicePixelRatio])
    context.strokeRect(deviceX, deviceY, deviceWidth, deviceHeight)
    context.restore()
  }

  /**
   * The rubber band drawn while a reading-order link is being dragged, plus a highlight
   * on the block that would become the next one in the sequence.
   */
  private drawPendingReadingOrderLink(
    layoutDocument: LayoutDocument,
    state: InteractionState,
    frame: RenderFrame,
    devicePixelsPerWorldUnit: number,
  ): void {
    const link = state.pendingReadingOrderLink
    if (!link) {
      return
    }

    const { context } = this
    const sourceBounds = readNodeBounds(
      layoutDocument.geometry,
      link.fromNodeId,
      this.boundsScratch,
    )
    const connector = getConnectorWorldPosition(sourceBounds)

    const startX = (connector.x - frame.camera.worldX) * devicePixelsPerWorldUnit
    const startY = (connector.y - frame.camera.worldY) * devicePixelsPerWorldUnit
    const endX = (link.pointerWorldX - frame.camera.worldX) * devicePixelsPerWorldUnit
    const endY = (link.pointerWorldY - frame.camera.worldY) * devicePixelsPerWorldUnit

    context.save()
    context.lineWidth = READING_ORDER_LINK_WIDTH_IN_SCREEN_PIXELS * frame.devicePixelRatio
    context.strokeStyle = READING_ORDER_LINK_COLOR
    context.setLineDash([6 * frame.devicePixelRatio, 4 * frame.devicePixelRatio])
    context.beginPath()
    context.moveTo(startX, startY)
    context.lineTo(endX, endY)
    context.stroke()

    context.setLineDash([])
    context.beginPath()
    context.arc(endX, endY, 3.5 * frame.devicePixelRatio, 0, Math.PI * 2)
    context.fillStyle = READING_ORDER_LINK_COLOR
    context.fill()
    context.restore()

    if (link.candidateNodeId >= 0) {
      this.strokeNodeOutline(
        layoutDocument,
        link.candidateNodeId,
        frame,
        devicePixelsPerWorldUnit,
        READING_ORDER_CANDIDATE_COLOR,
        READING_ORDER_LINK_WIDTH_IN_SCREEN_PIXELS + 1,
      )
    }
  }

  private drawNodeLabel(
    layoutDocument: LayoutDocument,
    nodeId: LayoutNodeId,
    frame: RenderFrame,
    devicePixelsPerWorldUnit: number,
  ): void {
    const deviceRect = this.toDeviceRect(layoutDocument, nodeId, frame, devicePixelsPerWorldUnit)
    if (!deviceRect) {
      return
    }

    if (deviceRect.width < MINIMUM_LABEL_WIDTH_IN_SCREEN_PIXELS * frame.devicePixelRatio) {
      return
    }

    const className = getLayoutNodeClassName(layoutDocument.geometry.classIds[nodeId])
    const confidence = layoutDocument.geometry.confidences[nodeId]
    const isLowConfidence =
      (layoutDocument.geometry.flags[nodeId] & NODE_FLAG_LOW_CONFIDENCE) !== 0
    const labelText = `${className} ${(confidence * 100).toFixed(0)}%`

    const { context } = this
    const fontSize = LABEL_FONT_SIZE_IN_SCREEN_PIXELS * frame.devicePixelRatio
    const padding = LABEL_PADDING_IN_SCREEN_PIXELS * frame.devicePixelRatio

    context.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
    context.textBaseline = 'middle'
    context.textAlign = 'left'

    const textWidth = context.measureText(labelText).width
    const chipWidth = textWidth + padding * 2
    const chipHeight = fontSize + padding * 1.6
    const chipX = Math.round(deviceRect.x)
    // Prefer above the box; fall back to inside its top edge when there is no room.
    const preferredY = deviceRect.y - chipHeight - LABEL_GAP_IN_SCREEN_PIXELS * frame.devicePixelRatio
    const chipY = Math.round(preferredY >= 0 ? preferredY : deviceRect.y)

    context.fillStyle = isLowConfidence ? 'rgba(190, 24, 60, 0.94)' : 'rgba(17, 24, 33, 0.92)'
    context.beginPath()
    context.roundRect(chipX, chipY, chipWidth, chipHeight, 3 * frame.devicePixelRatio)
    context.fill()

    context.fillStyle = '#f3f6fa'
    context.fillText(labelText, chipX + padding, chipY + chipHeight / 2)
  }
}

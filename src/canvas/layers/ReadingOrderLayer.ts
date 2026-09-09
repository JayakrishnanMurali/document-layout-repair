import { rectsIntersect, type Point, type Rect } from '@/canvas/geometry'
import type { CanvasBackingSize, RenderFrame, RenderLayer } from '@/canvas/renderTypes'
import { NODE_FLAG_REMOVED, readNodeBounds, type LayoutDocument } from '@/document/layoutTypes'
import { collectVisiblePageIndexes } from '@/document/pageLayout'

const EDGE_COLOR = 'rgba(34, 211, 238, 0.9)'
const EDGE_SHADOW_COLOR = 'rgba(8, 20, 28, 0.55)'
const BADGE_FILL_COLOR = 'rgba(8, 47, 60, 0.94)'
const BADGE_TEXT_COLOR = '#e8fbff'
const CONNECTOR_FILL_COLOR = 'rgba(34, 211, 238, 0.95)'
const CONNECTOR_RING_COLOR = 'rgba(4, 30, 38, 0.8)'

const EDGE_WIDTH_IN_SCREEN_PIXELS = 1.6
const ARROWHEAD_LENGTH_IN_SCREEN_PIXELS = 9
const ARROWHEAD_HALF_ANGLE_IN_RADIANS = 0.42
const EDGE_END_GAP_IN_SCREEN_PIXELS = 3
const BADGE_RADIUS_IN_SCREEN_PIXELS = 9
const BADGE_FONT_SIZE_IN_SCREEN_PIXELS = 10

/** Below this zoom the badges would be unreadable clutter, so only the arrows are drawn. */
const MINIMUM_BADGE_SCALE = 0.22
/** Connector handles only appear once they are big enough to aim at. */
const MINIMUM_CONNECTOR_SCALE = 0.35
export const CONNECTOR_RADIUS_IN_SCREEN_PIXELS = 5

/**
 * Draws the directed reading-order graph: one arrow per consecutive pair of blocks, a
 * sequence badge per block, and the connector handles the reading-order tool drags from.
 *
 * It sits on its own canvas between the box overlay and the interaction chrome, so
 * moving the pointer repaints the chrome without redrawing several hundred arrows.
 */
export class ReadingOrderLayer implements RenderLayer {
  readonly name = 'readingOrder'

  private readonly context: CanvasRenderingContext2D
  private readonly getDocument: () => LayoutDocument | null
  private readonly getIsActive: () => boolean
  private readonly visiblePageIndexes: number[] = []
  private readonly fromBoundsScratch: Rect = { x: 0, y: 0, width: 0, height: 0 }
  private readonly toBoundsScratch: Rect = { x: 0, y: 0, width: 0, height: 0 }

  private backingSize: CanvasBackingSize | null = null
  private drawnEdgeCount = 0

  constructor(
    canvas: HTMLCanvasElement,
    getDocument: () => LayoutDocument | null,
    getIsActive: () => boolean,
  ) {
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('Could not acquire a 2D context for the reading order layer')
    }
    this.context = context
    this.getDocument = getDocument
    this.getIsActive = getIsActive
  }

  get statistics(): { drawnEdgeCount: number } {
    return { drawnEdgeCount: this.drawnEdgeCount }
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
    this.drawnEdgeCount = 0

    const layoutDocument = this.getDocument()
    if (!layoutDocument || !this.getIsActive()) {
      return
    }

    const devicePixelsPerWorldUnit = frame.camera.scale * frame.devicePixelRatio
    const visiblePageIndexes = collectVisiblePageIndexes(
      frame.pageLayout,
      frame.visibleWorldRect,
      this.visiblePageIndexes,
    )

    const toDeviceX = (worldX: number) =>
      (worldX - frame.camera.worldX) * devicePixelsPerWorldUnit
    const toDeviceY = (worldY: number) =>
      (worldY - frame.camera.worldY) * devicePixelsPerWorldUnit

    context.lineWidth = EDGE_WIDTH_IN_SCREEN_PIXELS * frame.devicePixelRatio
    context.lineCap = 'round'
    context.lineJoin = 'round'

    for (const pageIndex of visiblePageIndexes) {
      const sequence = layoutDocument.readingOrderByPage[pageIndex]?.nodeIds ?? []
      if (sequence.length === 0) {
        continue
      }

      this.drawPageEdges(layoutDocument, sequence, frame, toDeviceX, toDeviceY)

      if (frame.camera.scale >= MINIMUM_BADGE_SCALE) {
        this.drawPageBadges(layoutDocument, sequence, frame, toDeviceX, toDeviceY)
      }
      if (frame.camera.scale >= MINIMUM_CONNECTOR_SCALE) {
        this.drawPageConnectors(layoutDocument, sequence, frame, toDeviceX, toDeviceY)
      }
    }

    context.setTransform(1, 0, 0, 1, 0, 0)
  }

  dispose(): void {
    // The canvas element is owned and removed by the render engine.
  }

  private drawPageEdges(
    layoutDocument: LayoutDocument,
    sequence: readonly number[],
    frame: RenderFrame,
    toDeviceX: (worldX: number) => number,
    toDeviceY: (worldY: number) => number,
  ): void {
    const { context } = this
    const gapInWorldUnits =
      EDGE_END_GAP_IN_SCREEN_PIXELS / Math.max(frame.camera.scale, 0.0001)

    for (let index = 0; index + 1 < sequence.length; index += 1) {
      const fromNodeId = sequence[index]
      const toNodeId = sequence[index + 1]
      if (
        (layoutDocument.geometry.flags[fromNodeId] & NODE_FLAG_REMOVED) !== 0 ||
        (layoutDocument.geometry.flags[toNodeId] & NODE_FLAG_REMOVED) !== 0
      ) {
        continue
      }

      const fromBounds = readNodeBounds(layoutDocument.geometry, fromNodeId, this.fromBoundsScratch)
      const toBounds = readNodeBounds(layoutDocument.geometry, toNodeId, this.toBoundsScratch)
      const segment = computeEdgeSegment(fromBounds, toBounds, gapInWorldUnits)
      if (!segment) {
        continue
      }

      if (!rectsIntersect(getSegmentBounds(segment), frame.visibleWorldRect)) {
        continue
      }

      const startX = toDeviceX(segment.from.x)
      const startY = toDeviceY(segment.from.y)
      const endX = toDeviceX(segment.to.x)
      const endY = toDeviceY(segment.to.y)

      // A dark under-stroke keeps the arrow readable over both paper and dark fills.
      context.strokeStyle = EDGE_SHADOW_COLOR
      context.lineWidth = (EDGE_WIDTH_IN_SCREEN_PIXELS + 1.4) * frame.devicePixelRatio
      strokeArrow(context, startX, startY, endX, endY, frame.devicePixelRatio)

      context.strokeStyle = EDGE_COLOR
      context.lineWidth = EDGE_WIDTH_IN_SCREEN_PIXELS * frame.devicePixelRatio
      strokeArrow(context, startX, startY, endX, endY, frame.devicePixelRatio)

      this.drawnEdgeCount += 1
    }
  }

  private drawPageBadges(
    layoutDocument: LayoutDocument,
    sequence: readonly number[],
    frame: RenderFrame,
    toDeviceX: (worldX: number) => number,
    toDeviceY: (worldY: number) => number,
  ): void {
    const { context } = this
    const radius = BADGE_RADIUS_IN_SCREEN_PIXELS * frame.devicePixelRatio
    const fontSize = BADGE_FONT_SIZE_IN_SCREEN_PIXELS * frame.devicePixelRatio

    context.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
    context.textAlign = 'center'
    context.textBaseline = 'middle'

    sequence.forEach((nodeId, index) => {
      if ((layoutDocument.geometry.flags[nodeId] & NODE_FLAG_REMOVED) !== 0) {
        return
      }

      const bounds = readNodeBounds(layoutDocument.geometry, nodeId, this.fromBoundsScratch)
      if (!rectsIntersect(bounds, frame.visibleWorldRect)) {
        return
      }

      // Straddle the corner rather than sitting inside it, so the badge never covers ink.
      const centerX = toDeviceX(bounds.x)
      const centerY = toDeviceY(bounds.y)

      context.beginPath()
      context.arc(centerX, centerY, radius, 0, Math.PI * 2)
      context.fillStyle = BADGE_FILL_COLOR
      context.fill()
      context.lineWidth = Math.max(1, frame.devicePixelRatio)
      context.strokeStyle = EDGE_COLOR
      context.stroke()

      context.fillStyle = BADGE_TEXT_COLOR
      context.fillText(String(index + 1), centerX, centerY + fontSize * 0.06)
    })

    context.textAlign = 'left'
  }

  private drawPageConnectors(
    layoutDocument: LayoutDocument,
    sequence: readonly number[],
    frame: RenderFrame,
    toDeviceX: (worldX: number) => number,
    toDeviceY: (worldY: number) => number,
  ): void {
    const { context } = this
    const radius = CONNECTOR_RADIUS_IN_SCREEN_PIXELS * frame.devicePixelRatio

    for (const nodeId of sequence) {
      if ((layoutDocument.geometry.flags[nodeId] & NODE_FLAG_REMOVED) !== 0) {
        continue
      }

      const bounds = readNodeBounds(layoutDocument.geometry, nodeId, this.fromBoundsScratch)
      if (!rectsIntersect(bounds, frame.visibleWorldRect)) {
        continue
      }

      const connector = getConnectorWorldPosition(bounds)
      context.beginPath()
      context.arc(toDeviceX(connector.x), toDeviceY(connector.y), radius, 0, Math.PI * 2)
      context.fillStyle = CONNECTOR_FILL_COLOR
      context.fill()
      context.lineWidth = Math.max(1, frame.devicePixelRatio)
      context.strokeStyle = CONNECTOR_RING_COLOR
      context.stroke()
    }
  }
}

/** Where the "next block" connector sits on a block: the middle of its right edge. */
export function getConnectorWorldPosition(bounds: Rect): Point {
  return { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 }
}

type EdgeSegment = { from: Point; to: Point }

function getSegmentBounds(segment: EdgeSegment): Rect {
  const minX = Math.min(segment.from.x, segment.to.x)
  const minY = Math.min(segment.from.y, segment.to.y)
  return {
    x: minX,
    y: minY,
    width: Math.abs(segment.to.x - segment.from.x),
    height: Math.abs(segment.to.y - segment.from.y),
  }
}

/**
 * The visible part of an arrow between two blocks: the segment between their centres,
 * trimmed back to each block's boundary so the arrow reads as connecting them rather
 * than crossing them.
 */
export function computeEdgeSegment(
  fromBounds: Rect,
  toBounds: Rect,
  gapInWorldUnits: number,
): EdgeSegment | null {
  const fromCenterX = fromBounds.x + fromBounds.width / 2
  const fromCenterY = fromBounds.y + fromBounds.height / 2
  const toCenterX = toBounds.x + toBounds.width / 2
  const toCenterY = toBounds.y + toBounds.height / 2

  const deltaX = toCenterX - fromCenterX
  const deltaY = toCenterY - fromCenterY
  const distance = Math.hypot(deltaX, deltaY)
  if (distance < 1) {
    return null
  }

  const exitFraction = findRayExitFraction(fromCenterX, fromCenterY, deltaX, deltaY, fromBounds)
  const entryFraction = findRayEntryFraction(fromCenterX, fromCenterY, deltaX, deltaY, toBounds)
  const gapFraction = gapInWorldUnits / distance

  const startFraction = exitFraction + gapFraction
  const endFraction = entryFraction - gapFraction
  if (!Number.isFinite(startFraction) || !Number.isFinite(endFraction)) {
    return null
  }
  // Overlapping or adjacent blocks leave no room for an arrow.
  if (endFraction <= startFraction) {
    return null
  }

  return {
    from: { x: fromCenterX + deltaX * startFraction, y: fromCenterY + deltaY * startFraction },
    to: { x: fromCenterX + deltaX * endFraction, y: fromCenterY + deltaY * endFraction },
  }
}

/** Fraction along the ray at which it leaves a rectangle it starts inside. */
function findRayExitFraction(
  originX: number,
  originY: number,
  deltaX: number,
  deltaY: number,
  rect: Rect,
): number {
  const horizontal =
    deltaX > 0
      ? (rect.x + rect.width - originX) / deltaX
      : deltaX < 0
        ? (rect.x - originX) / deltaX
        : Number.POSITIVE_INFINITY
  const vertical =
    deltaY > 0
      ? (rect.y + rect.height - originY) / deltaY
      : deltaY < 0
        ? (rect.y - originY) / deltaY
        : Number.POSITIVE_INFINITY

  return Math.min(horizontal, vertical)
}

/** Fraction along the ray at which it first enters a rectangle ahead of it. */
function findRayEntryFraction(
  originX: number,
  originY: number,
  deltaX: number,
  deltaY: number,
  rect: Rect,
): number {
  const horizontalNear =
    deltaX === 0
      ? Number.NEGATIVE_INFINITY
      : Math.min((rect.x - originX) / deltaX, (rect.x + rect.width - originX) / deltaX)
  const verticalNear =
    deltaY === 0
      ? Number.NEGATIVE_INFINITY
      : Math.min((rect.y - originY) / deltaY, (rect.y + rect.height - originY) / deltaY)

  return Math.max(horizontalNear, verticalNear)
}

function strokeArrow(
  context: CanvasRenderingContext2D,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  devicePixelRatio: number,
): void {
  context.beginPath()
  context.moveTo(startX, startY)
  context.lineTo(endX, endY)

  const angle = Math.atan2(endY - startY, endX - startX)
  const headLength = ARROWHEAD_LENGTH_IN_SCREEN_PIXELS * devicePixelRatio

  context.moveTo(endX, endY)
  context.lineTo(
    endX - headLength * Math.cos(angle - ARROWHEAD_HALF_ANGLE_IN_RADIANS),
    endY - headLength * Math.sin(angle - ARROWHEAD_HALF_ANGLE_IN_RADIANS),
  )
  context.moveTo(endX, endY)
  context.lineTo(
    endX - headLength * Math.cos(angle + ARROWHEAD_HALF_ANGLE_IN_RADIANS),
    endY - headLength * Math.sin(angle + ARROWHEAD_HALF_ANGLE_IN_RADIANS),
  )
  context.stroke()
}

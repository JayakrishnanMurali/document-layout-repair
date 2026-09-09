import { clamp, type Point, type Rect } from '@/canvas/geometry'

export const BOX_HANDLE_IDS = [
  'topLeft',
  'top',
  'topRight',
  'right',
  'bottomRight',
  'bottom',
  'bottomLeft',
  'left',
] as const

export type BoxHandleId = (typeof BOX_HANDLE_IDS)[number]

/** Drawn size of a handle, in CSS pixels — constant at every zoom level. */
export const HANDLE_SIZE_IN_SCREEN_PIXELS = 7
/** Grab radius around a handle. Slightly larger than the handle, as fingers and mice miss. */
export const HANDLE_GRAB_RADIUS_IN_SCREEN_PIXELS = 6
export const MINIMUM_BOX_SIZE_IN_WORLD_UNITS = 4

/**
 * Below this on-screen size a box has no handles at all.
 *
 * Document layouts are full of boxes a few pixels tall — a line of text at 40% zoom is
 * about 9 pixels. Left ungated, the grab radii of the eight handles cover the whole box
 * and it can never be moved, only resized. Handles appear once there is room for them;
 * until then the box is drag-to-move, and a reviewer zooms in to resize it.
 */
export const MINIMUM_HANDLE_INTERACTION_SIZE_IN_SCREEN_PIXELS = 16

const HANDLE_ANCHORS: Record<BoxHandleId, { horizontal: number; vertical: number }> = {
  topLeft: { horizontal: 0, vertical: 0 },
  top: { horizontal: 0.5, vertical: 0 },
  topRight: { horizontal: 1, vertical: 0 },
  right: { horizontal: 1, vertical: 0.5 },
  bottomRight: { horizontal: 1, vertical: 1 },
  bottom: { horizontal: 0.5, vertical: 1 },
  bottomLeft: { horizontal: 0, vertical: 1 },
  left: { horizontal: 0, vertical: 0.5 },
}

const HANDLE_CURSORS: Record<BoxHandleId, string> = {
  topLeft: 'nwse-resize',
  top: 'ns-resize',
  topRight: 'nesw-resize',
  right: 'ew-resize',
  bottomRight: 'nwse-resize',
  bottom: 'ns-resize',
  bottomLeft: 'nesw-resize',
  left: 'ew-resize',
}

export function getHandleWorldPosition(bounds: Rect, handleId: BoxHandleId): Point {
  const anchor = HANDLE_ANCHORS[handleId]
  return {
    x: bounds.x + bounds.width * anchor.horizontal,
    y: bounds.y + bounds.height * anchor.vertical,
  }
}

export function getHandleCursor(handleId: BoxHandleId): string {
  return HANDLE_CURSORS[handleId]
}

/**
 * Which handle, if any, sits under a world-space point.
 *
 * The tolerance is expressed in screen pixels and converted through the current zoom, so
 * a handle stays equally easy to grab at 10% and at 500%.
 */
export function findHandleAtWorldPoint(
  bounds: Rect,
  worldPoint: Point,
  screenPixelsPerWorldUnit: number,
): BoxHandleId | null {
  const screenWidth = bounds.width * screenPixelsPerWorldUnit
  const screenHeight = bounds.height * screenPixelsPerWorldUnit
  if (
    screenWidth < MINIMUM_HANDLE_INTERACTION_SIZE_IN_SCREEN_PIXELS ||
    screenHeight < MINIMUM_HANDLE_INTERACTION_SIZE_IN_SCREEN_PIXELS
  ) {
    return null
  }

  // Never let the grab radii meet in the middle: a third of the box on each side leaves
  // an interior that always belongs to the move gesture.
  const toleranceInScreenPixels = Math.min(
    HANDLE_GRAB_RADIUS_IN_SCREEN_PIXELS,
    screenWidth / 3,
    screenHeight / 3,
  )
  const toleranceInWorldUnits = toleranceInScreenPixels / screenPixelsPerWorldUnit

  let closestHandleId: BoxHandleId | null = null
  let closestDistance = Number.POSITIVE_INFINITY

  for (const handleId of BOX_HANDLE_IDS) {
    const handlePosition = getHandleWorldPosition(bounds, handleId)
    const distance = Math.max(
      Math.abs(handlePosition.x - worldPoint.x),
      Math.abs(handlePosition.y - worldPoint.y),
    )
    if (distance <= toleranceInWorldUnits && distance < closestDistance) {
      closestHandleId = handleId
      closestDistance = distance
    }
  }

  return closestHandleId
}

export type ResizeEdges = {
  movesLeftEdge: boolean
  movesRightEdge: boolean
  movesTopEdge: boolean
  movesBottomEdge: boolean
}

export function getResizeEdges(handleId: BoxHandleId): ResizeEdges {
  const anchor = HANDLE_ANCHORS[handleId]
  return {
    movesLeftEdge: anchor.horizontal === 0,
    movesRightEdge: anchor.horizontal === 1,
    movesTopEdge: anchor.vertical === 0,
    movesBottomEdge: anchor.vertical === 1,
  }
}

/**
 * Applies a resize to the edges a handle controls.
 *
 * Edges clamp rather than flip: a document box that inverts mid-drag would swap which
 * handle the pointer is holding, which reads as the box jumping away from the cursor.
 */
export function resizeRectByEdges(
  bounds: Rect,
  edges: ResizeEdges,
  nextLeft: number,
  nextTop: number,
  nextRight: number,
  nextBottom: number,
  minimumSize = MINIMUM_BOX_SIZE_IN_WORLD_UNITS,
): Rect {
  const originalRight = bounds.x + bounds.width
  const originalBottom = bounds.y + bounds.height

  let left = edges.movesLeftEdge ? nextLeft : bounds.x
  let right = edges.movesRightEdge ? nextRight : originalRight
  let top = edges.movesTopEdge ? nextTop : bounds.y
  let bottom = edges.movesBottomEdge ? nextBottom : originalBottom

  if (edges.movesLeftEdge) {
    left = Math.min(left, right - minimumSize)
  }
  if (edges.movesRightEdge) {
    right = Math.max(right, left + minimumSize)
  }
  if (edges.movesTopEdge) {
    top = Math.min(top, bottom - minimumSize)
  }
  if (edges.movesBottomEdge) {
    bottom = Math.max(bottom, top + minimumSize)
  }

  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Keeps a box inside its page, so an edit cannot push content off the paper. */
export function clampRectToBounds(rect: Rect, container: Rect): Rect {
  const width = Math.min(rect.width, container.width)
  const height = Math.min(rect.height, container.height)

  return {
    x: clamp(rect.x, container.x, container.x + container.width - width),
    y: clamp(rect.y, container.y, container.y + container.height - height),
    width,
    height,
  }
}

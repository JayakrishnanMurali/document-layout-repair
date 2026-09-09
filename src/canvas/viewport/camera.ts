import { clamp, type Point, type Rect, type Size } from '@/canvas/geometry'

export const MINIMUM_ZOOM_SCALE = 0.1
export const MAXIMUM_ZOOM_SCALE = 5

/**
 * The viewport camera. `worldX`/`worldY` is the world-space point that sits at the
 * top-left CSS pixel of the viewport; `scale` is CSS pixels per world unit.
 *
 * screen = (world - cameraOrigin) * scale
 * world  = screen / scale + cameraOrigin
 */
export type Camera = {
  worldX: number
  worldY: number
  scale: number
}

export function createCamera(worldX = 0, worldY = 0, scale = 1): Camera {
  return { worldX, worldY, scale }
}

export function clampZoomScale(scale: number): number {
  return clamp(scale, MINIMUM_ZOOM_SCALE, MAXIMUM_ZOOM_SCALE)
}

export function worldToScreen(camera: Camera, worldPoint: Point): Point {
  return {
    x: (worldPoint.x - camera.worldX) * camera.scale,
    y: (worldPoint.y - camera.worldY) * camera.scale,
  }
}

export function screenToWorld(camera: Camera, screenPoint: Point): Point {
  return {
    x: screenPoint.x / camera.scale + camera.worldX,
    y: screenPoint.y / camera.scale + camera.worldY,
  }
}

export function worldToScreenRect(camera: Camera, worldRect: Rect): Rect {
  return {
    x: (worldRect.x - camera.worldX) * camera.scale,
    y: (worldRect.y - camera.worldY) * camera.scale,
    width: worldRect.width * camera.scale,
    height: worldRect.height * camera.scale,
  }
}

/** World-space rectangle currently covered by the viewport. */
export function getVisibleWorldRect(camera: Camera, viewportSize: Size): Rect {
  return {
    x: camera.worldX,
    y: camera.worldY,
    width: viewportSize.width / camera.scale,
    height: viewportSize.height / camera.scale,
  }
}

export function panCameraByScreenDelta(camera: Camera, deltaX: number, deltaY: number): Camera {
  return {
    worldX: camera.worldX - deltaX / camera.scale,
    worldY: camera.worldY - deltaY / camera.scale,
    scale: camera.scale,
  }
}

/**
 * Zoom while keeping the world point under `screenAnchor` pinned to that same
 * screen position — the "zoom to cursor" invariant.
 */
export function zoomCameraAtScreenPoint(
  camera: Camera,
  screenAnchor: Point,
  requestedScale: number,
): Camera {
  const nextScale = clampZoomScale(requestedScale)
  const anchorWorld = screenToWorld(camera, screenAnchor)
  return {
    worldX: anchorWorld.x - screenAnchor.x / nextScale,
    worldY: anchorWorld.y - screenAnchor.y / nextScale,
    scale: nextScale,
  }
}

/** Exponential wheel response so zoom feels linear in perceived magnification. */
export function scaleFromWheelDelta(
  currentScale: number,
  wheelDeltaY: number,
  sensitivity: number,
): number {
  return clampZoomScale(currentScale * Math.exp(-wheelDeltaY * sensitivity))
}

export function centerCameraOnWorldPoint(
  camera: Camera,
  worldPoint: Point,
  viewportSize: Size,
): Camera {
  return {
    worldX: worldPoint.x - viewportSize.width / (2 * camera.scale),
    worldY: worldPoint.y - viewportSize.height / (2 * camera.scale),
    scale: camera.scale,
  }
}

export function fitWorldRectInViewport(
  worldRect: Rect,
  viewportSize: Size,
  paddingFraction = 0.08,
): Camera {
  const usableWidth = viewportSize.width * (1 - paddingFraction * 2)
  const usableHeight = viewportSize.height * (1 - paddingFraction * 2)
  const scale = clampZoomScale(
    Math.min(usableWidth / worldRect.width, usableHeight / worldRect.height),
  )
  return {
    worldX: worldRect.x + worldRect.width / 2 - viewportSize.width / (2 * scale),
    worldY: worldRect.y + worldRect.height / 2 - viewportSize.height / (2 * scale),
    scale,
  }
}

/**
 * Applies the world→device-pixel transform to a 2D context, so drawing code can work
 * directly in world units while staying crisp on high-DPI displays.
 */
export function applyWorldTransformToContext(
  context: CanvasRenderingContext2D,
  camera: Camera,
  devicePixelRatio: number,
): void {
  const pixelsPerWorldUnit = camera.scale * devicePixelRatio
  context.setTransform(
    pixelsPerWorldUnit,
    0,
    0,
    pixelsPerWorldUnit,
    -camera.worldX * pixelsPerWorldUnit,
    -camera.worldY * pixelsPerWorldUnit,
  )
}

/**
 * Builds the world→clip-space 3x3 matrix for the WebGL overlay, in the column-major
 * layout a `mat3` uniform expects. Clip Y is flipped so world Y grows downward like
 * every other layer. `devicePixelRatio` is deliberately absent: the GL viewport already
 * covers the whole backing store, so clip space is resolution independent.
 */
export function writeWorldToClipMatrix(
  target: Float32Array,
  camera: Camera,
  viewportSize: Size,
): Float32Array {
  const horizontalScale = (2 * camera.scale) / viewportSize.width
  const verticalScale = (-2 * camera.scale) / viewportSize.height

  target[0] = horizontalScale
  target[1] = 0
  target[2] = 0

  target[3] = 0
  target[4] = verticalScale
  target[5] = 0

  target[6] = -camera.worldX * horizontalScale - 1
  target[7] = -camera.worldY * verticalScale + 1
  target[8] = 1

  return target
}

export function createWorldToClipMatrix(camera: Camera, viewportSize: Size): Float32Array {
  return writeWorldToClipMatrix(new Float32Array(9), camera, viewportSize)
}

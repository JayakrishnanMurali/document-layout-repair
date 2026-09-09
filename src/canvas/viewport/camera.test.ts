import { describe, expect, it } from 'vitest'
import {
  MAXIMUM_ZOOM_SCALE,
  MINIMUM_ZOOM_SCALE,
  createCamera,
  fitWorldRectInViewport,
  getVisibleWorldRect,
  panCameraByScreenDelta,
  scaleFromWheelDelta,
  screenToWorld,
  worldToScreen,
  writeWorldToClipMatrix,
  zoomCameraAtScreenPoint,
} from './camera'

const viewportSize = { width: 1200, height: 800 }

describe('world/screen transforms', () => {
  it('round-trips a point through both directions', () => {
    const camera = createCamera(431.25, -98.5, 1.734)
    const worldPoint = { x: 1893.4, y: 2471.05 }

    const roundTripped = screenToWorld(camera, worldToScreen(camera, worldPoint))

    expect(roundTripped.x).toBeCloseTo(worldPoint.x, 8)
    expect(roundTripped.y).toBeCloseTo(worldPoint.y, 8)
  })

  it('maps the camera origin to the viewport top-left', () => {
    const camera = createCamera(120, 340, 2.5)

    expect(worldToScreen(camera, { x: 120, y: 340 })).toEqual({ x: 0, y: 0 })
  })

  it('reports the visible world rect as the viewport divided by scale', () => {
    const camera = createCamera(50, 60, 0.5)

    expect(getVisibleWorldRect(camera, viewportSize)).toEqual({
      x: 50,
      y: 60,
      width: 2400,
      height: 1600,
    })
  })

  it('pans by screen delta in world units', () => {
    const camera = panCameraByScreenDelta(createCamera(0, 0, 2), 100, -50)

    expect(camera.worldX).toBeCloseTo(-50)
    expect(camera.worldY).toBeCloseTo(25)
    expect(camera.scale).toBe(2)
  })
})

describe('zoom to cursor', () => {
  const anchors = [
    { x: 0, y: 0 },
    { x: 600, y: 400 },
    { x: 1199, y: 799 },
    { x: 37.5, y: 712.25 },
  ]

  it('keeps the world point under the anchor pinned at every scale step', () => {
    for (const anchor of anchors) {
      let camera = createCamera(812.5, 1204.75, 0.35)
      const pinnedWorldPoint = screenToWorld(camera, anchor)

      for (const requestedScale of [0.5, 1, 1.9, 3.25, 4.8, 2.2, 0.4]) {
        camera = zoomCameraAtScreenPoint(camera, anchor, requestedScale)
        const screenPointNow = worldToScreen(camera, pinnedWorldPoint)

        expect(screenPointNow.x).toBeCloseTo(anchor.x, 6)
        expect(screenPointNow.y).toBeCloseTo(anchor.y, 6)
      }
    }
  })

  it('clamps zoom to the supported 10%-500% range', () => {
    const zoomedOut = zoomCameraAtScreenPoint(createCamera(0, 0, 1), { x: 10, y: 10 }, 0.0001)
    const zoomedIn = zoomCameraAtScreenPoint(createCamera(0, 0, 1), { x: 10, y: 10 }, 1000)

    expect(zoomedOut.scale).toBe(MINIMUM_ZOOM_SCALE)
    expect(zoomedIn.scale).toBe(MAXIMUM_ZOOM_SCALE)
  })

  it('still pins the anchor when the requested scale is clamped', () => {
    const camera = createCamera(100, 100, 4.9)
    const anchor = { x: 300, y: 250 }
    const pinnedWorldPoint = screenToWorld(camera, anchor)

    const zoomed = zoomCameraAtScreenPoint(camera, anchor, 99)
    const screenPointNow = worldToScreen(zoomed, pinnedWorldPoint)

    expect(zoomed.scale).toBe(MAXIMUM_ZOOM_SCALE)
    expect(screenPointNow.x).toBeCloseTo(anchor.x, 6)
    expect(screenPointNow.y).toBeCloseTo(anchor.y, 6)
  })
})

describe('wheel response', () => {
  it('magnifies on negative delta and shrinks on positive delta', () => {
    expect(scaleFromWheelDelta(1, -100, 0.002)).toBeGreaterThan(1)
    expect(scaleFromWheelDelta(1, 100, 0.002)).toBeLessThan(1)
  })

  it('is multiplicatively symmetric so a scroll and its reverse cancel out', () => {
    const zoomedIn = scaleFromWheelDelta(1, -120, 0.002)
    const backAgain = scaleFromWheelDelta(zoomedIn, 120, 0.002)

    expect(backAgain).toBeCloseTo(1, 10)
  })
})

describe('fitWorldRectInViewport', () => {
  it('centers the rect and never exceeds the zoom range', () => {
    const worldRect = { x: 1000, y: 2000, width: 1240, height: 1754 }
    const camera = fitWorldRectInViewport(worldRect, viewportSize)

    const rectCenterOnScreen = worldToScreen(camera, {
      x: worldRect.x + worldRect.width / 2,
      y: worldRect.y + worldRect.height / 2,
    })

    expect(rectCenterOnScreen.x).toBeCloseTo(viewportSize.width / 2, 6)
    expect(rectCenterOnScreen.y).toBeCloseTo(viewportSize.height / 2, 6)
    expect(camera.scale).toBeGreaterThanOrEqual(MINIMUM_ZOOM_SCALE)
    expect(camera.scale).toBeLessThanOrEqual(MAXIMUM_ZOOM_SCALE)
  })

  it('fits the constraining axis with padding to spare', () => {
    const wideRect = { x: 0, y: 0, width: 4000, height: 200 }
    const camera = fitWorldRectInViewport(wideRect, viewportSize, 0.1)

    expect(wideRect.width * camera.scale).toBeCloseTo(viewportSize.width * 0.8, 6)
  })
})

describe('world to clip matrix', () => {
  const applyMatrix = (matrix: Float32Array, x: number, y: number) => ({
    x: matrix[0] * x + matrix[3] * y + matrix[6],
    y: matrix[1] * x + matrix[4] * y + matrix[7],
  })

  it('maps the visible world rect corners onto clip space corners', () => {
    const camera = createCamera(240, 980, 0.75)
    const matrix = writeWorldToClipMatrix(new Float32Array(9), camera, viewportSize)
    const visible = getVisibleWorldRect(camera, viewportSize)

    const topLeft = applyMatrix(matrix, visible.x, visible.y)
    const bottomRight = applyMatrix(matrix, visible.x + visible.width, visible.y + visible.height)

    expect(topLeft.x).toBeCloseTo(-1, 5)
    expect(topLeft.y).toBeCloseTo(1, 5)
    expect(bottomRight.x).toBeCloseTo(1, 5)
    expect(bottomRight.y).toBeCloseTo(-1, 5)
  })

  it('agrees with worldToScreen for an arbitrary interior point', () => {
    const camera = createCamera(-320.5, 55.25, 2.4)
    const matrix = writeWorldToClipMatrix(new Float32Array(9), camera, viewportSize)
    const worldPoint = { x: 12.75, y: 301.5 }

    const clip = applyMatrix(matrix, worldPoint.x, worldPoint.y)
    const screen = worldToScreen(camera, worldPoint)

    expect(((clip.x + 1) / 2) * viewportSize.width).toBeCloseTo(screen.x, 3)
    expect(((1 - clip.y) / 2) * viewportSize.height).toBeCloseTo(screen.y, 3)
  })

  it('writes into the provided buffer without allocating a new one', () => {
    const buffer = new Float32Array(9)
    const returned = writeWorldToClipMatrix(buffer, createCamera(0, 0, 1), viewportSize)

    expect(returned).toBe(buffer)
  })
})

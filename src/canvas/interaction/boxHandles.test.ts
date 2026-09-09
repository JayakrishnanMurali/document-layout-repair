import { describe, expect, it } from 'vitest'
import type { Rect } from '@/canvas/geometry'
import {
  BOX_HANDLE_IDS,
  HANDLE_GRAB_RADIUS_IN_SCREEN_PIXELS,
  MINIMUM_BOX_SIZE_IN_WORLD_UNITS,
  clampRectToBounds,
  findHandleAtWorldPoint,
  getHandleWorldPosition,
  getResizeEdges,
  resizeRectByEdges,
} from './boxHandles'

const bounds: Rect = { x: 100, y: 200, width: 400, height: 120 }

describe('findHandleAtWorldPoint', () => {
  it('finds every handle when the pointer is exactly on it', () => {
    for (const handleId of BOX_HANDLE_IDS) {
      const position = getHandleWorldPosition(bounds, handleId)
      expect(findHandleAtWorldPoint(bounds, position, 1)).toBe(handleId)
    }
  })

  it('keeps the grab radius constant in screen pixels across zoom levels', () => {
    const cornerPosition = getHandleWorldPosition(bounds, 'topLeft')

    // Zoom levels where the box is comfortably larger than the handles.
    for (const screenPixelsPerWorldUnit of [0.25, 1, 4]) {
      const toleranceInWorldUnits =
        HANDLE_GRAB_RADIUS_IN_SCREEN_PIXELS / screenPixelsPerWorldUnit
      const justInside = {
        x: cornerPosition.x + toleranceInWorldUnits * 0.9,
        y: cornerPosition.y,
      }
      const justOutside = {
        x: cornerPosition.x + toleranceInWorldUnits * 1.4,
        y: cornerPosition.y,
      }

      expect(findHandleAtWorldPoint(bounds, justInside, screenPixelsPerWorldUnit)).toBe('topLeft')
      expect(findHandleAtWorldPoint(bounds, justOutside, screenPixelsPerWorldUnit)).toBeNull()
    }
  })

  it('prefers the nearest handle when two are within reach', () => {
    const smallBounds: Rect = { x: 0, y: 0, width: 30, height: 30 }
    // Closer to the top-left corner than to the top edge midpoint.
    expect(findHandleAtWorldPoint(smallBounds, { x: 1, y: 0 }, 1)).toBe('topLeft')
    expect(findHandleAtWorldPoint(smallBounds, { x: 15, y: 0 }, 1)).toBe('top')
  })

  it('offers no handles on a box too small to show them, so it stays draggable', () => {
    const lineBounds: Rect = { x: 0, y: 0, width: 300, height: 20 }
    // 20 world units tall at 40% zoom is 8 screen pixels: no room for handles.
    expect(findHandleAtWorldPoint(lineBounds, { x: 0, y: 0 }, 0.4)).toBeNull()
    expect(findHandleAtWorldPoint(lineBounds, { x: 150, y: 10 }, 0.4)).toBeNull()
    // Zoomed in, the same box is 40 pixels tall and its handles come back.
    expect(findHandleAtWorldPoint(lineBounds, { x: 0, y: 0 }, 2)).toBe('topLeft')
  })

  it('never lets handle grab radii cover the interior of a box', () => {
    const smallBounds: Rect = { x: 0, y: 0, width: 24, height: 24 }
    expect(findHandleAtWorldPoint(smallBounds, { x: 12, y: 12 }, 1)).toBeNull()
  })

  it('reports nothing in the middle of the box', () => {
    expect(findHandleAtWorldPoint(bounds, { x: 300, y: 260 }, 1)).toBeNull()
  })
})

describe('resizeRectByEdges', () => {
  it('moves only the edges the handle controls', () => {
    const resized = resizeRectByEdges(bounds, getResizeEdges('right'), 0, 0, 620, 0)

    expect(resized.x).toBe(bounds.x)
    expect(resized.y).toBe(bounds.y)
    expect(resized.height).toBe(bounds.height)
    expect(resized.width).toBe(520)
  })

  it('drags a corner in both axes', () => {
    const resized = resizeRectByEdges(bounds, getResizeEdges('topLeft'), 60, 150, 0, 0)

    expect(resized).toEqual({ x: 60, y: 150, width: 440, height: 170 })
  })

  it('clamps instead of inverting when an edge is dragged past its opposite', () => {
    const resized = resizeRectByEdges(bounds, getResizeEdges('left'), 9_999, 0, 0, 0)

    expect(resized.width).toBe(MINIMUM_BOX_SIZE_IN_WORLD_UNITS)
    expect(resized.x + resized.width).toBeCloseTo(bounds.x + bounds.width, 6)
    expect(resized.width).toBeGreaterThan(0)
  })

  it('clamps a bottom drag above the top edge', () => {
    const resized = resizeRectByEdges(bounds, getResizeEdges('bottom'), 0, 0, 0, -500)

    expect(resized.y).toBe(bounds.y)
    expect(resized.height).toBe(MINIMUM_BOX_SIZE_IN_WORLD_UNITS)
  })
})

describe('clampRectToBounds', () => {
  const page: Rect = { x: 0, y: 0, width: 1240, height: 1754 }

  it('keeps a box inside the page', () => {
    expect(clampRectToBounds({ x: -50, y: -80, width: 200, height: 100 }, page)).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    })
    expect(clampRectToBounds({ x: 1200, y: 1700, width: 200, height: 100 }, page)).toEqual({
      x: 1040,
      y: 1654,
      width: 200,
      height: 100,
    })
  })

  it('shrinks a box that is larger than the page', () => {
    const clamped = clampRectToBounds({ x: -100, y: -100, width: 5000, height: 5000 }, page)
    expect(clamped).toEqual({ x: 0, y: 0, width: page.width, height: page.height })
  })
})

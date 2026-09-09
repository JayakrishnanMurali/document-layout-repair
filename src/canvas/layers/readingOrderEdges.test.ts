import { describe, expect, it } from 'vitest'
import { rectContainsPoint, type Rect } from '@/canvas/geometry'
import { computeEdgeSegment, getConnectorWorldPosition } from './ReadingOrderLayer'

const upperBlock: Rect = { x: 100, y: 100, width: 400, height: 60 }
const lowerBlock: Rect = { x: 100, y: 300, width: 400, height: 60 }
const rightBlock: Rect = { x: 700, y: 100, width: 400, height: 60 }

describe('computeEdgeSegment', () => {
  it('starts on the source boundary and ends on the target boundary', () => {
    const segment = computeEdgeSegment(upperBlock, lowerBlock, 0)

    expect(segment).not.toBeNull()
    expect(segment!.from.y).toBeCloseTo(upperBlock.y + upperBlock.height, 6)
    expect(segment!.to.y).toBeCloseTo(lowerBlock.y, 6)
    expect(segment!.from.x).toBeCloseTo(300, 6)
    expect(segment!.to.x).toBeCloseTo(300, 6)
  })

  it('never crosses into either block', () => {
    for (const [from, to] of [
      [upperBlock, lowerBlock],
      [lowerBlock, upperBlock],
      [upperBlock, rightBlock],
      [rightBlock, upperBlock],
    ] as const) {
      const segment = computeEdgeSegment(from, to, 2)
      expect(segment).not.toBeNull()
      expect(rectContainsPoint(from, segment!.to)).toBe(false)
      expect(rectContainsPoint(to, segment!.from)).toBe(false)
    }
  })

  it('leaves the requested gap at both ends', () => {
    const withoutGap = computeEdgeSegment(upperBlock, lowerBlock, 0)!
    const withGap = computeEdgeSegment(upperBlock, lowerBlock, 10)!

    expect(withGap.from.y - withoutGap.from.y).toBeCloseTo(10, 5)
    expect(withoutGap.to.y - withGap.to.y).toBeCloseTo(10, 5)
  })

  it('points from source to target on a diagonal', () => {
    const segment = computeEdgeSegment(upperBlock, { x: 700, y: 500, width: 200, height: 80 }, 0)!

    expect(segment.to.x).toBeGreaterThan(segment.from.x)
    expect(segment.to.y).toBeGreaterThan(segment.from.y)
  })

  it('returns nothing when the blocks overlap or share a centre', () => {
    expect(computeEdgeSegment(upperBlock, upperBlock, 0)).toBeNull()
    expect(
      computeEdgeSegment(upperBlock, { x: 120, y: 110, width: 380, height: 50 }, 0),
    ).toBeNull()
  })

  it('returns nothing when the gap would consume the whole arrow', () => {
    const nearlyTouching: Rect = { x: 100, y: 168, width: 400, height: 60 }
    expect(computeEdgeSegment(upperBlock, nearlyTouching, 40)).toBeNull()
  })

  it('is symmetric: reversing the pair mirrors the segment', () => {
    const forward = computeEdgeSegment(upperBlock, lowerBlock, 4)!
    const backward = computeEdgeSegment(lowerBlock, upperBlock, 4)!

    expect(backward.from.y).toBeCloseTo(forward.to.y, 5)
    expect(backward.to.y).toBeCloseTo(forward.from.y, 5)
  })
})

describe('getConnectorWorldPosition', () => {
  it('sits at the middle of the block’s right edge', () => {
    expect(getConnectorWorldPosition(upperBlock)).toEqual({ x: 500, y: 130 })
  })
})

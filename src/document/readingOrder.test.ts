import { describe, expect, it } from 'vitest'
import {
  deriveReadingOrderFromGeometry,
  getReadingOrderPosition,
  moveNodeAfter,
  moveNodeToStart,
} from './readingOrder'

const sequence = [10, 11, 12, 13, 14]

describe('moveNodeAfter', () => {
  it('moves a later node up behind an earlier one', () => {
    expect(moveNodeAfter(sequence, 14, 10)?.nodeIds).toEqual([10, 14, 11, 12, 13])
  })

  it('moves an earlier node down behind a later one', () => {
    expect(moveNodeAfter(sequence, 10, 13)?.nodeIds).toEqual([11, 12, 13, 10, 14])
  })

  it('reports where the node landed', () => {
    expect(moveNodeAfter(sequence, 14, 10)?.movedToIndex).toBe(1)
    expect(moveNodeAfter(sequence, 10, 14)?.movedToIndex).toBe(4)
  })

  it('always returns a permutation of the same nodes, so no cycle can appear', () => {
    for (const movedNodeId of sequence) {
      for (const afterNodeId of sequence) {
        const result = moveNodeAfter(sequence, movedNodeId, afterNodeId)
        if (!result) {
          continue
        }
        expect(result.nodeIds).toHaveLength(sequence.length)
        expect([...result.nodeIds].sort((a, b) => a - b)).toEqual([...sequence].sort((a, b) => a - b))
      }
    }
  })

  it('rejects a move that expresses nothing', () => {
    expect(moveNodeAfter(sequence, 12, 12)).toBeNull()
    expect(moveNodeAfter(sequence, 12, 11)).toBeNull()
  })

  it('rejects nodes that are not in this page’s sequence', () => {
    expect(moveNodeAfter(sequence, 99, 10)).toBeNull()
    expect(moveNodeAfter(sequence, 10, 99)).toBeNull()
  })

  it('leaves the original sequence untouched', () => {
    const original = [...sequence]
    moveNodeAfter(sequence, 14, 10)
    expect(sequence).toEqual(original)
  })
})

describe('moveNodeToStart', () => {
  it('promotes a node to first', () => {
    expect(moveNodeToStart(sequence, 13)?.nodeIds).toEqual([13, 10, 11, 12, 14])
  })

  it('does nothing for a node that is already first or absent', () => {
    expect(moveNodeToStart(sequence, 10)).toBeNull()
    expect(moveNodeToStart(sequence, 99)).toBeNull()
  })
})

describe('getReadingOrderPosition', () => {
  it('is one-based, and zero when the node is absent', () => {
    expect(getReadingOrderPosition(sequence, 10)).toBe(1)
    expect(getReadingOrderPosition(sequence, 14)).toBe(5)
    expect(getReadingOrderPosition(sequence, 99)).toBe(0)
  })
})

describe('deriveReadingOrderFromGeometry', () => {
  /** Two columns: nodes 0 and 1 on the left, 2 and 3 on the right. */
  function buildTwoColumnBounds(): Float32Array {
    const bounds = new Float32Array(4 * 4)
    const rects = [
      [96, 100, 400, 60],
      [96, 400, 400, 60],
      [560, 120, 400, 60],
      [560, 300, 400, 60],
    ]
    rects.forEach((rect, index) => bounds.set(rect, index * 4))
    return bounds
  }

  it('reads a two-column page down the left column first', () => {
    expect(deriveReadingOrderFromGeometry([0, 1, 2, 3], buildTwoColumnBounds())).toEqual([
      0, 1, 2, 3,
    ])
    expect(deriveReadingOrderFromGeometry([3, 2, 1, 0], buildTwoColumnBounds())).toEqual([
      0, 1, 2, 3,
    ])
  })

  it('orders overlapping blocks top to bottom', () => {
    const bounds = new Float32Array(3 * 4)
    bounds.set([96, 500, 1000, 40], 0)
    bounds.set([96, 100, 1000, 40], 4)
    bounds.set([96, 300, 1000, 40], 8)

    expect(deriveReadingOrderFromGeometry([0, 1, 2], bounds)).toEqual([1, 2, 0])
  })

  it('leaves the input array untouched', () => {
    const nodeIds = [3, 2, 1, 0]
    deriveReadingOrderFromGeometry(nodeIds, buildTwoColumnBounds())
    expect(nodeIds).toEqual([3, 2, 1, 0])
  })
})

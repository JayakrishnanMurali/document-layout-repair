import { describe, expect, it } from 'vitest'
import type { Rect } from '@/canvas/geometry'
import { LayoutDocumentBuilder } from '@/document/extraction/LayoutDocumentBuilder'
import { buildPageExtractionPayload } from '@/document/extraction/payloadBuilder'
import { getPageNodeCount } from '@/document/layoutTypes'
import { generateSyntheticPageContent } from '@/document/synthetic/pageContentGenerator'
import {
  collectSnapCandidates,
  findNearestEdge,
  solveEdgeSnap,
  solveMoveSnap,
  type SnapCandidateEdges,
  type SnapCandidates,
} from './snapping'

function buildEdges(positions: number[]): SnapCandidateEdges {
  const sorted = [...positions].sort((left, right) => left - right)
  return {
    positions: new Float64Array(sorted),
    spanStarts: new Float64Array(sorted.map(() => 0)),
    spanEnds: new Float64Array(sorted.map(() => 100)),
    count: sorted.length,
  }
}

function buildCandidates(verticals: number[], horizontals: number[]): SnapCandidates {
  return { verticalEdges: buildEdges(verticals), horizontalEdges: buildEdges(horizontals) }
}

describe('findNearestEdge', () => {
  const edges = buildEdges([0, 96, 240, 512, 1144])

  it('finds the closest edge within tolerance', () => {
    expect(findNearestEdge(edges, 98, 6)?.position).toBe(96)
    expect(findNearestEdge(edges, 238.5, 6)?.position).toBe(240)
    expect(findNearestEdge(edges, 1140, 6)?.position).toBe(1144)
  })

  it('returns nothing when the nearest edge is out of tolerance', () => {
    expect(findNearestEdge(edges, 300, 6)).toBeNull()
    expect(findNearestEdge(edges, -50, 6)).toBeNull()
  })

  it('agrees with a linear scan over random probes', () => {
    const positions = Array.from({ length: 400 }, (_unused, index) => Math.sin(index) * 900)
    const searchable = buildEdges(positions)
    const sorted = [...positions].sort((left, right) => left - right)

    for (let probe = -1000; probe <= 1000; probe += 7.3) {
      const tolerance = 5
      const expected = sorted
        .map((position) => ({ position, distance: Math.abs(position - probe) }))
        .filter((candidate) => candidate.distance <= tolerance)
        .sort((left, right) => left.distance - right.distance)[0]

      const actual = findNearestEdge(searchable, probe, tolerance)
      if (!expected) {
        expect(actual).toBeNull()
      } else {
        expect(actual?.distance).toBeCloseTo(expected.distance, 9)
      }
    }
  })

  it('handles an empty candidate set', () => {
    expect(findNearestEdge(buildEdges([]), 10, 6)).toBeNull()
  })
})

describe('solveMoveSnap', () => {
  const candidates = buildCandidates([96, 1144], [200, 800])

  it('snaps by the left edge when it is the nearer one', () => {
    const rect: Rect = { x: 99, y: 500, width: 300, height: 40 }
    const snap = solveMoveSnap(rect, candidates, 6)

    expect(snap.offsetX).toBeCloseTo(-3, 6)
    expect(snap.guides.some((guide) => guide.orientation === 'vertical')).toBe(true)
  })

  it('snaps by the right edge when that one is nearer', () => {
    const rect: Rect = { x: 800, y: 500, width: 342, height: 40 }
    const snap = solveMoveSnap(rect, candidates, 6)

    expect(snap.offsetX).toBeCloseTo(2, 6)
  })

  it('snaps both axes independently', () => {
    const rect: Rect = { x: 94, y: 203, width: 200, height: 40 }
    const snap = solveMoveSnap(rect, candidates, 6)

    expect(snap.offsetX).toBeCloseTo(2, 6)
    expect(snap.offsetY).toBeCloseTo(-3, 6)
    expect(snap.guides).toHaveLength(2)
  })

  it('leaves a box alone when nothing is within tolerance', () => {
    const snap = solveMoveSnap({ x: 500, y: 500, width: 100, height: 30 }, candidates, 6)

    expect(snap.offsetX).toBe(0)
    expect(snap.offsetY).toBe(0)
    expect(snap.guides).toHaveLength(0)
  })

  it('draws a guide that spans both the aligned boxes', () => {
    const verticalEdges: SnapCandidateEdges = {
      positions: new Float64Array([96]),
      spanStarts: new Float64Array([100]),
      spanEnds: new Float64Array([300]),
      count: 1,
    }
    const snap = solveMoveSnap(
      { x: 98, y: 600, width: 100, height: 50 },
      { verticalEdges, horizontalEdges: buildEdges([]) },
      6,
    )

    expect(snap.guides[0].spanStart).toBe(100)
    expect(snap.guides[0].spanEnd).toBe(650)
  })
})

describe('solveEdgeSnap', () => {
  const candidates = buildCandidates([96, 1144], [200, 800])

  it('snaps only the edges the handle drags', () => {
    const result = solveEdgeSnap(
      99,
      500,
      700,
      540,
      { snapsLeftEdge: true, snapsRightEdge: false, snapsTopEdge: false, snapsBottomEdge: false },
      candidates,
      6,
    )

    expect(result.left).toBe(96)
    expect(result.right).toBe(700)
    expect(result.top).toBe(500)
    expect(result.bottom).toBe(540)
    expect(result.guides).toHaveLength(1)
  })

  it('snaps a corner drag on both axes', () => {
    const result = solveEdgeSnap(
      99,
      197,
      700,
      540,
      { snapsLeftEdge: true, snapsRightEdge: false, snapsTopEdge: true, snapsBottomEdge: false },
      candidates,
      6,
    )

    expect(result.left).toBe(96)
    expect(result.top).toBe(200)
    expect(result.guides).toHaveLength(2)
  })
})

describe('collectSnapCandidates', () => {
  const DOCUMENT_SEED = 0x77
  const builder = new LayoutDocumentBuilder(2)
  builder.ingestPage(buildPageExtractionPayload(generateSyntheticPageContent(0, DOCUMENT_SEED), DOCUMENT_SEED))
  builder.ingestPage(buildPageExtractionPayload(generateSyntheticPageContent(1, DOCUMENT_SEED), DOCUMENT_SEED))
  const layoutDocument = builder.getDocument()

  it('produces two sorted vertical and horizontal edges per box on the page', () => {
    const pageNodeCount = getPageNodeCount(layoutDocument, 0)
    const candidates = collectSnapCandidates(layoutDocument, 0, new Set())

    expect(candidates.verticalEdges.count).toBe(pageNodeCount * 2)
    expect(candidates.horizontalEdges.count).toBe(pageNodeCount * 2)

    for (let index = 1; index < candidates.verticalEdges.count; index += 1) {
      expect(candidates.verticalEdges.positions[index]).toBeGreaterThanOrEqual(
        candidates.verticalEdges.positions[index - 1],
      )
    }
  })

  it('excludes the boxes being dragged so a box cannot snap to itself', () => {
    const [range] = layoutDocument.nodeRangesByPage[0]
    const excluded = new Set([range.firstNodeId, range.firstNodeId + 1])
    const candidates = collectSnapCandidates(layoutDocument, 0, excluded)

    expect(candidates.verticalEdges.count).toBe((getPageNodeCount(layoutDocument, 0) - 2) * 2)
  })

  it('only considers the requested page', () => {
    const firstPageCandidates = collectSnapCandidates(layoutDocument, 0, new Set())
    const secondPageCandidates = collectSnapCandidates(layoutDocument, 1, new Set())
    const firstPageMaximumY =
      firstPageCandidates.horizontalEdges.positions[firstPageCandidates.horizontalEdges.count - 1]
    const secondPageMinimumY = secondPageCandidates.horizontalEdges.positions[0]

    expect(secondPageMinimumY).toBeGreaterThan(firstPageMaximumY)
  })

  it('returns an empty set for a page that has not streamed in yet', () => {
    const emptyBuilder = new LayoutDocumentBuilder(3)
    const candidates = collectSnapCandidates(emptyBuilder.getDocument(), 2, new Set())

    expect(candidates.verticalEdges.count).toBe(0)
  })
})

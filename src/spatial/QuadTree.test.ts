import { describe, expect, it } from 'vitest'
import type { Rect } from '@/canvas/geometry'
import { createRandomSource } from '@/document/synthetic/randomSource'
import { QuadTree } from './QuadTree'

const WORLD_BOUNDS: Rect = { x: 0, y: 0, width: 1240, height: 180_000 }

type IndexedRect = Rect & { id: number }

function buildRandomRects(count: number, seed: number): IndexedRect[] {
  const random = createRandomSource(seed)
  const rects: IndexedRect[] = []

  for (let id = 0; id < count; id += 1) {
    const width = random.nextInRange(4, 900)
    const height = random.nextInRange(4, 120)
    rects.push({
      id,
      x: random.nextInRange(0, WORLD_BOUNDS.width - width),
      y: random.nextInRange(0, WORLD_BOUNDS.height - height),
      width,
      height,
    })
  }

  return rects
}

function bruteForcePointHits(rects: IndexedRect[], x: number, y: number): number[] {
  return rects
    .filter((rect) => x >= rect.x && y >= rect.y && x <= rect.x + rect.width && y <= rect.y + rect.height)
    .map((rect) => rect.id)
    .sort((left, right) => left - right)
}

function bruteForceRectHits(rects: IndexedRect[], query: Rect): number[] {
  return rects
    .filter(
      (rect) =>
        rect.x < query.x + query.width &&
        query.x < rect.x + rect.width &&
        rect.y < query.y + query.height &&
        query.y < rect.y + rect.height,
    )
    .map((rect) => rect.id)
    .sort((left, right) => left - right)
}

function buildTree(rects: IndexedRect[]): QuadTree {
  const tree = new QuadTree(WORLD_BOUNDS)
  for (const rect of rects) {
    tree.insertRect(rect.id, rect)
  }
  return tree
}

describe('QuadTree point queries', () => {
  it('matches brute force for every probe across 10,000 rectangles', () => {
    const rects = buildRandomRects(10_000, 0x1234)
    const tree = buildTree(rects)
    const random = createRandomSource(0x99)

    for (let probeIndex = 0; probeIndex < 200; probeIndex += 1) {
      const x = random.nextInRange(0, WORLD_BOUNDS.width)
      const y = random.nextInRange(0, WORLD_BOUNDS.height)
      const results: number[] = []
      tree.queryPoint(x, y, results)

      expect(results.sort((left, right) => left - right)).toEqual(bruteForcePointHits(rects, x, y))
    }
  })

  it('finds rectangles that straddle a quadrant split', () => {
    const tree = new QuadTree({ x: 0, y: 0, width: 100, height: 100 })
    // Enough small items to force subdivision, plus one item covering the centre.
    for (let id = 0; id < 40; id += 1) {
      tree.insert(id, id % 10, Math.floor(id / 10) * 2, 1, 1)
    }
    tree.insert(999, 40, 40, 20, 20)

    const results: number[] = []
    tree.queryPoint(50, 50, results)
    expect(results).toEqual([999])
  })

  it('reports nothing outside the indexed bounds', () => {
    const tree = buildTree(buildRandomRects(500, 7))
    expect(tree.queryPoint(-10, -10, [])).toEqual([])
    expect(tree.queryPoint(99_999, 99_999, [])).toEqual([])
  })
})

describe('QuadTree range queries', () => {
  it('matches brute force for viewport-sized windows', () => {
    const rects = buildRandomRects(10_000, 0xabcd)
    const tree = buildTree(rects)
    const random = createRandomSource(0x555)

    for (let probeIndex = 0; probeIndex < 40; probeIndex += 1) {
      const query: Rect = {
        x: random.nextInRange(-200, WORLD_BOUNDS.width),
        y: random.nextInRange(0, WORLD_BOUNDS.height - 900),
        width: random.nextInRange(50, 1600),
        height: random.nextInRange(50, 900),
      }
      const results: number[] = []
      tree.queryRect(query, results)

      expect(results.sort((left, right) => left - right)).toEqual(bruteForceRectHits(rects, query))
    }
  })
})

describe('QuadTree mutation', () => {
  it('removes items and stops reporting them', () => {
    const rects = buildRandomRects(2_000, 0x4242)
    const tree = buildTree(rects)
    const removedRect = rects[512]

    expect(tree.remove(removedRect.id, removedRect.x, removedRect.y, removedRect.width, removedRect.height)).toBe(true)
    expect(tree.size).toBe(1_999)

    const results: number[] = []
    tree.queryPoint(removedRect.x + removedRect.width / 2, removedRect.y + removedRect.height / 2, results)
    expect(results).not.toContain(removedRect.id)
  })

  it('keeps queries correct after a rectangle moves', () => {
    const rects = buildRandomRects(1_000, 0x8888)
    const tree = buildTree(rects)
    const moved = rects[42]
    const nextRect: Rect = { x: 10, y: 175_000, width: 60, height: 40 }

    tree.update(moved.id, moved, nextRect.x, nextRect.y, nextRect.width, nextRect.height)

    const atOldPosition: number[] = []
    tree.queryPoint(moved.x + moved.width / 2, moved.y + moved.height / 2, atOldPosition)
    expect(atOldPosition).not.toContain(moved.id)

    const atNewPosition: number[] = []
    tree.queryPoint(nextRect.x + 5, nextRect.y + 5, atNewPosition)
    expect(atNewPosition).toContain(moved.id)
    expect(tree.size).toBe(1_000)
  })

  it('drops everything on clear', () => {
    const tree = buildTree(buildRandomRects(300, 1))
    tree.clear()
    expect(tree.size).toBe(0)
    expect(tree.queryRect(WORLD_BOUNDS, [])).toEqual([])
  })
})

describe('QuadTree performance envelope', () => {
  it('answers point queries far inside the 2ms hit-test budget', () => {
    const rects = buildRandomRects(10_000, 0xfeed)
    const tree = buildTree(rects)
    const random = createRandomSource(0x2024)
    const probeCount = 2_000
    const probes: { x: number; y: number }[] = []
    for (let probeIndex = 0; probeIndex < probeCount; probeIndex += 1) {
      probes.push({
        x: random.nextInRange(0, WORLD_BOUNDS.width),
        y: random.nextInRange(0, WORLD_BOUNDS.height),
      })
    }

    const results: number[] = []
    const startedAt = performance.now()
    for (const probe of probes) {
      results.length = 0
      tree.queryPoint(probe.x, probe.y, results)
    }
    const averageMilliseconds = (performance.now() - startedAt) / probeCount

    expect(averageMilliseconds).toBeLessThan(0.2)
  })
})

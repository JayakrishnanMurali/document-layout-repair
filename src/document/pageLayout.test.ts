import { describe, expect, it } from 'vitest'
import { rectsIntersect } from '@/canvas/geometry'
import {
  PAGE_HEIGHT_IN_WORLD_UNITS,
  PAGE_WIDTH_IN_WORLD_UNITS,
  collectVisiblePageIndexes,
  createDocumentPageLayout,
  getDocumentBounds,
  getPageBounds,
  getPageIndexAtWorldPoint,
} from './pageLayout'

describe('createDocumentPageLayout', () => {
  it('keeps short documents in a single continuous column', () => {
    for (const pageCount of [1, 3, 6]) {
      expect(createDocumentPageLayout(pageCount).columnCount).toBe(1)
      expect(createDocumentPageLayout(pageCount).rowCount).toBe(pageCount)
    }
  })

  it('spreads long documents into a grid that stays browsable when zoomed out', () => {
    const layout = createDocumentPageLayout(100)
    expect(layout.columnCount).toBe(10)
    expect(layout.rowCount).toBe(10)

    const bounds = getDocumentBounds(layout)
    expect(bounds.width).toBeLessThan(bounds.height * 1.2)
  })

  it('covers every page even when the last row is partial', () => {
    const layout = createDocumentPageLayout(95)
    expect(layout.columnCount * layout.rowCount).toBeGreaterThanOrEqual(95)
    expect((layout.rowCount - 1) * layout.columnCount).toBeLessThan(95)
  })
})

describe('getPageBounds', () => {
  it('never overlaps two pages', () => {
    const layout = createDocumentPageLayout(24)

    for (let pageIndex = 0; pageIndex < layout.pageCount; pageIndex += 1) {
      for (let otherIndex = pageIndex + 1; otherIndex < layout.pageCount; otherIndex += 1) {
        expect(
          rectsIntersect(getPageBounds(layout, pageIndex), getPageBounds(layout, otherIndex)),
        ).toBe(false)
      }
    }
  })

  it('keeps every page inside the document bounds', () => {
    const layout = createDocumentPageLayout(100)
    const documentBounds = getDocumentBounds(layout)

    for (let pageIndex = 0; pageIndex < layout.pageCount; pageIndex += 1) {
      const pageBounds = getPageBounds(layout, pageIndex)
      expect(pageBounds.x).toBeGreaterThanOrEqual(documentBounds.x)
      expect(pageBounds.y).toBeGreaterThanOrEqual(documentBounds.y)
      expect(pageBounds.x + pageBounds.width).toBeLessThanOrEqual(
        documentBounds.x + documentBounds.width + 0.001,
      )
      expect(pageBounds.y + pageBounds.height).toBeLessThanOrEqual(
        documentBounds.y + documentBounds.height + 0.001,
      )
    }
  })
})

describe('collectVisiblePageIndexes', () => {
  const layout = createDocumentPageLayout(100)

  it('agrees with a brute-force intersection test', () => {
    const viewports = [
      { x: 0, y: 0, width: 1400, height: 900 },
      { x: 2400, y: 3200, width: 5000, height: 3000 },
      { x: -500, y: -500, width: 100_000, height: 100_000 },
      { x: 12_000, y: 17_000, width: 2000, height: 2000 },
    ]

    for (const viewport of viewports) {
      const collected = collectVisiblePageIndexes(layout, viewport, []).sort(
        (left, right) => left - right,
      )
      const expected: number[] = []
      for (let pageIndex = 0; pageIndex < layout.pageCount; pageIndex += 1) {
        if (rectsIntersect(getPageBounds(layout, pageIndex), viewport)) {
          expected.push(pageIndex)
        }
      }
      expect(collected).toEqual(expected)
    }
  })

  it('reuses the results array instead of allocating', () => {
    const results: number[] = []
    const returned = collectVisiblePageIndexes(layout, { x: 0, y: 0, width: 5000, height: 5000 }, results)
    expect(returned).toBe(results)
    collectVisiblePageIndexes(layout, { x: 900_000, y: 900_000, width: 10, height: 10 }, results)
    expect(results).toHaveLength(0)
  })
})

describe('getPageIndexAtWorldPoint', () => {
  const layout = createDocumentPageLayout(100)

  it('resolves points inside a page', () => {
    for (const pageIndex of [0, 1, 9, 10, 55, 99]) {
      const bounds = getPageBounds(layout, pageIndex)
      expect(
        getPageIndexAtWorldPoint(layout, {
          x: bounds.x + PAGE_WIDTH_IN_WORLD_UNITS / 2,
          y: bounds.y + PAGE_HEIGHT_IN_WORLD_UNITS / 2,
        }),
      ).toBe(pageIndex)
    }
  })

  it('reports no page in the gutter or beyond the document', () => {
    const firstPage = getPageBounds(layout, 0)
    expect(
      getPageIndexAtWorldPoint(layout, {
        x: firstPage.x + PAGE_WIDTH_IN_WORLD_UNITS + 20,
        y: firstPage.y + 40,
      }),
    ).toBe(-1)
    expect(getPageIndexAtWorldPoint(layout, { x: -20, y: -20 })).toBe(-1)
    expect(getPageIndexAtWorldPoint(layout, { x: 500_000, y: 500_000 })).toBe(-1)
  })
})

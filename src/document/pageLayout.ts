import type { Rect } from '@/canvas/geometry'

/** A4 at 150 dpi, in world units (1 world unit = 1 CSS pixel at 100% zoom). */
export const PAGE_WIDTH_IN_WORLD_UNITS = 1240
export const PAGE_HEIGHT_IN_WORLD_UNITS = 1754
export const PAGE_GUTTER_IN_WORLD_UNITS = 56
export const PAGE_MARGIN_IN_WORLD_UNITS = 96

const PAGE_STRIDE_IN_WORLD_UNITS = PAGE_HEIGHT_IN_WORLD_UNITS + PAGE_GUTTER_IN_WORLD_UNITS

/** Pages are stacked in a single vertical column, so page culling stays O(1). */
export function computePageBounds(pageIndex: number): Rect {
  return {
    x: 0,
    y: pageIndex * PAGE_STRIDE_IN_WORLD_UNITS,
    width: PAGE_WIDTH_IN_WORLD_UNITS,
    height: PAGE_HEIGHT_IN_WORLD_UNITS,
  }
}

export function computeDocumentBounds(pageCount: number): Rect {
  return {
    x: 0,
    y: 0,
    width: PAGE_WIDTH_IN_WORLD_UNITS,
    height: Math.max(0, pageCount * PAGE_STRIDE_IN_WORLD_UNITS - PAGE_GUTTER_IN_WORLD_UNITS),
  }
}

export function getPageContentBounds(): Rect {
  return {
    x: PAGE_MARGIN_IN_WORLD_UNITS,
    y: PAGE_MARGIN_IN_WORLD_UNITS,
    width: PAGE_WIDTH_IN_WORLD_UNITS - PAGE_MARGIN_IN_WORLD_UNITS * 2,
    height: PAGE_HEIGHT_IN_WORLD_UNITS - PAGE_MARGIN_IN_WORLD_UNITS * 2,
  }
}

export type VisiblePageRange = {
  /** Inclusive. Both indexes are -1 when no page intersects the viewport. */
  firstPageIndex: number
  lastPageIndex: number
}

export function getVisiblePageRange(
  visibleWorldRect: Rect,
  pageCount: number,
  overscanPages = 0,
): VisiblePageRange {
  if (pageCount <= 0) {
    return { firstPageIndex: -1, lastPageIndex: -1 }
  }

  const visibleBottom = visibleWorldRect.y + visibleWorldRect.height
  const firstIntersecting = Math.floor(visibleWorldRect.y / PAGE_STRIDE_IN_WORLD_UNITS)
  const lastIntersecting = Math.floor(visibleBottom / PAGE_STRIDE_IN_WORLD_UNITS)

  const firstPageIndex = Math.max(0, firstIntersecting - overscanPages)
  const lastPageIndex = Math.min(pageCount - 1, lastIntersecting + overscanPages)

  if (firstPageIndex > lastPageIndex) {
    return { firstPageIndex: -1, lastPageIndex: -1 }
  }

  return { firstPageIndex, lastPageIndex }
}

export function pageIndexAtWorldY(worldY: number, pageCount: number): number {
  const pageIndex = Math.floor(worldY / PAGE_STRIDE_IN_WORLD_UNITS)
  if (pageIndex < 0 || pageIndex >= pageCount) {
    return -1
  }
  const offsetWithinStride = worldY - pageIndex * PAGE_STRIDE_IN_WORLD_UNITS
  return offsetWithinStride <= PAGE_HEIGHT_IN_WORLD_UNITS ? pageIndex : -1
}

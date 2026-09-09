import type { Point, Rect } from '../canvas/geometry'

/** A4 at 150 dpi, in world units (1 world unit = 1 CSS pixel at 100% zoom). */
export const PAGE_WIDTH_IN_WORLD_UNITS = 1240
export const PAGE_HEIGHT_IN_WORLD_UNITS = 1754
export const PAGE_GUTTER_IN_WORLD_UNITS = 56
export const PAGE_MARGIN_IN_WORLD_UNITS = 96

const PAGE_COLUMN_STRIDE = PAGE_WIDTH_IN_WORLD_UNITS + PAGE_GUTTER_IN_WORLD_UNITS
const PAGE_ROW_STRIDE = PAGE_HEIGHT_IN_WORLD_UNITS + PAGE_GUTTER_IN_WORLD_UNITS

/** Short documents read best as a continuous scroll; long ones as a contact sheet. */
const MAXIMUM_CONTINUOUS_SCROLL_PAGE_COUNT = 6
const MAXIMUM_GRID_COLUMN_COUNT = 10

/**
 * Where each page sits in world space.
 *
 * Pages are placed on a grid so that zooming out over a hundred-page document actually
 * puts thousands of boxes in the viewport at once — a single column would run 180,000
 * world units deep and only ever reveal a handful of pages.
 */
export type DocumentPageLayout = {
  pageCount: number
  columnCount: number
  rowCount: number
}

export function createDocumentPageLayout(pageCount: number): DocumentPageLayout {
  const columnCount =
    pageCount <= MAXIMUM_CONTINUOUS_SCROLL_PAGE_COUNT
      ? 1
      : Math.min(MAXIMUM_GRID_COLUMN_COUNT, Math.ceil(Math.sqrt(pageCount)))

  return {
    pageCount,
    columnCount,
    rowCount: Math.max(1, Math.ceil(pageCount / columnCount)),
  }
}

export function getPageBounds(layout: DocumentPageLayout, pageIndex: number): Rect {
  const columnIndex = pageIndex % layout.columnCount
  const rowIndex = Math.floor(pageIndex / layout.columnCount)

  return {
    x: columnIndex * PAGE_COLUMN_STRIDE,
    y: rowIndex * PAGE_ROW_STRIDE,
    width: PAGE_WIDTH_IN_WORLD_UNITS,
    height: PAGE_HEIGHT_IN_WORLD_UNITS,
  }
}

export function getDocumentBounds(layout: DocumentPageLayout): Rect {
  const occupiedColumnCount = Math.min(layout.pageCount, layout.columnCount)

  return {
    x: 0,
    y: 0,
    width: Math.max(0, occupiedColumnCount * PAGE_COLUMN_STRIDE - PAGE_GUTTER_IN_WORLD_UNITS),
    height: Math.max(0, layout.rowCount * PAGE_ROW_STRIDE - PAGE_GUTTER_IN_WORLD_UNITS),
  }
}

/** Page-local bounds of the printed area, identical for every page. */
export function getPageContentBounds(): Rect {
  return {
    x: PAGE_MARGIN_IN_WORLD_UNITS,
    y: PAGE_MARGIN_IN_WORLD_UNITS,
    width: PAGE_WIDTH_IN_WORLD_UNITS - PAGE_MARGIN_IN_WORLD_UNITS * 2,
    height: PAGE_HEIGHT_IN_WORLD_UNITS - PAGE_MARGIN_IN_WORLD_UNITS * 2,
  }
}

/**
 * Appends the indexes of every page overlapping `visibleWorldRect`.
 *
 * The grid makes this arithmetic rather than a search, which is what keeps per-frame
 * culling proportional to what is on screen instead of to the document's size.
 */
export function collectVisiblePageIndexes(
  layout: DocumentPageLayout,
  visibleWorldRect: Rect,
  results: number[],
): number[] {
  results.length = 0
  if (layout.pageCount <= 0) {
    return results
  }

  const firstColumnIndex = Math.max(0, Math.floor(visibleWorldRect.x / PAGE_COLUMN_STRIDE))
  const lastColumnIndex = Math.min(
    layout.columnCount - 1,
    Math.floor((visibleWorldRect.x + visibleWorldRect.width) / PAGE_COLUMN_STRIDE),
  )
  const firstRowIndex = Math.max(0, Math.floor(visibleWorldRect.y / PAGE_ROW_STRIDE))
  const lastRowIndex = Math.min(
    layout.rowCount - 1,
    Math.floor((visibleWorldRect.y + visibleWorldRect.height) / PAGE_ROW_STRIDE),
  )

  for (let rowIndex = firstRowIndex; rowIndex <= lastRowIndex; rowIndex += 1) {
    for (let columnIndex = firstColumnIndex; columnIndex <= lastColumnIndex; columnIndex += 1) {
      const pageIndex = rowIndex * layout.columnCount + columnIndex
      if (pageIndex < layout.pageCount) {
        results.push(pageIndex)
      }
    }
  }

  return results
}

export function getPageIndexAtWorldPoint(layout: DocumentPageLayout, point: Point): number {
  const columnIndex = Math.floor(point.x / PAGE_COLUMN_STRIDE)
  const rowIndex = Math.floor(point.y / PAGE_ROW_STRIDE)

  if (
    columnIndex < 0 ||
    rowIndex < 0 ||
    columnIndex >= layout.columnCount ||
    rowIndex >= layout.rowCount
  ) {
    return -1
  }

  const pageIndex = rowIndex * layout.columnCount + columnIndex
  if (pageIndex >= layout.pageCount) {
    return -1
  }

  const bounds = getPageBounds(layout, pageIndex)
  const isInsidePage =
    point.x >= bounds.x &&
    point.y >= bounds.y &&
    point.x <= bounds.x + bounds.width &&
    point.y <= bounds.y + bounds.height

  return isInsidePage ? pageIndex : -1
}

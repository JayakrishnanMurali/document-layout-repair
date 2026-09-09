import type { Rect } from '@/canvas/geometry'
import { getPageContentBounds } from '@/document/pageLayout'
import { createRandomSource, derivePageSeed, type RandomSource } from './randomSource'

/**
 * Deterministic synthetic page content, in **page-local** coordinates (origin at the
 * page's top-left corner). This is the single source of truth for both the rasterized
 * page texture and the extraction payload, so every bounding box lands exactly on the
 * ink it describes.
 *
 * `items` is already in reading order: column by column, top to bottom.
 */

export const COLUMN_GAP_IN_WORLD_UNITS = 44
export const WORD_GAP_IN_WORLD_UNITS = 9

const TEXT_METRICS = {
  title: { lineHeight: 62, glyphHeight: 40, minimumWordWidth: 60, maximumWordWidth: 220 },
  heading: { lineHeight: 46, glyphHeight: 27, minimumWordWidth: 44, maximumWordWidth: 170 },
  paragraph: { lineHeight: 34, glyphHeight: 20, minimumWordWidth: 30, maximumWordWidth: 140 },
  caption: { lineHeight: 28, glyphHeight: 16, minimumWordWidth: 26, maximumWordWidth: 110 },
} as const

export type SyntheticTextBlockKind = keyof typeof TEXT_METRICS

export type SyntheticTextLine = {
  bounds: Rect
  /** Word widths in world units, laid out left to right with `WORD_GAP_IN_WORLD_UNITS`. */
  wordWidths: number[]
  glyphHeight: number
}

export type SyntheticPageItem =
  | {
      kind: 'text'
      blockKind: SyntheticTextBlockKind
      bounds: Rect
      columnIndex: number
      lines: SyntheticTextLine[]
    }
  | {
      kind: 'table'
      bounds: Rect
      columnIndex: number
      /** Page-local absolute divider positions; length is columnCount + 1. */
      columnEdges: number[]
      /** Page-local absolute divider positions; length is rowCount + 1. */
      rowEdges: number[]
      headerRowCount: number
      /** Row-major fill fraction per cell, used to draw plausible cell text. */
      cellTextFractions: number[]
    }
  | {
      kind: 'keyValue'
      bounds: Rect
      columnIndex: number
      keyBounds: Rect
      valueBounds: Rect
      keyWordWidths: number[]
      valueWordWidths: number[]
    }
  | {
      kind: 'figure'
      bounds: Rect
      columnIndex: number
      figureSeed: number
    }

export type SyntheticPageLayoutKind = 'single-column' | 'two-column'

export type SyntheticPageContent = {
  pageIndex: number
  layoutKind: SyntheticPageLayoutKind
  contentBounds: Rect
  /** Block-level items in reading order. */
  items: SyntheticPageItem[]
}

type ColumnCursor = {
  columnIndex: number
  bounds: Rect
  nextY: number
}

function generateWordWidths(
  random: RandomSource,
  availableWidth: number,
  fillFraction: number,
  minimumWordWidth: number,
  maximumWordWidth: number,
): number[] {
  const targetWidth = availableWidth * fillFraction
  const wordWidths: number[] = []
  let usedWidth = 0

  while (usedWidth < targetWidth) {
    const remaining = targetWidth - usedWidth
    if (remaining < minimumWordWidth) {
      break
    }
    const wordWidth = Math.min(
      random.nextInRange(minimumWordWidth, maximumWordWidth),
      remaining,
    )
    wordWidths.push(wordWidth)
    usedWidth += wordWidth + WORD_GAP_IN_WORLD_UNITS
  }

  if (wordWidths.length === 0) {
    wordWidths.push(Math.min(minimumWordWidth, availableWidth))
  }

  return wordWidths
}

function measureLineWidth(wordWidths: number[]): number {
  let width = 0
  for (const wordWidth of wordWidths) {
    width += wordWidth + WORD_GAP_IN_WORLD_UNITS
  }
  return Math.max(0, width - WORD_GAP_IN_WORLD_UNITS)
}

function generateTextLine(
  random: RandomSource,
  originX: number,
  originY: number,
  availableWidth: number,
  fillFraction: number,
  blockKind: SyntheticTextBlockKind,
): SyntheticTextLine {
  const metrics = TEXT_METRICS[blockKind]
  const wordWidths = generateWordWidths(
    random,
    availableWidth,
    fillFraction,
    metrics.minimumWordWidth,
    metrics.maximumWordWidth,
  )

  return {
    bounds: {
      x: originX,
      y: originY,
      width: measureLineWidth(wordWidths),
      height: metrics.glyphHeight,
    },
    wordWidths,
    glyphHeight: metrics.glyphHeight,
  }
}

function createTextItem(
  random: RandomSource,
  cursor: ColumnCursor,
  blockKind: SyntheticTextBlockKind,
  lineCount: number,
): SyntheticPageItem {
  const metrics = TEXT_METRICS[blockKind]
  const lines: SyntheticTextLine[] = []

  for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
    const isLastLine = lineIndex === lineCount - 1
    const fillFraction = isLastLine ? random.nextInRange(0.34, 0.86) : random.nextInRange(0.95, 1)
    lines.push(
      generateTextLine(
        random,
        cursor.bounds.x,
        cursor.nextY + lineIndex * metrics.lineHeight,
        cursor.bounds.width,
        fillFraction,
        blockKind,
      ),
    )
  }

  const widestLineWidth = lines.reduce((widest, line) => Math.max(widest, line.bounds.width), 0)

  return {
    kind: 'text',
    blockKind,
    bounds: {
      x: cursor.bounds.x,
      y: cursor.nextY,
      width: widestLineWidth,
      height: (lineCount - 1) * metrics.lineHeight + metrics.glyphHeight,
    },
    columnIndex: cursor.columnIndex,
    lines,
  }
}

function createTableItem(random: RandomSource, cursor: ColumnCursor): SyntheticPageItem {
  const columnCount = random.nextInteger(3, 7)
  const rowCount = random.nextInteger(4, 10)
  const rowHeight = random.nextInRange(38, 46)

  const columnWeights: number[] = []
  let totalWeight = 0
  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const weight = columnIndex === 0 ? random.nextInRange(1.4, 2.2) : random.nextInRange(0.7, 1.3)
    columnWeights.push(weight)
    totalWeight += weight
  }

  const columnEdges: number[] = [cursor.bounds.x]
  let edgeX = cursor.bounds.x
  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    edgeX += (columnWeights[columnIndex] / totalWeight) * cursor.bounds.width
    columnEdges.push(columnIndex === columnCount - 1 ? cursor.bounds.x + cursor.bounds.width : edgeX)
  }

  const rowEdges: number[] = []
  for (let rowIndex = 0; rowIndex <= rowCount; rowIndex += 1) {
    rowEdges.push(cursor.nextY + rowIndex * rowHeight)
  }

  const cellTextFractions: number[] = []
  for (let cellIndex = 0; cellIndex < rowCount * columnCount; cellIndex += 1) {
    cellTextFractions.push(random.nextInRange(0.35, 0.88))
  }

  return {
    kind: 'table',
    bounds: {
      x: cursor.bounds.x,
      y: cursor.nextY,
      width: cursor.bounds.width,
      height: rowCount * rowHeight,
    },
    columnIndex: cursor.columnIndex,
    columnEdges,
    rowEdges,
    headerRowCount: 1,
    cellTextFractions,
  }
}

function createKeyValueItem(random: RandomSource, cursor: ColumnCursor): SyntheticPageItem {
  const metrics = TEXT_METRICS.paragraph
  const keyWidth = cursor.bounds.width * random.nextInRange(0.26, 0.38)
  const valueX = cursor.bounds.x + keyWidth + 24
  const valueWidth = cursor.bounds.x + cursor.bounds.width - valueX

  const keyWordWidths = generateWordWidths(random, keyWidth, random.nextInRange(0.6, 0.95), 32, 96)
  const valueWordWidths = generateWordWidths(
    random,
    valueWidth,
    random.nextInRange(0.45, 0.92),
    32,
    120,
  )

  const keyBounds: Rect = {
    x: cursor.bounds.x,
    y: cursor.nextY,
    width: measureLineWidth(keyWordWidths),
    height: metrics.glyphHeight,
  }
  const valueBounds: Rect = {
    x: valueX,
    y: cursor.nextY,
    width: measureLineWidth(valueWordWidths),
    height: metrics.glyphHeight,
  }

  return {
    kind: 'keyValue',
    bounds: {
      x: keyBounds.x,
      y: cursor.nextY,
      width: valueBounds.x + valueBounds.width - keyBounds.x,
      height: metrics.glyphHeight,
    },
    columnIndex: cursor.columnIndex,
    keyBounds,
    valueBounds,
    keyWordWidths,
    valueWordWidths,
  }
}

function createFigureItem(random: RandomSource, cursor: ColumnCursor): SyntheticPageItem {
  return {
    kind: 'figure',
    bounds: {
      x: cursor.bounds.x,
      y: cursor.nextY,
      width: cursor.bounds.width,
      height: random.nextInRange(210, 380),
    },
    columnIndex: cursor.columnIndex,
    figureSeed: random.nextInteger(0, 0xffff),
  }
}

const BLOCK_SPACING_IN_WORLD_UNITS = 26

export function generateSyntheticPageContent(
  pageIndex: number,
  documentSeed: number,
): SyntheticPageContent {
  const random = createRandomSource(derivePageSeed(documentSeed, pageIndex))
  const contentBounds = getPageContentBounds()
  const layoutKind: SyntheticPageLayoutKind =
    pageIndex > 0 && random.nextBoolean(0.34) ? 'two-column' : 'single-column'

  const columnCursors: ColumnCursor[] = []
  if (layoutKind === 'two-column') {
    const columnWidth = (contentBounds.width - COLUMN_GAP_IN_WORLD_UNITS) / 2
    columnCursors.push(
      {
        columnIndex: 0,
        bounds: { ...contentBounds, width: columnWidth },
        nextY: contentBounds.y,
      },
      {
        columnIndex: 1,
        bounds: {
          ...contentBounds,
          x: contentBounds.x + columnWidth + COLUMN_GAP_IN_WORLD_UNITS,
          width: columnWidth,
        },
        nextY: contentBounds.y,
      },
    )
  } else {
    columnCursors.push({ columnIndex: 0, bounds: { ...contentBounds }, nextY: contentBounds.y })
  }

  const items: SyntheticPageItem[] = []
  const contentBottom = contentBounds.y + contentBounds.height

  for (const cursor of columnCursors) {
    let isFirstItemInColumn = true
    let keyValueRunLength = 0

    while (cursor.nextY < contentBottom - TEXT_METRICS.paragraph.lineHeight * 2) {
      const remainingHeight = contentBottom - cursor.nextY
      let item: SyntheticPageItem

      if (isFirstItemInColumn && cursor.columnIndex === 0) {
        item = createTextItem(random, cursor, pageIndex === 0 ? 'title' : 'heading', 1)
      } else if (keyValueRunLength > 0) {
        item = createKeyValueItem(random, cursor)
        keyValueRunLength -= 1
      } else {
        const roll = random.nextFloat()
        if (roll < 0.1 && remainingHeight > 260) {
          item = createFigureItem(random, cursor)
        } else if (roll < 0.28 && remainingHeight > 300 && cursor.bounds.width > 400) {
          item = createTableItem(random, cursor)
        } else if (roll < 0.42) {
          keyValueRunLength = random.nextInteger(3, 8)
          item = createKeyValueItem(random, cursor)
          keyValueRunLength -= 1
        } else if (roll < 0.52) {
          item = createTextItem(random, cursor, 'heading', 1)
        } else {
          const maximumLineCount = Math.max(
            2,
            Math.floor(remainingHeight / TEXT_METRICS.paragraph.lineHeight),
          )
          item = createTextItem(
            random,
            cursor,
            'paragraph',
            Math.min(random.nextInteger(3, 9), maximumLineCount),
          )
        }
      }

      if (item.bounds.y + item.bounds.height > contentBottom) {
        break
      }

      items.push(item)
      cursor.nextY = item.bounds.y + item.bounds.height + BLOCK_SPACING_IN_WORLD_UNITS
      isFirstItemInColumn = false

      if (item.kind === 'figure') {
        items.push(createTextItem(random, cursor, 'caption', 1))
        const caption = items[items.length - 1]
        cursor.nextY = caption.bounds.y + caption.bounds.height + BLOCK_SPACING_IN_WORLD_UNITS
      }
    }
  }

  return { pageIndex, layoutKind, contentBounds, items }
}

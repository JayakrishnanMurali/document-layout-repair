import type { Rect } from '../../canvas/geometry'
import { getPageContentBounds } from '../pageLayout'
import {
  estimateTextWidth,
  makeDocumentTitle,
  makeFieldLabel,
  makeFieldValue,
  makeHeading,
  makeTableCellText,
  makeTableColumnLabel,
  pickBodyWord,
  pickTableColumnKinds,
  type TableColumnKind,
} from './documentVocabulary'
import { createRandomSource, derivePageSeed, type RandomSource } from './randomSource'

/**
 * Deterministic synthetic page content, in **page-local** coordinates (origin at the
 * page's top-left corner). This is the single source of truth for both the rasterized
 * page texture and the extraction payload, so every bounding box lands exactly on the
 * ink it describes and every tree-view label quotes the text actually printed.
 *
 * `items` is already in reading order: column by column, top to bottom.
 */

export const COLUMN_GAP_IN_WORLD_UNITS = 44
export const TABLE_CELL_PADDING_IN_WORLD_UNITS = 12

export type SyntheticTextStyleName = 'title' | 'heading' | 'paragraph' | 'caption'

type TextStyle = {
  fontSizeInWorldUnits: number
  lineHeightInWorldUnits: number
  isBold: boolean
}

export const TEXT_STYLES: Record<SyntheticTextStyleName, TextStyle> = {
  title: { fontSizeInWorldUnits: 40, lineHeightInWorldUnits: 58, isBold: true },
  heading: { fontSizeInWorldUnits: 26, lineHeightInWorldUnits: 42, isBold: true },
  paragraph: { fontSizeInWorldUnits: 21, lineHeightInWorldUnits: 32, isBold: false },
  caption: { fontSizeInWorldUnits: 17, lineHeightInWorldUnits: 26, isBold: false },
}

export const KEY_VALUE_FONT_SIZE_IN_WORLD_UNITS = 20
export const TABLE_FONT_SIZE_IN_WORLD_UNITS = 18

/** Ratio of the glyph box height to the font size, and of the baseline within it. */
const GLYPH_BOX_HEIGHT_RATIO = 1.04
const BASELINE_RATIO = 0.82

export function getGlyphBoxHeight(fontSizeInWorldUnits: number): number {
  return fontSizeInWorldUnits * GLYPH_BOX_HEIGHT_RATIO
}

export function getBaselineOffset(fontSizeInWorldUnits: number): number {
  return fontSizeInWorldUnits * BASELINE_RATIO
}

export type SyntheticWord = {
  text: string
  /** Page-local x of the word's left edge. */
  x: number
  width: number
}

export type SyntheticTextLine = {
  bounds: Rect
  words: SyntheticWord[]
  fontSizeInWorldUnits: number
  isBold: boolean
}

export type SyntheticPageItem =
  | {
      kind: 'text'
      styleName: SyntheticTextStyleName
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
      columnKinds: TableColumnKind[]
      /** Row-major, `rowCount * columnCount` entries. */
      cellTexts: string[]
    }
  | {
      kind: 'keyValue'
      bounds: Rect
      columnIndex: number
      keyBounds: Rect
      valueBounds: Rect
      keyText: string
      valueText: string
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

function layOutWords(
  random: RandomSource,
  originX: number,
  availableWidth: number,
  fontSizeInWorldUnits: number,
  fillFraction: number,
): SyntheticWord[] {
  const spaceWidth = estimateTextWidth(' ', fontSizeInWorldUnits)
  const targetWidth = availableWidth * fillFraction
  const words: SyntheticWord[] = []
  let cursorX = originX

  for (;;) {
    const text = pickBodyWord(random)
    const width = estimateTextWidth(text, fontSizeInWorldUnits)
    if (cursorX - originX + width > targetWidth && words.length > 0) {
      break
    }
    words.push({ text, x: cursorX, width })
    cursorX += width + spaceWidth
  }

  return words
}

function measureLineWidth(words: SyntheticWord[], originX: number): number {
  const lastWord = words[words.length - 1]
  return lastWord ? lastWord.x + lastWord.width - originX : 0
}

function createTextItem(
  random: RandomSource,
  cursor: ColumnCursor,
  styleName: SyntheticTextStyleName,
  lineCount: number,
  headingText?: string,
): SyntheticPageItem {
  const style = TEXT_STYLES[styleName]
  const glyphBoxHeight = getGlyphBoxHeight(style.fontSizeInWorldUnits)
  const lines: SyntheticTextLine[] = []

  for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
    const lineY = cursor.nextY + lineIndex * style.lineHeightInWorldUnits
    let words: SyntheticWord[]

    if (headingText !== undefined && lineIndex === 0) {
      words = layOutFixedText(headingText, cursor.bounds.x, style.fontSizeInWorldUnits)
    } else {
      const isLastLine = lineIndex === lineCount - 1
      words = layOutWords(
        random,
        cursor.bounds.x,
        cursor.bounds.width,
        style.fontSizeInWorldUnits,
        isLastLine ? random.nextInRange(0.34, 0.86) : 1,
      )
    }

    lines.push({
      bounds: {
        x: cursor.bounds.x,
        y: lineY,
        width: measureLineWidth(words, cursor.bounds.x),
        height: glyphBoxHeight,
      },
      words,
      fontSizeInWorldUnits: style.fontSizeInWorldUnits,
      isBold: style.isBold,
    })
  }

  const widestLineWidth = lines.reduce((widest, line) => Math.max(widest, line.bounds.width), 0)

  return {
    kind: 'text',
    styleName,
    bounds: {
      x: cursor.bounds.x,
      y: cursor.nextY,
      width: widestLineWidth,
      height: (lineCount - 1) * style.lineHeightInWorldUnits + glyphBoxHeight,
    },
    columnIndex: cursor.columnIndex,
    lines,
  }
}

function layOutFixedText(
  text: string,
  originX: number,
  fontSizeInWorldUnits: number,
): SyntheticWord[] {
  const spaceWidth = estimateTextWidth(' ', fontSizeInWorldUnits)
  const words: SyntheticWord[] = []
  let cursorX = originX

  for (const token of text.split(' ')) {
    const width = estimateTextWidth(token, fontSizeInWorldUnits)
    words.push({ text: token, x: cursorX, width })
    cursorX += width + spaceWidth
  }

  return words
}

function createTableItem(random: RandomSource, cursor: ColumnCursor): SyntheticPageItem {
  const columnCount = random.nextInteger(3, 7)
  const rowCount = random.nextInteger(4, 10)
  const rowHeight = random.nextInRange(38, 46)
  const columnKinds = pickTableColumnKinds(random, columnCount)

  const columnWeights: number[] = []
  let totalWeight = 0
  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const weight = columnIndex === 0 ? random.nextInRange(1.5, 2.3) : random.nextInRange(0.75, 1.3)
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

  const headerRowCount = 1
  const cellTexts: string[] = []
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      cellTexts.push(
        rowIndex < headerRowCount
          ? makeTableColumnLabel(random)
          : makeTableCellText(random, columnKinds[columnIndex] ?? 'text'),
      )
    }
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
    headerRowCount,
    columnKinds,
    cellTexts,
  }
}

function createKeyValueItem(random: RandomSource, cursor: ColumnCursor): SyntheticPageItem {
  const fontSize = KEY_VALUE_FONT_SIZE_IN_WORLD_UNITS
  const glyphBoxHeight = getGlyphBoxHeight(fontSize)
  const keyText = makeFieldLabel(random)
  const valueText = makeFieldValue(random, keyText)

  const keyColumnWidth = Math.max(cursor.bounds.width * 0.36, 180)
  const valueX = cursor.bounds.x + keyColumnWidth
  const availableValueWidth = cursor.bounds.x + cursor.bounds.width - valueX

  const keyBounds: Rect = {
    x: cursor.bounds.x,
    y: cursor.nextY,
    width: Math.min(estimateTextWidth(keyText, fontSize), keyColumnWidth - 16),
    height: glyphBoxHeight,
  }
  const valueBounds: Rect = {
    x: valueX,
    y: cursor.nextY,
    width: Math.min(estimateTextWidth(valueText, fontSize), availableValueWidth),
    height: glyphBoxHeight,
  }

  return {
    kind: 'keyValue',
    bounds: {
      x: keyBounds.x,
      y: cursor.nextY,
      width: valueBounds.x + valueBounds.width - keyBounds.x,
      height: glyphBoxHeight,
    },
    columnIndex: cursor.columnIndex,
    keyBounds,
    valueBounds,
    keyText,
    valueText,
  }
}

function createFigureItem(random: RandomSource, cursor: ColumnCursor): SyntheticPageItem {
  return {
    kind: 'figure',
    bounds: {
      x: cursor.bounds.x,
      y: cursor.nextY,
      width: cursor.bounds.width,
      height: random.nextInRange(210, 360),
    },
    columnIndex: cursor.columnIndex,
    figureSeed: random.nextInteger(1, 0xffff),
  }
}

const BLOCK_SPACING_IN_WORLD_UNITS = 26
const KEY_VALUE_ROW_SPACING_IN_WORLD_UNITS = 10

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
      { columnIndex: 0, bounds: { ...contentBounds, width: columnWidth }, nextY: contentBounds.y },
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
    let remainingKeyValueRows = 0

    while (cursor.nextY < contentBottom - TEXT_STYLES.paragraph.lineHeightInWorldUnits * 2) {
      const remainingHeight = contentBottom - cursor.nextY
      let item: SyntheticPageItem

      if (isFirstItemInColumn && cursor.columnIndex === 0) {
        item =
          pageIndex === 0
            ? createTextItem(random, cursor, 'title', 1, makeDocumentTitle(random))
            : createTextItem(random, cursor, 'heading', 1, makeHeading(random))
      } else if (remainingKeyValueRows > 0) {
        item = createKeyValueItem(random, cursor)
        remainingKeyValueRows -= 1
      } else {
        const roll = random.nextFloat()
        if (roll < 0.1 && remainingHeight > 280) {
          item = createFigureItem(random, cursor)
        } else if (roll < 0.28 && remainingHeight > 300 && cursor.bounds.width > 420) {
          item = createTableItem(random, cursor)
        } else if (roll < 0.44) {
          remainingKeyValueRows = random.nextInteger(4, 9)
          item = createKeyValueItem(random, cursor)
          remainingKeyValueRows -= 1
        } else if (roll < 0.54) {
          item = createTextItem(random, cursor, 'heading', 1, makeHeading(random))
        } else {
          const maximumLineCount = Math.max(
            2,
            Math.floor(remainingHeight / TEXT_STYLES.paragraph.lineHeightInWorldUnits),
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
      const spacing =
        item.kind === 'keyValue'
          ? KEY_VALUE_ROW_SPACING_IN_WORLD_UNITS
          : BLOCK_SPACING_IN_WORLD_UNITS
      cursor.nextY = item.bounds.y + item.bounds.height + spacing
      isFirstItemInColumn = false

      if (item.kind === 'figure') {
        const caption = createTextItem(random, cursor, 'caption', 1)
        items.push(caption)
        cursor.nextY = caption.bounds.y + caption.bounds.height + BLOCK_SPACING_IN_WORLD_UNITS
      }
    }
  }

  return { pageIndex, layoutKind, contentBounds, items }
}

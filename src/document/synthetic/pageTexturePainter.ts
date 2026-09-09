import { rectsIntersect, type Rect } from '@/canvas/geometry'
import { PAGE_HEIGHT_IN_WORLD_UNITS, PAGE_WIDTH_IN_WORLD_UNITS } from '@/document/pageLayout'
import { createRandomSource } from './randomSource'
import {
  KEY_VALUE_FONT_SIZE_IN_WORLD_UNITS,
  TABLE_CELL_PADDING_IN_WORLD_UNITS,
  TABLE_FONT_SIZE_IN_WORLD_UNITS,
  getBaselineOffset,
  getGlyphBoxHeight,
  type SyntheticPageContent,
  type SyntheticPageItem,
  type SyntheticTextLine,
} from './pageContentGenerator'

export type Canvas2DContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

const DOCUMENT_FONT_STACK = "Georgia, 'Times New Roman', 'Noto Serif', serif"
const PAPER_BASE_COLOR = '#f6f4ef'
const INK_COLOR = 'rgba(30, 33, 38, 0.92)'
const SECONDARY_INK_COLOR = 'rgba(30, 33, 38, 0.78)'
const RULE_COLOR = 'rgba(44, 48, 55, 0.5)'
const HEADER_FILL_COLOR = 'rgba(38, 42, 50, 0.07)'
const FIGURE_FILL_COLOR = 'rgba(38, 42, 50, 0.05)'

/** Divides the tile texel size, so paper grain is seamless across tile borders. */
const NOISE_TILE_SIZE = 64

const RIGHT_ALIGNED_COLUMN_KINDS = new Set(['amount', 'quantity'])

function createBackingCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height)
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

let cachedNoisePattern: CanvasPattern | null = null

function getScanNoisePattern(context: Canvas2DContext): CanvasPattern | null {
  if (cachedNoisePattern) {
    return cachedNoisePattern
  }

  const tile = createBackingCanvas(NOISE_TILE_SIZE, NOISE_TILE_SIZE)
  const tileContext = tile.getContext('2d') as Canvas2DContext | null
  if (!tileContext) {
    return null
  }

  const imageData = tileContext.createImageData(NOISE_TILE_SIZE, NOISE_TILE_SIZE)
  const random = createRandomSource(0x5eed_1a2b)
  for (let pixelIndex = 0; pixelIndex < imageData.data.length; pixelIndex += 4) {
    const grain = 128 + (random.nextFloat() - 0.5) * 255
    imageData.data[pixelIndex] = grain
    imageData.data[pixelIndex + 1] = grain
    imageData.data[pixelIndex + 2] = grain
    imageData.data[pixelIndex + 3] = 24
  }
  tileContext.putImageData(imageData, 0, 0)

  cachedNoisePattern = context.createPattern(tile as never, 'repeat')
  return cachedNoisePattern
}

function paintPaper(
  context: Canvas2DContext,
  sourceBounds: Rect,
  texelsPerWorldUnit: number,
): void {
  const texelWidth = Math.round(sourceBounds.width * texelsPerWorldUnit)
  const texelHeight = Math.round(sourceBounds.height * texelsPerWorldUnit)

  context.setTransform(1, 0, 0, 1, 0, 0)
  context.fillStyle = PAPER_BASE_COLOR
  context.fillRect(0, 0, texelWidth, texelHeight)

  // The gradient is anchored to the whole page, not to this region, so neighbouring
  // tiles line up seamlessly.
  const vignette = context.createLinearGradient(
    -sourceBounds.x * texelsPerWorldUnit,
    -sourceBounds.y * texelsPerWorldUnit,
    (PAGE_WIDTH_IN_WORLD_UNITS - sourceBounds.x) * texelsPerWorldUnit,
    (PAGE_HEIGHT_IN_WORLD_UNITS - sourceBounds.y) * texelsPerWorldUnit,
  )
  vignette.addColorStop(0, 'rgba(255, 255, 255, 0.5)')
  vignette.addColorStop(0.55, 'rgba(226, 221, 210, 0.16)')
  vignette.addColorStop(1, 'rgba(198, 192, 180, 0.32)')
  context.fillStyle = vignette
  context.fillRect(0, 0, texelWidth, texelHeight)

  const noisePattern = getScanNoisePattern(context)
  if (noisePattern) {
    context.fillStyle = noisePattern
    context.fillRect(0, 0, texelWidth, texelHeight)
  }
}

function setFont(context: Canvas2DContext, fontSizeInWorldUnits: number, isBold: boolean): void {
  context.font = `${isBold ? '600 ' : ''}${fontSizeInWorldUnits}px ${DOCUMENT_FONT_STACK}`
}

/**
 * Draws a word stretched to exactly the width the content generator recorded.
 *
 * The generator estimates widths without a canvas so that workers and tests agree; this
 * absorbs the residual error (a few percent) instead of letting bounding boxes drift off
 * the ink they annotate.
 */
function paintWordFittedToWidth(
  context: Canvas2DContext,
  text: string,
  x: number,
  baselineY: number,
  targetWidth: number,
): void {
  const measuredWidth = context.measureText(text).width
  if (measuredWidth <= 0) {
    return
  }

  const horizontalScale = targetWidth / measuredWidth
  if (Math.abs(horizontalScale - 1) < 0.015) {
    context.fillText(text, x, baselineY)
    return
  }

  context.save()
  context.translate(x, baselineY)
  context.scale(horizontalScale, 1)
  context.fillText(text, 0, 0)
  context.restore()
}

function paintTextLine(context: Canvas2DContext, line: SyntheticTextLine, inkColor: string): void {
  setFont(context, line.fontSizeInWorldUnits, line.isBold)
  context.fillStyle = inkColor
  const baselineY = line.bounds.y + getBaselineOffset(line.fontSizeInWorldUnits)

  for (const word of line.words) {
    paintWordFittedToWidth(context, word.text, word.x, baselineY, word.width)
  }
}

function paintFigure(context: Canvas2DContext, bounds: Rect, figureSeed: number): void {
  context.fillStyle = FIGURE_FILL_COLOR
  context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height)

  const random = createRandomSource(figureSeed)
  const barCount = random.nextInteger(6, 14)
  const plotInset = Math.min(30, bounds.width * 0.08)
  const plotWidth = bounds.width - plotInset * 2
  const plotHeight = bounds.height - plotInset * 2
  const barSlotWidth = plotWidth / barCount

  for (let barIndex = 0; barIndex < barCount; barIndex += 1) {
    const barHeight = plotHeight * random.nextInRange(0.15, 1)
    context.fillStyle = `rgba(30, 33, 38, ${random.nextInRange(0.24, 0.5).toFixed(3)})`
    context.fillRect(
      bounds.x + plotInset + barIndex * barSlotWidth + barSlotWidth * 0.18,
      bounds.y + plotInset + plotHeight - barHeight,
      barSlotWidth * 0.64,
      barHeight,
    )
  }

  context.strokeStyle = RULE_COLOR
  context.beginPath()
  context.moveTo(bounds.x + plotInset, bounds.y + plotInset)
  context.lineTo(bounds.x + plotInset, bounds.y + plotInset + plotHeight)
  context.lineTo(bounds.x + plotInset + plotWidth, bounds.y + plotInset + plotHeight)
  context.stroke()
  context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height)
}

function paintTable(
  context: Canvas2DContext,
  item: Extract<SyntheticPageItem, { kind: 'table' }>,
): void {
  const rowCount = item.rowEdges.length - 1
  const columnCount = item.columnEdges.length - 1

  for (let headerRowIndex = 0; headerRowIndex < item.headerRowCount; headerRowIndex += 1) {
    context.fillStyle = HEADER_FILL_COLOR
    context.fillRect(
      item.bounds.x,
      item.rowEdges[headerRowIndex],
      item.bounds.width,
      item.rowEdges[headerRowIndex + 1] - item.rowEdges[headerRowIndex],
    )
  }

  context.strokeStyle = RULE_COLOR
  context.beginPath()
  for (const edgeY of item.rowEdges) {
    context.moveTo(item.bounds.x, edgeY)
    context.lineTo(item.bounds.x + item.bounds.width, edgeY)
  }
  for (const edgeX of item.columnEdges) {
    context.moveTo(edgeX, item.bounds.y)
    context.lineTo(edgeX, item.bounds.y + item.bounds.height)
  }
  context.stroke()

  const baselineOffset = getBaselineOffset(TABLE_FONT_SIZE_IN_WORLD_UNITS)
  const glyphBoxHeight = getGlyphBoxHeight(TABLE_FONT_SIZE_IN_WORLD_UNITS)

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const isHeaderRow = rowIndex < item.headerRowCount
    setFont(context, TABLE_FONT_SIZE_IN_WORLD_UNITS, isHeaderRow)
    context.fillStyle = isHeaderRow ? INK_COLOR : SECONDARY_INK_COLOR

    const cellTop = item.rowEdges[rowIndex]
    const cellHeight = item.rowEdges[rowIndex + 1] - cellTop
    const baselineY = cellTop + (cellHeight - glyphBoxHeight) / 2 + baselineOffset

    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const text = item.cellTexts[rowIndex * columnCount + columnIndex]
      if (!text) {
        continue
      }
      const cellLeft = item.columnEdges[columnIndex]
      const cellRight = item.columnEdges[columnIndex + 1]
      const availableWidth = cellRight - cellLeft - TABLE_CELL_PADDING_IN_WORLD_UNITS * 2
      const isRightAligned =
        !isHeaderRow && RIGHT_ALIGNED_COLUMN_KINDS.has(item.columnKinds[columnIndex] ?? '')

      context.textAlign = isRightAligned ? 'right' : 'left'
      context.fillText(
        text,
        isRightAligned
          ? cellRight - TABLE_CELL_PADDING_IN_WORLD_UNITS
          : cellLeft + TABLE_CELL_PADDING_IN_WORLD_UNITS,
        baselineY,
        availableWidth,
      )
    }
  }

  context.textAlign = 'left'
}

function paintItem(context: Canvas2DContext, item: SyntheticPageItem): void {
  switch (item.kind) {
    case 'text': {
      const inkColor = item.styleName === 'caption' ? SECONDARY_INK_COLOR : INK_COLOR
      for (const line of item.lines) {
        paintTextLine(context, line, inkColor)
      }
      break
    }

    case 'table':
      paintTable(context, item)
      break

    case 'keyValue': {
      const baselineY = item.keyBounds.y + getBaselineOffset(KEY_VALUE_FONT_SIZE_IN_WORLD_UNITS)
      setFont(context, KEY_VALUE_FONT_SIZE_IN_WORLD_UNITS, true)
      context.fillStyle = SECONDARY_INK_COLOR
      paintWordFittedToWidth(
        context,
        item.keyText,
        item.keyBounds.x,
        baselineY,
        item.keyBounds.width,
      )

      setFont(context, KEY_VALUE_FONT_SIZE_IN_WORLD_UNITS, false)
      context.fillStyle = INK_COLOR
      paintWordFittedToWidth(
        context,
        item.valueText,
        item.valueBounds.x,
        baselineY,
        item.valueBounds.width,
      )
      break
    }

    case 'figure':
      paintFigure(context, item.bounds, item.figureSeed)
      break
  }
}

/**
 * Rasterizes one page-local region at a chosen texel density. Tiles and thumbnails both
 * go through here, which is what keeps a tile's paper, ink and rules identical to the
 * same area of the whole-page thumbnail.
 */
export function paintSyntheticPageRegion(
  context: Canvas2DContext,
  content: SyntheticPageContent,
  sourceBounds: Rect,
  texelsPerWorldUnit: number,
): void {
  paintPaper(context, sourceBounds, texelsPerWorldUnit)

  context.setTransform(
    texelsPerWorldUnit,
    0,
    0,
    texelsPerWorldUnit,
    -sourceBounds.x * texelsPerWorldUnit,
    -sourceBounds.y * texelsPerWorldUnit,
  )
  context.lineWidth = Math.max(1.2, 1 / texelsPerWorldUnit)
  context.textBaseline = 'alphabetic'
  context.textAlign = 'left'

  for (const item of content.items) {
    if (rectsIntersect(item.bounds, sourceBounds)) {
      paintItem(context, item)
    }
  }

  context.setTransform(1, 0, 0, 1, 0, 0)
}

export const FULL_PAGE_BOUNDS: Rect = {
  x: 0,
  y: 0,
  width: PAGE_WIDTH_IN_WORLD_UNITS,
  height: PAGE_HEIGHT_IN_WORLD_UNITS,
}

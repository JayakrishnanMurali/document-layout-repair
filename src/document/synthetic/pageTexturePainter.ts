import { rectsIntersect, type Rect } from '@/canvas/geometry'
import { PAGE_HEIGHT_IN_WORLD_UNITS, PAGE_WIDTH_IN_WORLD_UNITS } from '@/document/pageLayout'
import { createRandomSource } from './randomSource'
import {
  WORD_GAP_IN_WORLD_UNITS,
  type SyntheticPageContent,
  type SyntheticPageItem,
  type SyntheticTextLine,
} from './pageContentGenerator'

export type Canvas2DContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

const PAPER_BASE_COLOR = '#f6f4ef'
const INK_COLOR = '30, 33, 38'
const RULE_COLOR = 'rgba(44, 48, 55, 0.55)'
const HEADER_FILL_COLOR = 'rgba(38, 42, 50, 0.07)'
const FIGURE_FILL_COLOR = 'rgba(38, 42, 50, 0.05)'

/** Divides the tile texel size, so paper grain is seamless across tile borders. */
const NOISE_TILE_SIZE = 64

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
    imageData.data[pixelIndex + 3] = 26
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

function paintTextLine(
  context: Canvas2DContext,
  line: SyntheticTextLine,
  inkAlpha: number,
  wordRandomSeed: number,
): void {
  const random = createRandomSource(wordRandomSeed)
  let wordX = line.bounds.x

  for (const wordWidth of line.wordWidths) {
    const alpha = inkAlpha * random.nextInRange(0.82, 1)
    const verticalJitter = random.nextInRange(-0.4, 0.4)
    context.fillStyle = `rgba(${INK_COLOR}, ${alpha.toFixed(3)})`
    context.fillRect(wordX, line.bounds.y + verticalJitter, wordWidth, line.glyphHeight)
    wordX += wordWidth + WORD_GAP_IN_WORLD_UNITS
  }
}

function paintFigure(context: Canvas2DContext, bounds: { x: number; y: number; width: number; height: number }, figureSeed: number): void {
  context.fillStyle = FIGURE_FILL_COLOR
  context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height)

  const random = createRandomSource(figureSeed || 1)
  const barCount = random.nextInteger(6, 14)
  const plotInset = Math.min(28, bounds.width * 0.08)
  const plotWidth = bounds.width - plotInset * 2
  const plotHeight = bounds.height - plotInset * 2
  const barSlotWidth = plotWidth / barCount

  for (let barIndex = 0; barIndex < barCount; barIndex += 1) {
    const barHeight = plotHeight * random.nextInRange(0.15, 1)
    context.fillStyle = `rgba(${INK_COLOR}, ${random.nextInRange(0.24, 0.5).toFixed(3)})`
    context.fillRect(
      bounds.x + plotInset + barIndex * barSlotWidth + barSlotWidth * 0.18,
      bounds.y + plotInset + plotHeight - barHeight,
      barSlotWidth * 0.64,
      barHeight,
    )
  }

  context.strokeStyle = RULE_COLOR
  context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height)
}

function paintItem(context: Canvas2DContext, item: SyntheticPageItem, itemIndex: number): void {
  switch (item.kind) {
    case 'text': {
      const inkAlpha = item.blockKind === 'paragraph' || item.blockKind === 'caption' ? 0.86 : 0.95
      item.lines.forEach((line, lineIndex) => {
        paintTextLine(context, line, inkAlpha, (itemIndex + 1) * 7919 + lineIndex * 104_729)
      })
      break
    }

    case 'table': {
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

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
          const fraction = item.cellTextFractions[rowIndex * columnCount + columnIndex]
          const cellLeft = item.columnEdges[columnIndex]
          const cellWidth = item.columnEdges[columnIndex + 1] - cellLeft
          const cellTop = item.rowEdges[rowIndex]
          const cellHeight = item.rowEdges[rowIndex + 1] - cellTop
          const textHeight = Math.min(18, cellHeight * 0.42)
          context.fillStyle = `rgba(${INK_COLOR}, ${rowIndex < item.headerRowCount ? 0.9 : 0.78})`
          context.fillRect(
            cellLeft + 10,
            cellTop + (cellHeight - textHeight) / 2,
            Math.max(6, (cellWidth - 20) * fraction),
            textHeight,
          )
        }
      }
      break
    }

    case 'keyValue': {
      paintTextLine(
        context,
        { bounds: item.keyBounds, wordWidths: item.keyWordWidths, glyphHeight: item.keyBounds.height },
        0.95,
        (itemIndex + 1) * 15_485_863,
      )
      paintTextLine(
        context,
        {
          bounds: item.valueBounds,
          wordWidths: item.valueWordWidths,
          glyphHeight: item.valueBounds.height,
        },
        0.8,
        (itemIndex + 1) * 32_452_843,
      )
      break
    }

    case 'figure': {
      paintFigure(context, item.bounds, item.figureSeed)
      break
    }
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

  content.items.forEach((item, itemIndex) => {
    if (rectsIntersect(item.bounds, sourceBounds)) {
      paintItem(context, item, itemIndex)
    }
  })

  context.setTransform(1, 0, 0, 1, 0, 0)
}

export const FULL_PAGE_BOUNDS: Rect = {
  x: 0,
  y: 0,
  width: PAGE_WIDTH_IN_WORLD_UNITS,
  height: PAGE_HEIGHT_IN_WORLD_UNITS,
}

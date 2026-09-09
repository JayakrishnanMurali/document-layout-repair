import type { SyntheticPageContent, SyntheticPageItem } from '../synthetic/pageContentGenerator.js'
import { createRandomSource, derivePageSeed, type RandomSource } from '../synthetic/randomSource.js'
import type {
  ExtractionBoxPayload,
  ExtractionTablePayload,
  PageExtractionPayload,
} from './extractionPayload.js'

/**
 * Turns synthetic page content into the extraction payload an upstream model would emit.
 *
 * This is what makes the demo honest: the boxes are derived from the same geometry the
 * rasterizer prints, and the confidences carry the same kind of noise a real model does,
 * so the low-confidence highlighting in the workspace has something real to point at.
 */

const LOW_CONFIDENCE_PROBABILITY = 0.07

function drawConfidence(random: RandomSource): number {
  return random.nextBoolean(LOW_CONFIDENCE_PROBABILITY)
    ? random.nextInRange(0.41, 0.74)
    : random.nextInRange(0.86, 0.999)
}

function joinWords(words: { text: string }[]): string {
  return words.map((word) => word.text).join(' ')
}

function appendTextItemBoxes(
  boxes: ExtractionBoxPayload[],
  random: RandomSource,
  item: Extract<SyntheticPageItem, { kind: 'text' }>,
  blockId: string,
): void {
  const lineTexts = item.lines.map((line) => joinWords(line.words))

  boxes.push({
    id: blockId,
    parentId: null,
    type: item.styleName === 'title' ? 'title' : item.styleName,
    bbox: [item.bounds.x, item.bounds.y, item.bounds.width, item.bounds.height],
    confidence: drawConfidence(random),
    text: lineTexts.join(' '),
  })

  item.lines.forEach((line, lineIndex) => {
    boxes.push({
      id: `${blockId}-l${lineIndex}`,
      parentId: blockId,
      type: 'line',
      bbox: [line.bounds.x, line.bounds.y, line.bounds.width, line.bounds.height],
      confidence: drawConfidence(random),
      text: lineTexts[lineIndex],
    })
  })
}

function appendTableBoxes(
  boxes: ExtractionBoxPayload[],
  tables: ExtractionTablePayload[],
  random: RandomSource,
  item: Extract<SyntheticPageItem, { kind: 'table' }>,
  blockId: string,
): void {
  boxes.push({
    id: blockId,
    parentId: null,
    type: 'table',
    bbox: [item.bounds.x, item.bounds.y, item.bounds.width, item.bounds.height],
    confidence: drawConfidence(random),
  })

  tables.push({
    id: blockId,
    columnEdges: [...item.columnEdges],
    rowEdges: [...item.rowEdges],
    headerRowCount: item.headerRowCount,
  })

  const rowCount = item.rowEdges.length - 1
  const columnCount = item.columnEdges.length - 1

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const left = item.columnEdges[columnIndex]
      const top = item.rowEdges[rowIndex]
      boxes.push({
        id: `${blockId}-c${rowIndex}-${columnIndex}`,
        parentId: blockId,
        type: 'tableCell',
        bbox: [
          left,
          top,
          item.columnEdges[columnIndex + 1] - left,
          item.rowEdges[rowIndex + 1] - top,
        ],
        confidence: drawConfidence(random),
        text: item.cellTexts[rowIndex * columnCount + columnIndex],
        cell: {
          tableId: blockId,
          rowIndex,
          columnIndex,
          rowSpan: 1,
          columnSpan: 1,
        },
      })
    }
  }
}

function appendKeyValueBoxes(
  boxes: ExtractionBoxPayload[],
  random: RandomSource,
  item: Extract<SyntheticPageItem, { kind: 'keyValue' }>,
  blockId: string,
): void {
  boxes.push({
    id: blockId,
    parentId: null,
    type: 'keyValuePair',
    bbox: [item.bounds.x, item.bounds.y, item.bounds.width, item.bounds.height],
    confidence: drawConfidence(random),
    text: `${item.keyText}: ${item.valueText}`,
  })
  boxes.push({
    id: `${blockId}-k`,
    parentId: blockId,
    type: 'keyLabel',
    bbox: [item.keyBounds.x, item.keyBounds.y, item.keyBounds.width, item.keyBounds.height],
    confidence: drawConfidence(random),
    text: item.keyText,
  })
  boxes.push({
    id: `${blockId}-v`,
    parentId: blockId,
    type: 'valueField',
    bbox: [item.valueBounds.x, item.valueBounds.y, item.valueBounds.width, item.valueBounds.height],
    confidence: drawConfidence(random),
    text: item.valueText,
  })
}

export function buildPageExtractionPayload(
  content: SyntheticPageContent,
  documentSeed: number,
): PageExtractionPayload {
  const random = createRandomSource(derivePageSeed(documentSeed ^ 0x5ca1ab1e, content.pageIndex))
  const boxes: ExtractionBoxPayload[] = []
  const tables: ExtractionTablePayload[] = []
  const readingOrder: string[] = []

  content.items.forEach((item, itemIndex) => {
    const blockId = `p${content.pageIndex}-b${itemIndex}`
    readingOrder.push(blockId)

    switch (item.kind) {
      case 'text':
        appendTextItemBoxes(boxes, random, item, blockId)
        break
      case 'table':
        appendTableBoxes(boxes, tables, random, item, blockId)
        break
      case 'keyValue':
        appendKeyValueBoxes(boxes, random, item, blockId)
        break
      case 'figure':
        boxes.push({
          id: blockId,
          parentId: null,
          type: 'figure',
          bbox: [item.bounds.x, item.bounds.y, item.bounds.width, item.bounds.height],
          confidence: drawConfidence(random),
        })
        break
    }
  })

  return {
    pageIndex: content.pageIndex,
    pageSize: {
      width: content.contentBounds.x * 2 + content.contentBounds.width,
      height: content.contentBounds.y * 2 + content.contentBounds.height,
    },
    boxes,
    tables,
    readingOrder,
  }
}

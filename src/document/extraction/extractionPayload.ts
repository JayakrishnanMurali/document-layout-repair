/**
 * Wire format of the extraction model's output — the JSON that arrives from the batch
 * endpoint or, page by page and out of order, over the live stream.
 *
 * It is deliberately string-keyed and page-local, exactly as a model would emit it. The
 * worker is what turns this into dense numeric buffers; nothing on the main thread ever
 * sees this shape in a hot path.
 */

export type ExtractionCellReference = {
  tableId: string
  rowIndex: number
  columnIndex: number
  rowSpan: number
  columnSpan: number
}

export type ExtractionBoxPayload = {
  id: string
  parentId: string | null
  type: string
  /** Page-local `[x, y, width, height]`, in page units. */
  bbox: [number, number, number, number]
  confidence: number
  text?: string
  cell?: ExtractionCellReference
}

export type ExtractionTablePayload = {
  id: string
  /** Page-local divider positions, ascending. */
  columnEdges: number[]
  rowEdges: number[]
  headerRowCount: number
}

export type PageExtractionPayload = {
  pageIndex: number
  pageSize: { width: number; height: number }
  boxes: ExtractionBoxPayload[]
  tables: ExtractionTablePayload[]
  /** Block-level box ids in reading order. */
  readingOrder: string[]
}

import { computePageBounds } from '@/document/pageLayout'
import {
  LOW_CONFIDENCE_THRESHOLD,
  NODE_FLAG_LOW_CONFIDENCE,
  getLayoutNodeClassId,
  type LayoutDocument,
  type LayoutGeometry,
  type LayoutNodeId,
  type PageNodeRange,
  type ReadingOrderSequence,
  type TableCellReference,
  type TableMesh,
} from '@/document/layoutTypes'
import type { PageExtractionPayload } from './extractionPayload'

const INITIAL_NODE_CAPACITY = 2048

type GrowableGeometry = LayoutGeometry & { capacity: number }

function createGeometry(capacity: number): GrowableGeometry {
  return {
    bounds: new Float32Array(capacity * 4),
    classIds: new Uint8Array(capacity),
    pageIndexes: new Uint16Array(capacity),
    parentIds: new Int32Array(capacity),
    confidences: new Float32Array(capacity),
    flags: new Uint8Array(capacity),
    nodeCount: 0,
    capacity,
  }
}

function growGeometry(geometry: GrowableGeometry, requiredCapacity: number): void {
  if (requiredCapacity <= geometry.capacity) {
    return
  }

  let nextCapacity = geometry.capacity
  while (nextCapacity < requiredCapacity) {
    nextCapacity *= 2
  }

  const grown = createGeometry(nextCapacity)
  grown.bounds.set(geometry.bounds)
  grown.classIds.set(geometry.classIds)
  grown.pageIndexes.set(geometry.pageIndexes)
  grown.parentIds.set(geometry.parentIds)
  grown.confidences.set(geometry.confidences)
  grown.flags.set(geometry.flags)

  geometry.bounds = grown.bounds
  geometry.classIds = grown.classIds
  geometry.pageIndexes = grown.pageIndexes
  geometry.parentIds = grown.parentIds
  geometry.confidences = grown.confidences
  geometry.flags = grown.flags
  geometry.capacity = nextCapacity
}

export type PageIngestResult = {
  pageIndex: number
  firstNodeId: LayoutNodeId
  nodeCount: number
}

/**
 * Normalizes string-keyed extraction payloads into the dense buffers the renderer reads.
 *
 * Pages are appended as they arrive — the live stream delivers them out of order — so
 * each page owns a contiguous half-open range of node ids. That range is what makes
 * viewport culling a bounded scan instead of a search: only the pages the camera
 * overlaps are ever visited.
 */
export class LayoutDocumentBuilder {
  private readonly geometry: GrowableGeometry = createGeometry(INITIAL_NODE_CAPACITY)
  private readonly texts: (string | null)[] = []
  private readonly sourceNodeIds: string[] = []
  private readonly childIdsByNodeId: LayoutNodeId[][] = []
  private readonly nodeIdsBySourceId = new Map<string, LayoutNodeId>()

  private readonly pageNodeRanges: PageNodeRange[]
  private readonly rootNodeIdsByPage: LayoutNodeId[][]
  private readonly readingOrderByPage: ReadingOrderSequence[]
  private readonly tableMeshesByPage: TableMesh[][]
  private readonly ingestedPageIndexes = new Set<number>()
  private readonly cellReferencesByTableSourceId = new Map<string, TableCellReference[]>()
  private readonly pageCount: number

  constructor(pageCount: number) {
    this.pageCount = pageCount
    this.pageNodeRanges = Array.from({ length: pageCount }, (_unused, pageIndex) => ({
      pageIndex,
      firstNodeId: 0,
      nodeCount: 0,
    }))
    this.rootNodeIdsByPage = Array.from({ length: pageCount }, () => [])
    this.readingOrderByPage = Array.from({ length: pageCount }, (_unused, pageIndex) => ({
      pageIndex,
      nodeIds: [],
    }))
    this.tableMeshesByPage = Array.from({ length: pageCount }, () => [])
  }

  get nodeCount(): number {
    return this.geometry.nodeCount
  }

  get ingestedPageCount(): number {
    return this.ingestedPageIndexes.size
  }

  hasPage(pageIndex: number): boolean {
    return this.ingestedPageIndexes.has(pageIndex)
  }

  ingestPage(payload: PageExtractionPayload): PageIngestResult {
    const { pageIndex } = payload
    if (pageIndex < 0 || pageIndex >= this.pageCount) {
      throw new Error(`Page ${pageIndex} is outside the document's ${this.pageCount} pages`)
    }
    if (this.ingestedPageIndexes.has(pageIndex)) {
      return {
        pageIndex,
        firstNodeId: this.pageNodeRanges[pageIndex].firstNodeId,
        nodeCount: this.pageNodeRanges[pageIndex].nodeCount,
      }
    }

    const pageBounds = computePageBounds(pageIndex)
    const firstNodeId = this.geometry.nodeCount
    growGeometry(this.geometry, firstNodeId + payload.boxes.length)

    for (const box of payload.boxes) {
      const nodeId = this.geometry.nodeCount
      const boundsOffset = nodeId * 4

      this.geometry.bounds[boundsOffset] = pageBounds.x + box.bbox[0]
      this.geometry.bounds[boundsOffset + 1] = pageBounds.y + box.bbox[1]
      this.geometry.bounds[boundsOffset + 2] = box.bbox[2]
      this.geometry.bounds[boundsOffset + 3] = box.bbox[3]
      this.geometry.classIds[nodeId] = getLayoutNodeClassId(box.type)
      this.geometry.pageIndexes[nodeId] = pageIndex
      this.geometry.parentIds[nodeId] = -1
      this.geometry.confidences[nodeId] = box.confidence
      this.geometry.flags[nodeId] =
        box.confidence < LOW_CONFIDENCE_THRESHOLD ? NODE_FLAG_LOW_CONFIDENCE : 0
      this.geometry.nodeCount = nodeId + 1

      this.texts.push(box.text ?? null)
      this.sourceNodeIds.push(box.id)
      this.childIdsByNodeId.push([])
      this.nodeIdsBySourceId.set(box.id, nodeId)

      if (box.cell) {
        const cellReferences = this.cellReferencesByTableSourceId.get(box.cell.tableId) ?? []
        cellReferences.push({
          nodeId,
          rowIndex: box.cell.rowIndex,
          columnIndex: box.cell.columnIndex,
          rowSpan: box.cell.rowSpan,
          columnSpan: box.cell.columnSpan,
        })
        this.cellReferencesByTableSourceId.set(box.cell.tableId, cellReferences)
      }
    }

    // Parents are resolved in a second pass: a payload may reference a parent that
    // appears later in the box list.
    for (let boxIndex = 0; boxIndex < payload.boxes.length; boxIndex += 1) {
      const box = payload.boxes[boxIndex]
      const nodeId = firstNodeId + boxIndex
      if (box.parentId === null) {
        this.rootNodeIdsByPage[pageIndex].push(nodeId)
        continue
      }

      const parentNodeId = this.nodeIdsBySourceId.get(box.parentId)
      if (parentNodeId === undefined) {
        this.rootNodeIdsByPage[pageIndex].push(nodeId)
        continue
      }

      this.geometry.parentIds[nodeId] = parentNodeId
      this.childIdsByNodeId[parentNodeId].push(nodeId)
    }

    this.readingOrderByPage[pageIndex] = {
      pageIndex,
      nodeIds: payload.readingOrder
        .map((sourceId) => this.nodeIdsBySourceId.get(sourceId))
        .filter((nodeId): nodeId is LayoutNodeId => nodeId !== undefined),
    }

    this.tableMeshesByPage[pageIndex] = payload.tables.map((table) =>
      this.buildTableMesh(table, pageIndex, pageBounds.x, pageBounds.y),
    )

    this.pageNodeRanges[pageIndex] = {
      pageIndex,
      firstNodeId,
      nodeCount: this.geometry.nodeCount - firstNodeId,
    }
    this.ingestedPageIndexes.add(pageIndex)

    return { pageIndex, firstNodeId, nodeCount: this.pageNodeRanges[pageIndex].nodeCount }
  }

  /** Live view of the document. The worker keeps this; the main thread gets a copy. */
  getDocument(): LayoutDocument {
    return {
      pageCount: this.pageCount,
      geometry: this.geometry,
      texts: this.texts,
      sourceNodeIds: this.sourceNodeIds,
      childIdsByNodeId: this.childIdsByNodeId,
      rootNodeIdsByPage: this.rootNodeIdsByPage,
      pageNodeRanges: this.pageNodeRanges,
      readingOrderByPage: this.readingOrderByPage,
      tableMeshesByPage: this.tableMeshesByPage,
    }
  }

  /**
   * Copies the geometry into exactly-sized buffers for transfer. The worker keeps its own
   * arrays because it still owns the spatial index; copying ~300 KB is cheaper than the
   * bookkeeping of shared ownership, and it happens once per load rather than per frame.
   */
  createGeometrySnapshot(): LayoutGeometry {
    const { nodeCount } = this.geometry
    return {
      bounds: this.geometry.bounds.slice(0, nodeCount * 4),
      classIds: this.geometry.classIds.slice(0, nodeCount),
      pageIndexes: this.geometry.pageIndexes.slice(0, nodeCount),
      parentIds: this.geometry.parentIds.slice(0, nodeCount),
      confidences: this.geometry.confidences.slice(0, nodeCount),
      flags: this.geometry.flags.slice(0, nodeCount),
      nodeCount,
    }
  }

  private buildTableMesh(
    table: { id: string; columnEdges: number[]; rowEdges: number[]; headerRowCount: number },
    pageIndex: number,
    pageOffsetX: number,
    pageOffsetY: number,
  ): TableMesh {
    return {
      tableNodeId: this.nodeIdsBySourceId.get(table.id) ?? -1,
      pageIndex,
      columnEdges: table.columnEdges.map((edge) => edge + pageOffsetX),
      rowEdges: table.rowEdges.map((edge) => edge + pageOffsetY),
      headerRowCount: table.headerRowCount,
      cells: this.cellReferencesByTableSourceId.get(table.id) ?? [],
    }
  }
}

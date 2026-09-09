import type { Rect } from '@/canvas/geometry'

export const LAYOUT_NODE_CLASSES = [
  'title',
  'heading',
  'paragraph',
  'line',
  'table',
  'tableCell',
  'keyValuePair',
  'keyLabel',
  'valueField',
  'figure',
  'caption',
] as const

export type LayoutNodeClass = (typeof LAYOUT_NODE_CLASSES)[number]

export type LayoutNodeClassId = number

const CLASS_IDS_BY_NAME = new Map<string, LayoutNodeClassId>(
  LAYOUT_NODE_CLASSES.map((className, classId) => [className, classId]),
)

export function getLayoutNodeClassId(className: string): LayoutNodeClassId {
  const classId = CLASS_IDS_BY_NAME.get(className)
  if (classId === undefined) {
    throw new Error(`Unknown layout node class: ${className}`)
  }
  return classId
}

export function getLayoutNodeClassName(classId: LayoutNodeClassId): LayoutNodeClass {
  return LAYOUT_NODE_CLASSES[classId] ?? 'paragraph'
}

/** Classes that carry their own reading-order position in the page sequence. */
export const BLOCK_LEVEL_CLASSES: ReadonlySet<LayoutNodeClass> = new Set([
  'title',
  'heading',
  'paragraph',
  'table',
  'keyValuePair',
  'figure',
  'caption',
])

export const NODE_FLAG_REMOVED = 1 << 0
export const NODE_FLAG_EDITED = 1 << 1
export const NODE_FLAG_LOW_CONFIDENCE = 1 << 2

export const LOW_CONFIDENCE_THRESHOLD = 0.75

/** Dense index into the geometry buffers. Stable for the lifetime of a document. */
export type LayoutNodeId = number

export const NO_LAYOUT_NODE_ID = -1

/**
 * Structure-of-arrays geometry for every extracted node.
 *
 * The renderer walks these buffers directly each frame, so the hot path never touches an
 * object graph: `bounds` holds `x, y, width, height` in world units at `nodeId * 4`.
 */
export type LayoutGeometry = {
  bounds: Float32Array
  classIds: Uint8Array
  pageIndexes: Uint16Array
  parentIds: Int32Array
  confidences: Float32Array
  flags: Uint8Array
  nodeCount: number
}

export function readNodeBounds(geometry: LayoutGeometry, nodeId: LayoutNodeId, target: Rect): Rect {
  const offset = nodeId * 4
  target.x = geometry.bounds[offset]
  target.y = geometry.bounds[offset + 1]
  target.width = geometry.bounds[offset + 2]
  target.height = geometry.bounds[offset + 3]
  return target
}

export function writeNodeBounds(
  geometry: LayoutGeometry,
  nodeId: LayoutNodeId,
  bounds: Rect,
): void {
  const offset = nodeId * 4
  geometry.bounds[offset] = bounds.x
  geometry.bounds[offset + 1] = bounds.y
  geometry.bounds[offset + 2] = bounds.width
  geometry.bounds[offset + 3] = bounds.height
}

export function getNodeArea(geometry: LayoutGeometry, nodeId: LayoutNodeId): number {
  const offset = nodeId * 4
  return geometry.bounds[offset + 2] * geometry.bounds[offset + 3]
}

/** Half-open, contiguous range of node ids belonging to one page. */
export type PageNodeRange = {
  pageIndex: number
  firstNodeId: LayoutNodeId
  nodeCount: number
}

export type TableCellReference = {
  nodeId: LayoutNodeId
  rowIndex: number
  columnIndex: number
  rowSpan: number
  columnSpan: number
}

/**
 * A table's editable mesh. Cells are derived from the divider positions, so dragging a
 * divider recalculates every affected cell rectangle from one source of truth.
 */
export type TableMesh = {
  tableNodeId: LayoutNodeId
  pageIndex: number
  /** World-space x positions, ascending; length is columnCount + 1. */
  columnEdges: number[]
  /** World-space y positions, ascending; length is rowCount + 1. */
  rowEdges: number[]
  headerRowCount: number
  cells: TableCellReference[]
}

export type ReadingOrderSequence = {
  pageIndex: number
  /** Block-level node ids in reading order. */
  nodeIds: LayoutNodeId[]
}

/**
 * The normalized document handed to the main thread. Geometry lives in typed arrays;
 * everything the UI reads occasionally (text, source ids, structure) stays in plain
 * arrays where readability matters more than cache locality.
 */
export type LayoutDocument = {
  pageCount: number
  geometry: LayoutGeometry
  texts: (string | null)[]
  sourceNodeIds: string[]
  childIdsByNodeId: LayoutNodeId[][]
  rootNodeIdsByPage: LayoutNodeId[][]
  /**
   * Contiguous node id spans per page.
   *
   * A page arrives as one span in a batch load, but the live stream can deliver it in
   * several chunks interleaved with other pages — so each page owns a list of spans.
   * Culling and rectangle queries walk these spans, which is what keeps them proportional
   * to what is on screen rather than to the size of the document.
   */
  nodeRangesByPage: PageNodeRange[][]
  readingOrderByPage: ReadingOrderSequence[]
  tableMeshesByPage: TableMesh[][]
}

export function getTableCellBounds(mesh: TableMesh, cell: TableCellReference): Rect {
  const left = mesh.columnEdges[cell.columnIndex]
  const right = mesh.columnEdges[Math.min(cell.columnIndex + cell.columnSpan, mesh.columnEdges.length - 1)]
  const top = mesh.rowEdges[cell.rowIndex]
  const bottom = mesh.rowEdges[Math.min(cell.rowIndex + cell.rowSpan, mesh.rowEdges.length - 1)]

  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function getPageNodeCount(layoutDocument: LayoutDocument, pageIndex: number): number {
  let nodeCount = 0
  for (const range of layoutDocument.nodeRangesByPage[pageIndex] ?? []) {
    nodeCount += range.nodeCount
  }
  return nodeCount
}

/**
 * Orders a page's table meshes by where they sit on the page.
 *
 * Stream chunks arrive in any order, so the arrival sequence is no basis for ordering.
 * Sorting by position keeps a page's meshes — and therefore anything serialized from
 * them — identical whether the document was loaded in one batch or streamed.
 */
export function sortTableMeshesByPosition(meshes: TableMesh[]): void {
  meshes.sort(
    (left, right) =>
      left.rowEdges[0] - right.rowEdges[0] || left.columnEdges[0] - right.columnEdges[0],
  )
}

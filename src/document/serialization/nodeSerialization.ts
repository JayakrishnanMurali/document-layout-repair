import {
  NODE_FLAG_EDITED,
  NODE_FLAG_REMOVED,
  getLayoutNodeClassName,
  type LayoutDocument,
  type LayoutNodeClass,
  type LayoutNodeId,
  type TableMesh,
} from '@/document/layoutTypes'
import { getPageBounds, type DocumentPageLayout } from '@/document/pageLayout'

export type SerializedLayoutNode = {
  id: string
  class: LayoutNodeClass
  page: number
  /** Page-local, matching the coordinate space the extraction model emits. */
  bounds: { x: number; y: number; width: number; height: number }
  confidence: number
  edited?: true
  text?: string
  cell?: { row: number; column: number; rowSpan: number; columnSpan: number }
  children?: SerializedLayoutNode[]
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10
}

function findCellReference(
  mesh: TableMesh | undefined,
  nodeId: LayoutNodeId,
): SerializedLayoutNode['cell'] {
  const cell = mesh?.cells.find((candidate) => candidate.nodeId === nodeId)
  return cell
    ? {
        row: cell.rowIndex,
        column: cell.columnIndex,
        rowSpan: cell.rowSpan,
        columnSpan: cell.columnSpan,
      }
    : undefined
}

/**
 * Serializes a node and its descendants back into the shape the extraction model emits.
 *
 * The JSON pane is the reviewer's ground truth for what will be exported, so it reports
 * page-local coordinates and the edited flag rather than the renderer's world space.
 */
export function serializeNodeSubtree(
  layoutDocument: LayoutDocument,
  pageLayout: DocumentPageLayout,
  nodeId: LayoutNodeId,
): SerializedLayoutNode | null {
  const { geometry } = layoutDocument
  if (nodeId < 0 || nodeId >= geometry.nodeCount) {
    return null
  }
  if ((geometry.flags[nodeId] & NODE_FLAG_REMOVED) !== 0) {
    return null
  }

  const pageIndex = geometry.pageIndexes[nodeId]
  const pageBounds = getPageBounds(pageLayout, pageIndex)
  const boundsOffset = nodeId * 4
  const text = layoutDocument.texts[nodeId]
  const meshes = layoutDocument.tableMeshesByPage[pageIndex] ?? []

  const serialized: SerializedLayoutNode = {
    id: layoutDocument.sourceNodeIds[nodeId],
    class: getLayoutNodeClassName(geometry.classIds[nodeId]),
    page: pageIndex + 1,
    bounds: {
      x: roundToTenth(geometry.bounds[boundsOffset] - pageBounds.x),
      y: roundToTenth(geometry.bounds[boundsOffset + 1] - pageBounds.y),
      width: roundToTenth(geometry.bounds[boundsOffset + 2]),
      height: roundToTenth(geometry.bounds[boundsOffset + 3]),
    },
    confidence: Math.round(geometry.confidences[nodeId] * 1000) / 1000,
  }

  if ((geometry.flags[nodeId] & NODE_FLAG_EDITED) !== 0) {
    serialized.edited = true
  }
  if (text) {
    serialized.text = text
  }

  const parentId = geometry.parentIds[nodeId]
  const cell = findCellReference(
    meshes.find((mesh) => mesh.tableNodeId === parentId),
    nodeId,
  )
  if (cell) {
    serialized.cell = cell
  }

  const children = (layoutDocument.childIdsByNodeId[nodeId] ?? [])
    .map((childId) => serializeNodeSubtree(layoutDocument, pageLayout, childId))
    .filter((child): child is SerializedLayoutNode => child !== null)
  if (children.length > 0) {
    serialized.children = children
  }

  return serialized
}

export function serializePage(
  layoutDocument: LayoutDocument,
  pageLayout: DocumentPageLayout,
  pageIndex: number,
): { page: number; readingOrder: SerializedLayoutNode[] } {
  const rootNodeIds =
    layoutDocument.readingOrderByPage[pageIndex]?.nodeIds ??
    layoutDocument.rootNodeIdsByPage[pageIndex] ??
    []

  return {
    page: pageIndex + 1,
    readingOrder: rootNodeIds
      .map((nodeId) => serializeNodeSubtree(layoutDocument, pageLayout, nodeId))
      .filter((node): node is SerializedLayoutNode => node !== null),
  }
}

function findMeshForTable(
  layoutDocument: LayoutDocument,
  pageIndex: number,
  tableNodeId: LayoutNodeId,
): TableMesh | undefined {
  return layoutDocument.tableMeshesByPage[pageIndex]?.find(
    (mesh) => mesh.tableNodeId === tableNodeId,
  )
}

function renderTableAsMarkdown(
  layoutDocument: LayoutDocument,
  pageIndex: number,
  tableNodeId: LayoutNodeId,
): string {
  const mesh = findMeshForTable(layoutDocument, pageIndex, tableNodeId)
  if (!mesh) {
    return ''
  }

  const rowCount = mesh.rowEdges.length - 1
  const columnCount = mesh.columnEdges.length - 1
  const cellTexts: string[][] = Array.from({ length: rowCount }, () =>
    Array.from({ length: columnCount }, () => ''),
  )

  for (const cell of mesh.cells) {
    if ((layoutDocument.geometry.flags[cell.nodeId] & NODE_FLAG_REMOVED) !== 0) {
      continue
    }
    const row = cellTexts[cell.rowIndex]
    if (row) {
      row[cell.columnIndex] = (layoutDocument.texts[cell.nodeId] ?? '').replace(/\|/g, '\\|')
    }
  }

  const lines: string[] = []
  cellTexts.forEach((row, rowIndex) => {
    lines.push(`| ${row.join(' | ')} |`)
    if (rowIndex === mesh.headerRowCount - 1) {
      lines.push(`| ${row.map(() => '---').join(' | ')} |`)
    }
  })

  return lines.join('\n')
}

/**
 * Renders a node's subtree as Markdown.
 *
 * This is the reviewer's answer to "did the repair actually fix the document?" — reading
 * order, table shape and key-value pairing all show up here in a form that is obvious to
 * check, which a bounding-box overlay alone never is.
 */
export function serializeNodeAsMarkdown(
  layoutDocument: LayoutDocument,
  nodeId: LayoutNodeId,
): string {
  const { geometry } = layoutDocument
  if (nodeId < 0 || nodeId >= geometry.nodeCount) {
    return ''
  }
  if ((geometry.flags[nodeId] & NODE_FLAG_REMOVED) !== 0) {
    return ''
  }

  const pageIndex = geometry.pageIndexes[nodeId]
  const className = getLayoutNodeClassName(geometry.classIds[nodeId])
  const text = layoutDocument.texts[nodeId] ?? ''

  switch (className) {
    case 'title':
      return `# ${text}`
    case 'heading':
      return `## ${text}`
    case 'caption':
      return `_${text}_`
    case 'figure':
      return '_[figure]_'
    case 'table':
      return renderTableAsMarkdown(layoutDocument, pageIndex, nodeId)
    case 'keyValuePair': {
      const [keyNodeId, valueNodeId] = layoutDocument.childIdsByNodeId[nodeId] ?? []
      const key = keyNodeId === undefined ? '' : (layoutDocument.texts[keyNodeId] ?? '')
      const value = valueNodeId === undefined ? '' : (layoutDocument.texts[valueNodeId] ?? '')
      return `- **${key}**: ${value}`
    }
    default:
      return text
  }
}

export function serializePageAsMarkdown(
  layoutDocument: LayoutDocument,
  pageIndex: number,
): string {
  const rootNodeIds =
    layoutDocument.readingOrderByPage[pageIndex]?.nodeIds ??
    layoutDocument.rootNodeIdsByPage[pageIndex] ??
    []

  return rootNodeIds
    .map((nodeId) => serializeNodeAsMarkdown(layoutDocument, nodeId))
    .filter((block) => block.length > 0)
    .join('\n\n')
}

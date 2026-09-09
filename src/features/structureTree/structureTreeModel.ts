import {
  NODE_FLAG_REMOVED,
  getLayoutNodeClassName,
  type LayoutDocument,
  type LayoutNodeClass,
  type LayoutNodeId,
} from '@/document/layoutTypes'

export type StructureTreeRowKey = string

export type StructureTreeRow = {
  key: StructureTreeRowKey
  depth: number
  hasChildren: boolean
  isExpanded: boolean
  pageIndex: number
} & (
  | { kind: 'page'; nodeId: null; label: string; className: null; text: null }
  | {
      kind: 'node'
      nodeId: LayoutNodeId
      label: string
      className: LayoutNodeClass
      text: string | null
    }
)

export function getPageRowKey(pageIndex: number): StructureTreeRowKey {
  return `page:${pageIndex}`
}

export function getNodeRowKey(nodeId: LayoutNodeId): StructureTreeRowKey {
  return `node:${nodeId}`
}

function hasVisibleChildren(layoutDocument: LayoutDocument, nodeId: LayoutNodeId): boolean {
  for (const childId of layoutDocument.childIdsByNodeId[nodeId] ?? []) {
    if ((layoutDocument.geometry.flags[childId] & NODE_FLAG_REMOVED) === 0) {
      return true
    }
  }
  return false
}

/**
 * Flattens the document into the rows the tree currently shows.
 *
 * Only expanded branches contribute rows, so the list the virtualizer measures stays a
 * few hundred entries even for an 11,000-node document, and the window it renders stays
 * a few dozen.
 */
export function flattenStructureTree(
  layoutDocument: LayoutDocument | null,
  expandedRowKeys: ReadonlySet<StructureTreeRowKey>,
): StructureTreeRow[] {
  const rows: StructureTreeRow[] = []
  if (!layoutDocument) {
    return rows
  }

  for (let pageIndex = 0; pageIndex < layoutDocument.pageCount; pageIndex += 1) {
    // Reading order defines the tree's order, so re-sequencing the page re-orders it.
    const rootNodeIds =
      layoutDocument.readingOrderByPage[pageIndex]?.nodeIds ??
      layoutDocument.rootNodeIdsByPage[pageIndex] ??
      []
    const pageRowKey = getPageRowKey(pageIndex)
    const isPageExpanded = expandedRowKeys.has(pageRowKey)

    rows.push({
      kind: 'page',
      key: pageRowKey,
      nodeId: null,
      depth: 0,
      hasChildren: rootNodeIds.length > 0,
      isExpanded: isPageExpanded,
      pageIndex,
      label: `Page ${pageIndex + 1}`,
      className: null,
      text: null,
    })

    if (!isPageExpanded) {
      continue
    }

    for (const rootNodeId of rootNodeIds) {
      appendNodeRows(layoutDocument, rootNodeId, 1, pageIndex, expandedRowKeys, rows)
    }
  }

  return rows
}

function appendNodeRows(
  layoutDocument: LayoutDocument,
  nodeId: LayoutNodeId,
  depth: number,
  pageIndex: number,
  expandedRowKeys: ReadonlySet<StructureTreeRowKey>,
  rows: StructureTreeRow[],
): void {
  if ((layoutDocument.geometry.flags[nodeId] & NODE_FLAG_REMOVED) !== 0) {
    return
  }

  const rowKey = getNodeRowKey(nodeId)
  const hasChildren = hasVisibleChildren(layoutDocument, nodeId)
  const isExpanded = hasChildren && expandedRowKeys.has(rowKey)
  const className = getLayoutNodeClassName(layoutDocument.geometry.classIds[nodeId])

  rows.push({
    kind: 'node',
    key: rowKey,
    nodeId,
    depth,
    hasChildren,
    isExpanded,
    pageIndex,
    label: className,
    className,
    text: layoutDocument.texts[nodeId],
  })

  if (!isExpanded) {
    return
  }

  for (const childId of layoutDocument.childIdsByNodeId[nodeId] ?? []) {
    appendNodeRows(layoutDocument, childId, depth + 1, pageIndex, expandedRowKeys, rows)
  }
}

/**
 * Row keys that must be expanded for a node to be visible: its page and every ancestor.
 * This is what lets a click on the canvas reveal the matching row in the tree.
 */
export function collectAncestorRowKeys(
  layoutDocument: LayoutDocument,
  nodeId: LayoutNodeId,
): StructureTreeRowKey[] {
  if (nodeId < 0 || nodeId >= layoutDocument.geometry.nodeCount) {
    return []
  }

  const keys: StructureTreeRowKey[] = [getPageRowKey(layoutDocument.geometry.pageIndexes[nodeId])]
  let ancestorId = layoutDocument.geometry.parentIds[nodeId]

  while (ancestorId >= 0) {
    keys.push(getNodeRowKey(ancestorId))
    ancestorId = layoutDocument.geometry.parentIds[ancestorId]
  }

  return keys
}

export function findRowIndexByKey(
  rows: readonly StructureTreeRow[],
  rowKey: StructureTreeRowKey,
): number {
  return rows.findIndex((row) => row.key === rowKey)
}

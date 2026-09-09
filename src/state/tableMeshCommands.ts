import type { Rect } from '@/canvas/geometry'
import {
  readNodeBounds,
  type LayoutDocument,
  type LayoutNodeId,
  type TableMesh,
} from '@/document/layoutTypes'
import {
  createCellNodeRecord,
  findMeshForCell,
  planCellMerge,
  planCellUnmerge,
  planDividerInsertion,
  withMovedDivider,
  type DividerReference,
  type TableMeshAxis,
} from '@/document/tableMesh'
import type { LayoutMutation } from './history/layoutMutations'
import type { LayoutEditor } from './LayoutEditor'

/**
 * Table mesh edits, expressed as transactions.
 *
 * Each one is a single undo step, and each is ordered so the document is never left with
 * cell rectangles derived from a grid they do not belong to: nodes are created before the
 * mesh that sizes them, and cells are hidden only after the mesh has been reshaped.
 */

const boundsScratch: Rect = { x: 0, y: 0, width: 0, height: 0 }

function buildMeshMutation(mesh: TableMesh, edges: { columnEdges: number[]; rowEdges: number[] }, cells = mesh.cells): LayoutMutation {
  return {
    kind: 'setTableMesh',
    pageIndex: mesh.pageIndex,
    tableNodeId: mesh.tableNodeId,
    columnEdges: edges.columnEdges,
    rowEdges: edges.rowEdges,
    cells: cells.map((cell) => ({ ...cell })),
  }
}

/** Applies a divider drag inside an open gesture, so the whole drag is one undo step. */
export function applyDividerDrag(
  editor: LayoutEditor,
  mesh: TableMesh,
  divider: DividerReference,
  requestedPosition: number,
): void {
  editor.applyInGesture([buildMeshMutation(mesh, withMovedDivider(mesh, divider, requestedPosition))])
}

export function splitTableCell(
  editor: LayoutEditor,
  cellNodeId: LayoutNodeId,
  axis: TableMeshAxis,
): boolean {
  const layoutDocument = editor.getDocument()
  if (!layoutDocument) {
    return false
  }

  const mesh = findMeshForCell(layoutDocument, cellNodeId)
  if (!mesh) {
    return false
  }

  const cellBounds = readNodeBounds(layoutDocument.geometry, cellNodeId, boundsScratch)
  const splitPosition =
    axis === 'column' ? cellBounds.x + cellBounds.width / 2 : cellBounds.y + cellBounds.height / 2

  const plan = planDividerInsertion(
    layoutDocument,
    mesh,
    axis,
    splitPosition,
    layoutDocument.geometry.nodeCount,
  )
  if (!plan) {
    return false
  }

  const edges = { columnEdges: plan.columnEdges, rowEdges: plan.rowEdges }
  const mutations: LayoutMutation[] = plan.createdCells.map((cell) => ({
    kind: 'setNodeRecord',
    record: createCellNodeRecord(layoutDocument, mesh, edges, cell),
  }))
  mutations.push(buildMeshMutation(mesh, edges, plan.cells))

  editor.commit(axis === 'column' ? 'Split cell into columns' : 'Split cell into rows', mutations)
  return true
}

export function mergeTableCells(
  editor: LayoutEditor,
  cellNodeIds: readonly LayoutNodeId[],
): boolean {
  const layoutDocument = editor.getDocument()
  if (!layoutDocument || cellNodeIds.length < 2) {
    return false
  }

  const mesh = findMeshForCell(layoutDocument, cellNodeIds[0])
  if (!mesh) {
    return false
  }

  const plan = planCellMerge(layoutDocument, mesh, cellNodeIds)
  if (!plan) {
    return false
  }

  const mutations: LayoutMutation[] = [
    buildMeshMutation(mesh, { columnEdges: mesh.columnEdges, rowEdges: mesh.rowEdges }, plan.cells),
    // The merged cell has to carry the text of everything it now covers, or the merge
    // would silently drop content from the extraction.
    {
      kind: 'setNodeText',
      nodeId: plan.anchorNodeId,
      text: mergeCellText(layoutDocument, plan.anchorNodeId, plan.hiddenNodeIds),
    },
    ...plan.hiddenNodeIds.map(
      (nodeId): LayoutMutation => ({ kind: 'setNodePresence', nodeId, isPresent: false }),
    ),
  ]

  editor.commit(`Merge ${plan.hiddenNodeIds.length + 1} cells`, mutations)
  editor.selectNode(plan.anchorNodeId, 'replace')
  return true
}

export function unmergeTableCell(editor: LayoutEditor, cellNodeId: LayoutNodeId): boolean {
  const layoutDocument = editor.getDocument()
  if (!layoutDocument) {
    return false
  }

  const mesh = findMeshForCell(layoutDocument, cellNodeId)
  if (!mesh) {
    return false
  }

  const plan = planCellUnmerge(layoutDocument, mesh, cellNodeId)
  if (!plan) {
    return false
  }

  const mutations: LayoutMutation[] = [
    ...plan.restoredNodeIds.map(
      (nodeId): LayoutMutation => ({ kind: 'setNodePresence', nodeId, isPresent: true }),
    ),
    buildMeshMutation(mesh, { columnEdges: mesh.columnEdges, rowEdges: mesh.rowEdges }, plan.cells),
  ]

  editor.commit(`Unmerge cell into ${plan.restoredNodeIds.length + 1}`, mutations)
  return true
}

/** All selected nodes that are cells of the same mesh, in mesh order. */
export function collectSelectedCellNodeIds(
  layoutDocument: LayoutDocument,
  selectedNodeIds: readonly LayoutNodeId[],
): { mesh: TableMesh; cellNodeIds: LayoutNodeId[] } | null {
  for (const nodeId of selectedNodeIds) {
    const mesh = findMeshForCell(layoutDocument, nodeId)
    if (!mesh) {
      continue
    }

    const selectedSet = new Set(selectedNodeIds)
    const cellNodeIds = mesh.cells
      .filter((cell) => selectedSet.has(cell.nodeId))
      .map((cell) => cell.nodeId)
    if (cellNodeIds.length > 0) {
      return { mesh, cellNodeIds }
    }
  }

  return null
}

/**
 * Text of a merged cell: the anchor's own text followed by the text of every cell it
 * swallows, in reading order. The hidden cells keep their own text, so undoing the merge
 * restores every fragment where it came from.
 */
function mergeCellText(
  layoutDocument: LayoutDocument,
  anchorNodeId: LayoutNodeId,
  hiddenNodeIds: readonly LayoutNodeId[],
): string | null {
  const fragments = [anchorNodeId, ...hiddenNodeIds]
    .sort((left, right) => left - right)
    .map((nodeId) => layoutDocument.texts[nodeId])
    .filter((text): text is string => Boolean(text))

  return fragments.length > 0 ? fragments.join(' ') : null
}

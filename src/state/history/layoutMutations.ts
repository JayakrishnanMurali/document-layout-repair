import type { Rect } from '@/canvas/geometry'
import {
  NODE_FLAG_EDITED,
  NODE_FLAG_REMOVED,
  getTableCellBounds,
  readNodeBounds,
  writeNodeBounds,
  type LayoutDocument,
  type LayoutNodeId,
  type TableCellReference,
  type TableMesh,
} from '@/document/layoutTypes'

/**
 * Every change a reviewer can make to the layout, expressed as a small invertible patch.
 *
 * Snapshotting an 11,000-node document per keystroke would be unusable, so history is
 * built from patches instead: applying a mutation returns the mutation that undoes it,
 * and a transaction is just the two lists. Geometry stays in its typed arrays and the
 * undo stack stays proportional to what actually changed.
 */
export type LayoutMutation =
  | { kind: 'setNodeBounds'; nodeId: LayoutNodeId; bounds: Rect }
  | { kind: 'setNodeClass'; nodeId: LayoutNodeId; classId: number }
  | { kind: 'setNodeFlags'; nodeId: LayoutNodeId; flags: number }
  | { kind: 'setNodePresence'; nodeId: LayoutNodeId; isPresent: boolean }
  | { kind: 'setReadingOrder'; pageIndex: number; nodeIds: LayoutNodeId[] }
  | {
      kind: 'setTableMeshEdges'
      pageIndex: number
      tableNodeId: LayoutNodeId
      columnEdges: number[]
      rowEdges: number[]
    }
  | {
      kind: 'setTableMeshCells'
      pageIndex: number
      tableNodeId: LayoutNodeId
      cells: TableCellReference[]
    }

/**
 * Identity of what a mutation touches. Used to coalesce a drag into one undo step: the
 * first inverse captured per key is the one that restores the pre-gesture state.
 */
export function getMutationKey(mutation: LayoutMutation): string {
  switch (mutation.kind) {
    case 'setNodeBounds':
      return `bounds:${mutation.nodeId}`
    case 'setNodeClass':
      return `class:${mutation.nodeId}`
    case 'setNodeFlags':
      return `flags:${mutation.nodeId}`
    case 'setNodePresence':
      return `presence:${mutation.nodeId}`
    case 'setReadingOrder':
      return `readingOrder:${mutation.pageIndex}`
    case 'setTableMeshEdges':
      return `tableEdges:${mutation.tableNodeId}`
    case 'setTableMeshCells':
      return `tableCells:${mutation.tableNodeId}`
  }
}

export function findTableMesh(
  layoutDocument: LayoutDocument,
  pageIndex: number,
  tableNodeId: LayoutNodeId,
): TableMesh | null {
  const meshes = layoutDocument.tableMeshesByPage[pageIndex]
  if (!meshes) {
    return null
  }
  return meshes.find((mesh) => mesh.tableNodeId === tableNodeId) ?? null
}

/** Rewrites the table node and every cell rectangle from the mesh's divider positions. */
export function syncTableMeshGeometry(layoutDocument: LayoutDocument, mesh: TableMesh): void {
  const firstColumnEdge = mesh.columnEdges[0]
  const lastColumnEdge = mesh.columnEdges[mesh.columnEdges.length - 1]
  const firstRowEdge = mesh.rowEdges[0]
  const lastRowEdge = mesh.rowEdges[mesh.rowEdges.length - 1]

  writeNodeBounds(layoutDocument.geometry, mesh.tableNodeId, {
    x: firstColumnEdge,
    y: firstRowEdge,
    width: lastColumnEdge - firstColumnEdge,
    height: lastRowEdge - firstRowEdge,
  })

  for (const cell of mesh.cells) {
    writeNodeBounds(layoutDocument.geometry, cell.nodeId, getTableCellBounds(mesh, cell))
  }
}

const boundsScratch: Rect = { x: 0, y: 0, width: 0, height: 0 }

/**
 * Applies one mutation and returns the mutation that reverses it.
 *
 * Throws for a mutation that cannot be applied, rather than silently diverging: a
 * history stack whose inverses do not match the document is worse than a loud failure.
 */
export function applyLayoutMutation(
  layoutDocument: LayoutDocument,
  mutation: LayoutMutation,
): LayoutMutation {
  const { geometry } = layoutDocument

  switch (mutation.kind) {
    case 'setNodeBounds': {
      readNodeBounds(geometry, mutation.nodeId, boundsScratch)
      const inverse: LayoutMutation = {
        kind: 'setNodeBounds',
        nodeId: mutation.nodeId,
        bounds: { ...boundsScratch },
      }
      writeNodeBounds(geometry, mutation.nodeId, mutation.bounds)
      geometry.flags[mutation.nodeId] |= NODE_FLAG_EDITED
      return inverse
    }

    case 'setNodeClass': {
      const inverse: LayoutMutation = {
        kind: 'setNodeClass',
        nodeId: mutation.nodeId,
        classId: geometry.classIds[mutation.nodeId],
      }
      geometry.classIds[mutation.nodeId] = mutation.classId
      geometry.flags[mutation.nodeId] |= NODE_FLAG_EDITED
      return inverse
    }

    case 'setNodeFlags': {
      const inverse: LayoutMutation = {
        kind: 'setNodeFlags',
        nodeId: mutation.nodeId,
        flags: geometry.flags[mutation.nodeId],
      }
      geometry.flags[mutation.nodeId] = mutation.flags
      return inverse
    }

    case 'setNodePresence': {
      const wasPresent = (geometry.flags[mutation.nodeId] & NODE_FLAG_REMOVED) === 0
      const inverse: LayoutMutation = {
        kind: 'setNodePresence',
        nodeId: mutation.nodeId,
        isPresent: wasPresent,
      }
      if (mutation.isPresent) {
        geometry.flags[mutation.nodeId] &= ~NODE_FLAG_REMOVED
      } else {
        geometry.flags[mutation.nodeId] |= NODE_FLAG_REMOVED
      }
      geometry.flags[mutation.nodeId] |= NODE_FLAG_EDITED
      return inverse
    }

    case 'setReadingOrder': {
      const sequence = layoutDocument.readingOrderByPage[mutation.pageIndex]
      if (!sequence) {
        throw new Error(`Page ${mutation.pageIndex} has no reading order to replace`)
      }
      const inverse: LayoutMutation = {
        kind: 'setReadingOrder',
        pageIndex: mutation.pageIndex,
        nodeIds: [...sequence.nodeIds],
      }
      sequence.nodeIds = [...mutation.nodeIds]
      return inverse
    }

    case 'setTableMeshEdges': {
      const mesh = findTableMesh(layoutDocument, mutation.pageIndex, mutation.tableNodeId)
      if (!mesh) {
        throw new Error(`No table mesh for node ${mutation.tableNodeId}`)
      }
      const inverse: LayoutMutation = {
        kind: 'setTableMeshEdges',
        pageIndex: mutation.pageIndex,
        tableNodeId: mutation.tableNodeId,
        columnEdges: [...mesh.columnEdges],
        rowEdges: [...mesh.rowEdges],
      }
      mesh.columnEdges = [...mutation.columnEdges]
      mesh.rowEdges = [...mutation.rowEdges]
      syncTableMeshGeometry(layoutDocument, mesh)
      geometry.flags[mutation.tableNodeId] |= NODE_FLAG_EDITED
      return inverse
    }

    case 'setTableMeshCells': {
      const mesh = findTableMesh(layoutDocument, mutation.pageIndex, mutation.tableNodeId)
      if (!mesh) {
        throw new Error(`No table mesh for node ${mutation.tableNodeId}`)
      }
      const inverse: LayoutMutation = {
        kind: 'setTableMeshCells',
        pageIndex: mutation.pageIndex,
        tableNodeId: mutation.tableNodeId,
        cells: mesh.cells.map((cell) => ({ ...cell })),
      }
      mesh.cells = mutation.cells.map((cell) => ({ ...cell }))
      syncTableMeshGeometry(layoutDocument, mesh)
      geometry.flags[mutation.tableNodeId] |= NODE_FLAG_EDITED
      return inverse
    }
  }
}

/** Node ids whose geometry a mutation can move, for re-indexing and repainting. */
export function collectAffectedNodeIds(
  layoutDocument: LayoutDocument,
  mutations: readonly LayoutMutation[],
  results: Set<LayoutNodeId>,
): Set<LayoutNodeId> {
  for (const mutation of mutations) {
    switch (mutation.kind) {
      case 'setNodeBounds':
      case 'setNodeClass':
      case 'setNodeFlags':
      case 'setNodePresence':
        results.add(mutation.nodeId)
        break

      case 'setReadingOrder':
        break

      case 'setTableMeshEdges':
      case 'setTableMeshCells': {
        results.add(mutation.tableNodeId)
        const mesh = findTableMesh(layoutDocument, mutation.pageIndex, mutation.tableNodeId)
        for (const cell of mesh?.cells ?? []) {
          results.add(cell.nodeId)
        }
        break
      }
    }
  }

  return results
}

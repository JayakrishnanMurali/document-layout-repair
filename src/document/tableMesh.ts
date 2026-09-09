import type { Point, Rect } from '@/canvas/geometry'
import {
  NODE_FLAG_REMOVED,
  getLayoutNodeClassId,
  getTableCellBounds,
  type LayoutDocument,
  type LayoutNodeId,
  type TableCellReference,
  type TableMesh,
} from './layoutTypes'
import type { LayoutNodeRecord } from '@/state/history/layoutMutations'

export type TableMeshAxis = 'column' | 'row'

/** A divider can never be dragged closer than this to its neighbour. */
export const MINIMUM_CELL_SIZE_IN_WORLD_UNITS = 14

export type DividerReference = { axis: TableMeshAxis; dividerIndex: number }

export function getMeshEdges(mesh: TableMesh, axis: TableMeshAxis): number[] {
  return axis === 'column' ? mesh.columnEdges : mesh.rowEdges
}

export function getMeshRowCount(mesh: TableMesh): number {
  return mesh.rowEdges.length - 1
}

export function getMeshColumnCount(mesh: TableMesh): number {
  return mesh.columnEdges.length - 1
}

export function isCellPresent(layoutDocument: LayoutDocument, cell: TableCellReference): boolean {
  return (layoutDocument.geometry.flags[cell.nodeId] & NODE_FLAG_REMOVED) === 0
}

export function findCellByNodeId(
  mesh: TableMesh,
  nodeId: LayoutNodeId,
): TableCellReference | undefined {
  return mesh.cells.find((cell) => cell.nodeId === nodeId)
}

export function findMeshForCell(
  layoutDocument: LayoutDocument,
  nodeId: LayoutNodeId,
): TableMesh | null {
  const pageIndex = layoutDocument.geometry.pageIndexes[nodeId]
  for (const mesh of layoutDocument.tableMeshesByPage[pageIndex] ?? []) {
    if (mesh.tableNodeId === nodeId || findCellByNodeId(mesh, nodeId)) {
      return mesh
    }
  }
  return null
}

/**
 * The interior dividers of a mesh, excluding its outer border.
 *
 * Only interior dividers are draggable: moving the outer edge would resize the table
 * rather than redistribute its cells, which is what the box editor is for.
 */
export function getInteriorDividerIndexes(mesh: TableMesh, axis: TableMeshAxis): number[] {
  const edges = getMeshEdges(mesh, axis)
  const indexes: number[] = []
  for (let dividerIndex = 1; dividerIndex < edges.length - 1; dividerIndex += 1) {
    indexes.push(dividerIndex)
  }
  return indexes
}

/**
 * Grab tolerance for one divider, never more than a third of either neighbouring track.
 *
 * Table rows are often only a dozen screen pixels tall, and a fixed tolerance would make
 * every divider's grab zone overlap its neighbour's — leaving no part of a cell that
 * could be clicked to select it.
 */
function getDividerTolerance(
  edges: readonly number[],
  dividerIndex: number,
  maximumToleranceInWorldUnits: number,
): number {
  return Math.min(
    maximumToleranceInWorldUnits,
    (edges[dividerIndex] - edges[dividerIndex - 1]) / 3,
    (edges[dividerIndex + 1] - edges[dividerIndex]) / 3,
  )
}

export function findDividerAtWorldPoint(
  mesh: TableMesh,
  worldPoint: Point,
  toleranceInWorldUnits: number,
): DividerReference | null {
  const tableTop = mesh.rowEdges[0]
  const tableBottom = mesh.rowEdges[mesh.rowEdges.length - 1]
  const tableLeft = mesh.columnEdges[0]
  const tableRight = mesh.columnEdges[mesh.columnEdges.length - 1]

  let best: DividerReference | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  if (worldPoint.y >= tableTop - toleranceInWorldUnits && worldPoint.y <= tableBottom + toleranceInWorldUnits) {
    for (const dividerIndex of getInteriorDividerIndexes(mesh, 'column')) {
      const tolerance = getDividerTolerance(mesh.columnEdges, dividerIndex, toleranceInWorldUnits)
      const distance = Math.abs(mesh.columnEdges[dividerIndex] - worldPoint.x)
      if (distance <= tolerance && distance < bestDistance) {
        best = { axis: 'column', dividerIndex }
        bestDistance = distance
      }
    }
  }

  if (worldPoint.x >= tableLeft - toleranceInWorldUnits && worldPoint.x <= tableRight + toleranceInWorldUnits) {
    for (const dividerIndex of getInteriorDividerIndexes(mesh, 'row')) {
      const tolerance = getDividerTolerance(mesh.rowEdges, dividerIndex, toleranceInWorldUnits)
      const distance = Math.abs(mesh.rowEdges[dividerIndex] - worldPoint.y)
      if (distance <= tolerance && distance < bestDistance) {
        best = { axis: 'row', dividerIndex }
        bestDistance = distance
      }
    }
  }

  return best
}

export function clampDividerPosition(
  mesh: TableMesh,
  divider: DividerReference,
  requestedPosition: number,
): number {
  const edges = getMeshEdges(mesh, divider.axis)
  return Math.min(
    Math.max(requestedPosition, edges[divider.dividerIndex - 1] + MINIMUM_CELL_SIZE_IN_WORLD_UNITS),
    edges[divider.dividerIndex + 1] - MINIMUM_CELL_SIZE_IN_WORLD_UNITS,
  )
}

export type MeshEdges = { columnEdges: number[]; rowEdges: number[] }

export function withMovedDivider(
  mesh: TableMesh,
  divider: DividerReference,
  requestedPosition: number,
): MeshEdges {
  const position = clampDividerPosition(mesh, divider, requestedPosition)
  const columnEdges = [...mesh.columnEdges]
  const rowEdges = [...mesh.rowEdges]

  if (divider.axis === 'column') {
    columnEdges[divider.dividerIndex] = position
  } else {
    rowEdges[divider.dividerIndex] = position
  }

  return { columnEdges, rowEdges }
}

export type CellMergePlan = {
  cells: TableCellReference[]
  anchorNodeId: LayoutNodeId
  hiddenNodeIds: LayoutNodeId[]
}

/**
 * Merges every cell in the rectangle spanned by the given cells.
 *
 * The top-left cell of the span becomes the merged cell and the rest are hidden; the
 * geometry of all of them is recalculated from the mesh, so the merged cell fills the
 * span exactly.
 */
export function planCellMerge(
  layoutDocument: LayoutDocument,
  mesh: TableMesh,
  cellNodeIds: readonly LayoutNodeId[],
): CellMergePlan | null {
  const selectedCells = cellNodeIds
    .map((nodeId) => findCellByNodeId(mesh, nodeId))
    .filter((cell): cell is TableCellReference => cell !== undefined)
  if (selectedCells.length < 2) {
    return null
  }

  let firstRow = Number.POSITIVE_INFINITY
  let lastRow = Number.NEGATIVE_INFINITY
  let firstColumn = Number.POSITIVE_INFINITY
  let lastColumn = Number.NEGATIVE_INFINITY

  for (const cell of selectedCells) {
    firstRow = Math.min(firstRow, cell.rowIndex)
    lastRow = Math.max(lastRow, cell.rowIndex + cell.rowSpan - 1)
    firstColumn = Math.min(firstColumn, cell.columnIndex)
    lastColumn = Math.max(lastColumn, cell.columnIndex + cell.columnSpan - 1)
  }

  const anchor = mesh.cells.find(
    (cell) => cell.rowIndex === firstRow && cell.columnIndex === firstColumn,
  )
  if (!anchor) {
    return null
  }

  const hiddenNodeIds: LayoutNodeId[] = []
  const cells = mesh.cells.map((cell) => {
    if (cell.nodeId === anchor.nodeId) {
      return {
        ...cell,
        rowSpan: lastRow - firstRow + 1,
        columnSpan: lastColumn - firstColumn + 1,
      }
    }

    const isInsideSpan =
      cell.rowIndex >= firstRow &&
      cell.rowIndex <= lastRow &&
      cell.columnIndex >= firstColumn &&
      cell.columnIndex <= lastColumn
    if (isInsideSpan && isCellPresent(layoutDocument, cell)) {
      hiddenNodeIds.push(cell.nodeId)
    }
    return { ...cell }
  })

  if (hiddenNodeIds.length === 0) {
    return null
  }

  return { cells, anchorNodeId: anchor.nodeId, hiddenNodeIds }
}

export type CellUnmergePlan = {
  cells: TableCellReference[]
  restoredNodeIds: LayoutNodeId[]
}

/**
 * Undoes a merge in place: the cell shrinks back to one row and column, and every hidden
 * cell inside its old span comes back.
 */
export function planCellUnmerge(
  layoutDocument: LayoutDocument,
  mesh: TableMesh,
  cellNodeId: LayoutNodeId,
): CellUnmergePlan | null {
  const mergedCell = findCellByNodeId(mesh, cellNodeId)
  if (!mergedCell || (mergedCell.rowSpan === 1 && mergedCell.columnSpan === 1)) {
    return null
  }

  const lastRow = mergedCell.rowIndex + mergedCell.rowSpan - 1
  const lastColumn = mergedCell.columnIndex + mergedCell.columnSpan - 1
  const restoredNodeIds: LayoutNodeId[] = []

  const cells = mesh.cells.map((cell) => {
    if (cell.nodeId === cellNodeId) {
      return { ...cell, rowSpan: 1, columnSpan: 1 }
    }

    const isInsideSpan =
      cell.rowIndex >= mergedCell.rowIndex &&
      cell.rowIndex <= lastRow &&
      cell.columnIndex >= mergedCell.columnIndex &&
      cell.columnIndex <= lastColumn
    if (isInsideSpan && !isCellPresent(layoutDocument, cell)) {
      restoredNodeIds.push(cell.nodeId)
    }
    return { ...cell }
  })

  return { cells, restoredNodeIds }
}

export type DividerInsertionPlan = {
  columnEdges: number[]
  rowEdges: number[]
  cells: TableCellReference[]
  /** Cells that did not exist before the split and have to be created. */
  createdCells: TableCellReference[]
}

/**
 * Splits a table by inserting a divider, which is what "split this cell" means on a mesh
 * with global dividers: the whole row or column is divided.
 *
 * Cells that straddle the new divider simply grow their span; cells that sit exactly on
 * it are split in two, so one new cell per affected row (or column) has to be created.
 */
export function planDividerInsertion(
  layoutDocument: LayoutDocument,
  mesh: TableMesh,
  axis: TableMeshAxis,
  position: number,
  firstNewNodeId: LayoutNodeId,
): DividerInsertionPlan | null {
  const edges = getMeshEdges(mesh, axis)

  let insertAfterIndex = -1
  for (let edgeIndex = 0; edgeIndex + 1 < edges.length; edgeIndex += 1) {
    if (position > edges[edgeIndex] && position < edges[edgeIndex + 1]) {
      insertAfterIndex = edgeIndex
      break
    }
  }
  if (insertAfterIndex < 0) {
    return null
  }
  if (
    position - edges[insertAfterIndex] < MINIMUM_CELL_SIZE_IN_WORLD_UNITS ||
    edges[insertAfterIndex + 1] - position < MINIMUM_CELL_SIZE_IN_WORLD_UNITS
  ) {
    return null
  }

  const nextEdges = [...edges.slice(0, insertAfterIndex + 1), position, ...edges.slice(insertAfterIndex + 1)]
  const newTrackIndex = insertAfterIndex + 1

  const cells: TableCellReference[] = []
  const createdCells: TableCellReference[] = []
  let nextNodeId = firstNewNodeId

  for (const cell of mesh.cells) {
    const trackIndex = axis === 'column' ? cell.columnIndex : cell.rowIndex
    const trackSpan = axis === 'column' ? cell.columnSpan : cell.rowSpan
    const lastTrackIndex = trackIndex + trackSpan - 1

    if (trackIndex >= newTrackIndex) {
      // Entirely after the new divider: shift along one track.
      cells.push(
        axis === 'column'
          ? { ...cell, columnIndex: cell.columnIndex + 1 }
          : { ...cell, rowIndex: cell.rowIndex + 1 },
      )
      continue
    }

    if (lastTrackIndex >= newTrackIndex) {
      // Straddles the new divider: it just covers one more track.
      cells.push(
        axis === 'column'
          ? { ...cell, columnSpan: cell.columnSpan + 1 }
          : { ...cell, rowSpan: cell.rowSpan + 1 },
      )
      continue
    }

    cells.push({ ...cell })

    const sitsOnDividedTrack = lastTrackIndex === newTrackIndex - 1
    if (!sitsOnDividedTrack || !isCellPresent(layoutDocument, cell)) {
      continue
    }

    const createdCell: TableCellReference =
      axis === 'column'
        ? {
            nodeId: nextNodeId,
            rowIndex: cell.rowIndex,
            columnIndex: newTrackIndex,
            rowSpan: cell.rowSpan,
            columnSpan: 1,
          }
        : {
            nodeId: nextNodeId,
            rowIndex: newTrackIndex,
            columnIndex: cell.columnIndex,
            rowSpan: 1,
            columnSpan: cell.columnSpan,
          }
    nextNodeId += 1
    cells.push(createdCell)
    createdCells.push(createdCell)
  }

  if (createdCells.length === 0) {
    return null
  }

  return {
    columnEdges: axis === 'column' ? nextEdges : [...mesh.columnEdges],
    rowEdges: axis === 'row' ? nextEdges : [...mesh.rowEdges],
    cells,
    createdCells,
  }
}

/** Builds the record for a cell created by a split, sized from the resulting mesh. */
export function createCellNodeRecord(
  layoutDocument: LayoutDocument,
  mesh: TableMesh,
  edges: MeshEdges,
  cell: TableCellReference,
): LayoutNodeRecord {
  const bounds: Rect = getTableCellBounds(
    { ...mesh, columnEdges: edges.columnEdges, rowEdges: edges.rowEdges },
    cell,
  )

  return {
    nodeId: cell.nodeId,
    classId: getLayoutNodeClassId('tableCell'),
    pageIndex: mesh.pageIndex,
    parentId: mesh.tableNodeId,
    bounds,
    confidence: 1,
    text: null,
    sourceId: `${layoutDocument.sourceNodeIds[mesh.tableNodeId]}-c${cell.rowIndex}-${cell.columnIndex}-split`,
  }
}

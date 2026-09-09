import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LayoutDocumentBuilder } from '@/document/extraction/LayoutDocumentBuilder'
import { buildPageExtractionPayload } from '@/document/extraction/payloadBuilder'
import {
  NODE_FLAG_REMOVED,
  getLayoutNodeClassName,
  getTableCellBounds,
  readNodeBounds,
  type LayoutDocument,
  type TableMesh,
} from '@/document/layoutTypes'
import { generateSyntheticPageContent } from '@/document/synthetic/pageContentGenerator'
import { LayoutEditor } from '@/state/LayoutEditor'
import {
  collectSelectedCellNodeIds,
  mergeTableCells,
  splitTableCell,
  unmergeTableCell,
} from '@/state/tableMeshCommands'
import {
  MINIMUM_CELL_SIZE_IN_WORLD_UNITS,
  clampDividerPosition,
  findDividerAtWorldPoint,
  getMeshColumnCount,
  getMeshRowCount,
  planCellMerge,
  planCellUnmerge,
  planDividerInsertion,
  withMovedDivider,
} from './tableMesh'

const PAGE_COUNT = 6
const DOCUMENT_SEED = 0x9a1

function buildDocument(): LayoutDocument {
  const builder = new LayoutDocumentBuilder(PAGE_COUNT)
  for (let pageIndex = 0; pageIndex < PAGE_COUNT; pageIndex += 1) {
    builder.ingestPage(
      buildPageExtractionPayload(
        generateSyntheticPageContent(pageIndex, DOCUMENT_SEED),
        DOCUMENT_SEED,
      ),
    )
  }
  return builder.getDocument()
}

function findFirstMesh(layoutDocument: LayoutDocument): TableMesh {
  for (const meshes of layoutDocument.tableMeshesByPage) {
    if (meshes.length > 0) {
      return meshes[0]
    }
  }
  throw new Error('The document has no tables')
}

/** Every present cell must tile its mesh exactly, with no gaps and no overlap. */
function expectCellsTileMesh(layoutDocument: LayoutDocument, mesh: TableMesh): void {
  const coverage = new Map<string, number>()

  for (const cell of mesh.cells) {
    if ((layoutDocument.geometry.flags[cell.nodeId] & NODE_FLAG_REMOVED) !== 0) {
      continue
    }

    const meshBounds = getTableCellBounds(mesh, cell)
    const nodeBounds = readNodeBounds(layoutDocument.geometry, cell.nodeId, {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    })
    expect(nodeBounds.x).toBeCloseTo(meshBounds.x, 2)
    expect(nodeBounds.y).toBeCloseTo(meshBounds.y, 2)
    expect(nodeBounds.width).toBeCloseTo(meshBounds.width, 2)
    expect(nodeBounds.height).toBeCloseTo(meshBounds.height, 2)

    for (let row = cell.rowIndex; row < cell.rowIndex + cell.rowSpan; row += 1) {
      for (let column = cell.columnIndex; column < cell.columnIndex + cell.columnSpan; column += 1) {
        const key = `${row}:${column}`
        coverage.set(key, (coverage.get(key) ?? 0) + 1)
      }
    }
  }

  const rowCount = getMeshRowCount(mesh)
  const columnCount = getMeshColumnCount(mesh)
  for (let row = 0; row < rowCount; row += 1) {
    for (let column = 0; column < columnCount; column += 1) {
      expect(coverage.get(`${row}:${column}`)).toBe(1)
    }
  }
}

describe('divider dragging', () => {
  const layoutDocument = buildDocument()
  const mesh = findFirstMesh(layoutDocument)

  it('clamps a divider between its neighbours', () => {
    const divider = { axis: 'column' as const, dividerIndex: 1 }
    const dragged = clampDividerPosition(mesh, divider, -10_000)
    const pushed = clampDividerPosition(mesh, divider, 10_000)

    expect(dragged).toBeCloseTo(mesh.columnEdges[0] + MINIMUM_CELL_SIZE_IN_WORLD_UNITS, 6)
    expect(pushed).toBeCloseTo(mesh.columnEdges[2] - MINIMUM_CELL_SIZE_IN_WORLD_UNITS, 6)
  })

  it('moves only the dragged divider', () => {
    const moved = withMovedDivider(mesh, { axis: 'row', dividerIndex: 1 }, mesh.rowEdges[1] + 6)

    expect(moved.columnEdges).toEqual(mesh.columnEdges)
    expect(moved.rowEdges[1]).toBeCloseTo(mesh.rowEdges[1] + 6, 6)
    expect(moved.rowEdges[0]).toBe(mesh.rowEdges[0])
    expect(moved.rowEdges[2]).toBe(mesh.rowEdges[2])
  })

  it('finds an interior divider under the pointer but never the outer border', () => {
    const interior = findDividerAtWorldPoint(
      mesh,
      { x: mesh.columnEdges[1], y: mesh.rowEdges[0] + 20 },
      4,
    )
    expect(interior).toEqual({ axis: 'column', dividerIndex: 1 })

    expect(
      findDividerAtWorldPoint(mesh, { x: mesh.columnEdges[0], y: mesh.rowEdges[0] + 20 }, 4),
    ).toBeNull()
    expect(
      findDividerAtWorldPoint(
        mesh,
        { x: mesh.columnEdges[mesh.columnEdges.length - 1], y: mesh.rowEdges[0] + 20 },
        4,
      ),
    ).toBeNull()
  })

  it('reports nothing outside the table', () => {
    expect(findDividerAtWorldPoint(mesh, { x: mesh.columnEdges[1], y: -5000 }, 4)).toBeNull()
  })

  /**
   * Otherwise the grab zones of neighbouring dividers meet and no part of a thin row can
   * be clicked to select its cell.
   */
  it('never lets a divider’s grab zone cover more than a third of its rows', () => {
    const rowHeight = mesh.rowEdges[1] - mesh.rowEdges[0]
    const justInsideTheMiddleThird = mesh.rowEdges[1] - rowHeight * 0.4

    expect(
      findDividerAtWorldPoint(
        mesh,
        { x: mesh.columnEdges[0] + 5, y: justInsideTheMiddleThird },
        10_000,
      ),
    ).toBeNull()
    expect(
      findDividerAtWorldPoint(mesh, { x: mesh.columnEdges[0] + 5, y: mesh.rowEdges[1] }, 10_000),
    ).toEqual({ axis: 'row', dividerIndex: 1 })
  })
})

describe('planDividerInsertion', () => {
  const layoutDocument = buildDocument()
  const mesh = findFirstMesh(layoutDocument)

  it('adds one column and one new cell per row', () => {
    const splitPosition = (mesh.columnEdges[0] + mesh.columnEdges[1]) / 2
    const plan = planDividerInsertion(layoutDocument, mesh, 'column', splitPosition, 9000)

    expect(plan).not.toBeNull()
    expect(plan!.columnEdges).toHaveLength(mesh.columnEdges.length + 1)
    expect(plan!.columnEdges[1]).toBeCloseTo(splitPosition, 6)
    expect(plan!.rowEdges).toEqual(mesh.rowEdges)
    expect(plan!.createdCells).toHaveLength(getMeshRowCount(mesh))
    expect(plan!.createdCells.map((cell) => cell.nodeId)).toEqual(
      plan!.createdCells.map((_cell, index) => 9000 + index),
    )
  })

  it('shifts the columns after the new divider along by one', () => {
    const splitPosition = (mesh.columnEdges[0] + mesh.columnEdges[1]) / 2
    const plan = planDividerInsertion(layoutDocument, mesh, 'column', splitPosition, 9000)!

    const originalSecondColumnCell = mesh.cells.find(
      (cell) => cell.rowIndex === 0 && cell.columnIndex === 1,
    )!
    const shifted = plan.cells.find((cell) => cell.nodeId === originalSecondColumnCell.nodeId)!
    expect(shifted.columnIndex).toBe(2)
  })

  it('adds one row and one new cell per column', () => {
    const splitPosition = (mesh.rowEdges[0] + mesh.rowEdges[1]) / 2
    const plan = planDividerInsertion(layoutDocument, mesh, 'row', splitPosition, 9000)!

    expect(plan.rowEdges).toHaveLength(mesh.rowEdges.length + 1)
    expect(plan.columnEdges).toEqual(mesh.columnEdges)
    expect(plan.createdCells).toHaveLength(getMeshColumnCount(mesh))
  })

  it('refuses a split that would leave a sliver', () => {
    expect(
      planDividerInsertion(layoutDocument, mesh, 'column', mesh.columnEdges[0] + 1, 9000),
    ).toBeNull()
    expect(planDividerInsertion(layoutDocument, mesh, 'column', -500, 9000)).toBeNull()
  })
})

describe('planCellMerge and planCellUnmerge', () => {
  let layoutDocument: LayoutDocument
  let mesh: TableMesh

  beforeEach(() => {
    layoutDocument = buildDocument()
    mesh = findFirstMesh(layoutDocument)
  })

  it('spans the rectangle covering the selected cells', () => {
    const first = mesh.cells.find((cell) => cell.rowIndex === 1 && cell.columnIndex === 0)!
    const second = mesh.cells.find((cell) => cell.rowIndex === 2 && cell.columnIndex === 1)!

    const plan = planCellMerge(layoutDocument, mesh, [first.nodeId, second.nodeId])!
    const anchor = plan.cells.find((cell) => cell.nodeId === plan.anchorNodeId)!

    expect(plan.anchorNodeId).toBe(first.nodeId)
    expect(anchor.rowSpan).toBe(2)
    expect(anchor.columnSpan).toBe(2)
    expect(plan.hiddenNodeIds).toHaveLength(3)
  })

  it('needs at least two cells', () => {
    const first = mesh.cells[0]
    expect(planCellMerge(layoutDocument, mesh, [first.nodeId])).toBeNull()
    expect(planCellMerge(layoutDocument, mesh, [])).toBeNull()
  })

  it('restores every hidden cell when unmerged', () => {
    const first = mesh.cells.find((cell) => cell.rowIndex === 0 && cell.columnIndex === 0)!
    const second = mesh.cells.find((cell) => cell.rowIndex === 0 && cell.columnIndex === 1)!

    const mergePlan = planCellMerge(layoutDocument, mesh, [first.nodeId, second.nodeId])!
    mesh.cells = mergePlan.cells
    for (const nodeId of mergePlan.hiddenNodeIds) {
      layoutDocument.geometry.flags[nodeId] |= NODE_FLAG_REMOVED
    }

    const unmergePlan = planCellUnmerge(layoutDocument, mesh, first.nodeId)!
    expect(unmergePlan.restoredNodeIds).toEqual(mergePlan.hiddenNodeIds)
    expect(
      unmergePlan.cells.find((cell) => cell.nodeId === first.nodeId),
    ).toMatchObject({ rowSpan: 1, columnSpan: 1 })
  })

  it('refuses to unmerge a cell that is not merged', () => {
    expect(planCellUnmerge(layoutDocument, mesh, mesh.cells[0].nodeId)).toBeNull()
  })
})

describe('table mesh transactions', () => {
  let layoutDocument: LayoutDocument
  let editor: LayoutEditor
  let mesh: TableMesh

  beforeEach(() => {
    layoutDocument = buildDocument()
    editor = new LayoutEditor({ reindexNodes: vi.fn() })
    editor.setDocument(layoutDocument)
    mesh = findFirstMesh(layoutDocument)
  })

  it('splits a cell into columns, creating the cells that appear', () => {
    const nodeCountBefore = layoutDocument.geometry.nodeCount
    const columnCountBefore = getMeshColumnCount(mesh)
    const rowCount = getMeshRowCount(mesh)
    const cellNodeId = mesh.cells.find((cell) => cell.columnIndex === 0)!.nodeId

    expect(splitTableCell(editor, cellNodeId, 'column')).toBe(true)

    expect(getMeshColumnCount(mesh)).toBe(columnCountBefore + 1)
    expect(layoutDocument.geometry.nodeCount).toBe(nodeCountBefore + rowCount)
    expectCellsTileMesh(layoutDocument, mesh)

    for (let nodeId = nodeCountBefore; nodeId < layoutDocument.geometry.nodeCount; nodeId += 1) {
      expect(getLayoutNodeClassName(layoutDocument.geometry.classIds[nodeId])).toBe('tableCell')
      expect(layoutDocument.geometry.parentIds[nodeId]).toBe(mesh.tableNodeId)
      expect(layoutDocument.childIdsByNodeId[mesh.tableNodeId]).toContain(nodeId)
    }
  })

  it('undoes a split as a single step, hiding the cells it created', () => {
    const columnCountBefore = getMeshColumnCount(mesh)
    const nodeCountBefore = layoutDocument.geometry.nodeCount
    const cellNodeId = mesh.cells.find((cell) => cell.columnIndex === 0)!.nodeId

    splitTableCell(editor, cellNodeId, 'column')
    expect(editor.undoDepth).toBe(1)
    editor.undo()

    expect(getMeshColumnCount(mesh)).toBe(columnCountBefore)
    expectCellsTileMesh(layoutDocument, mesh)
    for (let nodeId = nodeCountBefore; nodeId < layoutDocument.geometry.nodeCount; nodeId += 1) {
      expect(layoutDocument.geometry.flags[nodeId] & NODE_FLAG_REMOVED).not.toBe(0)
    }
  })

  it('splits a cell into rows', () => {
    const rowCountBefore = getMeshRowCount(mesh)
    expect(splitTableCell(editor, mesh.cells[0].nodeId, 'row')).toBe(true)

    expect(getMeshRowCount(mesh)).toBe(rowCountBefore + 1)
    expectCellsTileMesh(layoutDocument, mesh)
  })

  it('merges cells and undoes back to the original grid', () => {
    const first = mesh.cells.find((cell) => cell.rowIndex === 1 && cell.columnIndex === 0)!
    const second = mesh.cells.find((cell) => cell.rowIndex === 1 && cell.columnIndex === 1)!
    const firstBoundsBefore = readNodeBounds(layoutDocument.geometry, first.nodeId, {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    })

    expect(mergeTableCells(editor, [first.nodeId, second.nodeId])).toBe(true)
    const mergedBounds = readNodeBounds(layoutDocument.geometry, first.nodeId, {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    })
    expect(mergedBounds.width).toBeGreaterThan(firstBoundsBefore.width)
    expect(layoutDocument.geometry.flags[second.nodeId] & NODE_FLAG_REMOVED).not.toBe(0)
    expectCellsTileMesh(layoutDocument, mesh)

    editor.undo()
    expect(layoutDocument.geometry.flags[second.nodeId] & NODE_FLAG_REMOVED).toBe(0)
    expect(
      readNodeBounds(layoutDocument.geometry, first.nodeId, { x: 0, y: 0, width: 0, height: 0 }),
    ).toEqual(firstBoundsBefore)
    expectCellsTileMesh(layoutDocument, mesh)
  })

  it('unmerges a merged cell back into its parts', () => {
    const first = mesh.cells.find((cell) => cell.rowIndex === 1 && cell.columnIndex === 0)!
    const second = mesh.cells.find((cell) => cell.rowIndex === 1 && cell.columnIndex === 1)!

    mergeTableCells(editor, [first.nodeId, second.nodeId])
    expect(unmergeTableCell(editor, first.nodeId)).toBe(true)

    expect(layoutDocument.geometry.flags[second.nodeId] & NODE_FLAG_REMOVED).toBe(0)
    expectCellsTileMesh(layoutDocument, mesh)
    expect(unmergeTableCell(editor, first.nodeId)).toBe(false)
  })

  it('keeps every cell tiling the mesh after a divider drag', () => {
    editor.beginGesture('Drag divider')
    editor.applyInGesture([
      {
        kind: 'setTableMesh',
        pageIndex: mesh.pageIndex,
        tableNodeId: mesh.tableNodeId,
        ...withMovedDivider(mesh, { axis: 'column', dividerIndex: 1 }, mesh.columnEdges[1] + 30),
        cells: mesh.cells.map((cell) => ({ ...cell })),
      },
    ])
    editor.commitGesture()

    expectCellsTileMesh(layoutDocument, mesh)
    expect(editor.undoDepth).toBe(1)
  })
})

describe('collectSelectedCellNodeIds', () => {
  it('picks out the cells of one mesh from a mixed selection', () => {
    const layoutDocument = buildDocument()
    const mesh = findFirstMesh(layoutDocument)
    const selection = [mesh.cells[2].nodeId, 0, mesh.cells[1].nodeId]

    const result = collectSelectedCellNodeIds(layoutDocument, selection)
    expect(result?.mesh.tableNodeId).toBe(mesh.tableNodeId)
    // Reported in mesh order, not selection order.
    expect(result?.cellNodeIds).toEqual([mesh.cells[1].nodeId, mesh.cells[2].nodeId])
  })

  it('reports nothing when no table cell is selected', () => {
    const layoutDocument = buildDocument()
    expect(collectSelectedCellNodeIds(layoutDocument, [0])).toBeNull()
  })
})

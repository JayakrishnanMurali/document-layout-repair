import { beforeEach, describe, expect, it } from 'vitest'
import type { Rect } from '@/canvas/geometry'
import { LayoutDocumentBuilder } from '@/document/extraction/LayoutDocumentBuilder'
import { buildPageExtractionPayload } from '@/document/extraction/payloadBuilder'
import {
  NODE_FLAG_REMOVED,
  getLayoutNodeClassId,
  readNodeBounds,
  type LayoutDocument,
} from '@/document/layoutTypes'
import { generateSyntheticPageContent } from '@/document/synthetic/pageContentGenerator'
import { createRandomSource } from '@/document/synthetic/randomSource'
import { LayoutTransactionStack } from './LayoutTransactionStack'
import type { LayoutMutation } from './layoutMutations'

const PAGE_COUNT = 4
const DOCUMENT_SEED = 0x2b1c

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

type DocumentSnapshot = {
  bounds: Float32Array
  classIds: Uint8Array
  flags: Uint8Array
  readingOrder: string
  tableMeshes: string
}

function snapshot(layoutDocument: LayoutDocument): DocumentSnapshot {
  return {
    bounds: layoutDocument.geometry.bounds.slice(),
    classIds: layoutDocument.geometry.classIds.slice(),
    flags: layoutDocument.geometry.flags.slice(),
    readingOrder: JSON.stringify(layoutDocument.readingOrderByPage),
    tableMeshes: JSON.stringify(layoutDocument.tableMeshesByPage),
  }
}

function expectSnapshotsMatch(actual: DocumentSnapshot, expected: DocumentSnapshot): void {
  expect(Array.from(actual.bounds)).toEqual(Array.from(expected.bounds))
  expect(Array.from(actual.classIds)).toEqual(Array.from(expected.classIds))
  expect(actual.readingOrder).toBe(expected.readingOrder)
  expect(actual.tableMeshes).toBe(expected.tableMeshes)
}

function readBounds(layoutDocument: LayoutDocument, nodeId: number): Rect {
  return readNodeBounds(layoutDocument.geometry, nodeId, { x: 0, y: 0, width: 0, height: 0 })
}

describe('LayoutTransactionStack', () => {
  let layoutDocument: LayoutDocument
  let stack: LayoutTransactionStack

  beforeEach(() => {
    layoutDocument = buildDocument()
    stack = new LayoutTransactionStack(layoutDocument)
  })

  it('starts with nothing to undo or redo', () => {
    expect(stack.canUndo).toBe(false)
    expect(stack.canRedo).toBe(false)
    expect(stack.undoDepth).toBe(0)
  })

  it('applies and reverses a bounds change exactly', () => {
    const originalBounds = readBounds(layoutDocument, 3)
    const nextBounds: Rect = { x: 111, y: 222, width: 333, height: 44 }

    stack.commit('Move box', [{ kind: 'setNodeBounds', nodeId: 3, bounds: nextBounds }])
    expect(readBounds(layoutDocument, 3)).toEqual(nextBounds)

    stack.undo()
    expect(readBounds(layoutDocument, 3)).toEqual(originalBounds)

    stack.redo()
    expect(readBounds(layoutDocument, 3)).toEqual(nextBounds)
  })

  it('reverses a re-label', () => {
    const originalClassId = layoutDocument.geometry.classIds[5]
    stack.commit('Re-label', [
      { kind: 'setNodeClass', nodeId: 5, classId: getLayoutNodeClassId('keyLabel') },
    ])

    expect(layoutDocument.geometry.classIds[5]).toBe(getLayoutNodeClassId('keyLabel'))
    stack.undo()
    expect(layoutDocument.geometry.classIds[5]).toBe(originalClassId)
  })

  it('reverses a reading-order rearrangement', () => {
    const originalOrder = [...layoutDocument.readingOrderByPage[1].nodeIds]
    const shuffledOrder = [...originalOrder].reverse()

    stack.commit('Reorder', [{ kind: 'setReadingOrder', pageIndex: 1, nodeIds: shuffledOrder }])
    expect(layoutDocument.readingOrderByPage[1].nodeIds).toEqual(shuffledOrder)

    stack.undo()
    expect(layoutDocument.readingOrderByPage[1].nodeIds).toEqual(originalOrder)
  })

  it('recalculates cell rectangles when a table divider moves, and restores them on undo', () => {
    const meshPageIndex = layoutDocument.tableMeshesByPage.findIndex((meshes) => meshes.length > 0)
    expect(meshPageIndex).toBeGreaterThanOrEqual(0)

    const mesh = layoutDocument.tableMeshesByPage[meshPageIndex][0]
    const originalCellBounds = mesh.cells.map((cell) => readBounds(layoutDocument, cell.nodeId))
    const movedColumnEdges = [...mesh.columnEdges]
    movedColumnEdges[1] += 40

    stack.commit('Move column divider', [
      {
        kind: 'setTableMeshEdges',
        pageIndex: meshPageIndex,
        tableNodeId: mesh.tableNodeId,
        columnEdges: movedColumnEdges,
        rowEdges: [...mesh.rowEdges],
      },
    ])

    const firstColumnCell = mesh.cells.find((cell) => cell.columnIndex === 0)
    expect(firstColumnCell).toBeDefined()
    expect(readBounds(layoutDocument, firstColumnCell!.nodeId).width).toBeCloseTo(
      originalCellBounds[mesh.cells.indexOf(firstColumnCell!)].width + 40,
      3,
    )

    stack.undo()
    mesh.cells.forEach((cell, cellIndex) => {
      expect(readBounds(layoutDocument, cell.nodeId)).toEqual(originalCellBounds[cellIndex])
    })
  })

  it('hides and restores a node through presence mutations', () => {
    stack.commit('Merge cells', [{ kind: 'setNodePresence', nodeId: 9, isPresent: false }])
    expect(layoutDocument.geometry.flags[9] & NODE_FLAG_REMOVED).not.toBe(0)

    stack.undo()
    expect(layoutDocument.geometry.flags[9] & NODE_FLAG_REMOVED).toBe(0)
  })
})

describe('gesture coalescing', () => {
  it('turns a whole drag into a single undo step', () => {
    const layoutDocument = buildDocument()
    const stack = new LayoutTransactionStack(layoutDocument)
    const originalBounds = readBounds(layoutDocument, 7)

    stack.beginGesture('Drag box')
    for (let frame = 0; frame < 200; frame += 1) {
      stack.applyInGesture([
        {
          kind: 'setNodeBounds',
          nodeId: 7,
          bounds: { ...originalBounds, x: originalBounds.x + frame },
        },
      ])
    }
    stack.commitGesture()

    expect(stack.undoDepth).toBe(1)
    expect(readBounds(layoutDocument, 7).x).toBeCloseTo(originalBounds.x + 199, 3)

    stack.undo()
    expect(readBounds(layoutDocument, 7)).toEqual(originalBounds)

    stack.redo()
    expect(readBounds(layoutDocument, 7).x).toBeCloseTo(originalBounds.x + 199, 3)
  })

  it('records nothing for a gesture that changed nothing', () => {
    const layoutDocument = buildDocument()
    const stack = new LayoutTransactionStack(layoutDocument)

    stack.beginGesture('Drag box')
    expect(stack.commitGesture()).toBeNull()
    expect(stack.undoDepth).toBe(0)
  })

  it('rolls a gesture back on abort without touching history', () => {
    const layoutDocument = buildDocument()
    const stack = new LayoutTransactionStack(layoutDocument)
    const originalBounds = readBounds(layoutDocument, 11)

    stack.beginGesture('Drag box')
    stack.applyInGesture([
      { kind: 'setNodeBounds', nodeId: 11, bounds: { x: 5, y: 5, width: 5, height: 5 } },
    ])
    stack.abortGesture()

    expect(readBounds(layoutDocument, 11)).toEqual(originalBounds)
    expect(stack.undoDepth).toBe(0)
  })

  it('coalesces a multi-node drag into one step per node', () => {
    const layoutDocument = buildDocument()
    const stack = new LayoutTransactionStack(layoutDocument)
    const nodeIds = [12, 13, 14]
    const originalBounds = nodeIds.map((nodeId) => readBounds(layoutDocument, nodeId))

    stack.beginGesture('Drag selection')
    for (let frame = 1; frame <= 30; frame += 1) {
      stack.applyInGesture(
        nodeIds.map((nodeId, index) => ({
          kind: 'setNodeBounds' as const,
          nodeId,
          bounds: { ...originalBounds[index], y: originalBounds[index].y + frame },
        })),
      )
    }
    const transaction = stack.commitGesture()

    expect(transaction?.mutations).toHaveLength(3)
    expect(stack.undoDepth).toBe(1)

    stack.undo()
    nodeIds.forEach((nodeId, index) => {
      expect(readBounds(layoutDocument, nodeId)).toEqual(originalBounds[index])
    })
  })
})

describe('history depth and branching', () => {
  it('supports far more than the 50 undo levels the brief requires', () => {
    const layoutDocument = buildDocument()
    const stack = new LayoutTransactionStack(layoutDocument)
    const before = snapshot(layoutDocument)

    for (let step = 0; step < 80; step += 1) {
      const bounds = readBounds(layoutDocument, 20 + step)
      stack.commit(`Edit ${step}`, [
        {
          kind: 'setNodeBounds',
          nodeId: 20 + step,
          bounds: { ...bounds, x: bounds.x + 13, width: bounds.width + 3 },
        },
      ])
    }

    expect(stack.undoDepth).toBe(80)
    for (let step = 0; step < 80; step += 1) {
      stack.undo()
    }

    expect(stack.canUndo).toBe(false)
    expectSnapshotsMatch(snapshot(layoutDocument), before)
  })

  it('drops the oldest transactions past the configured depth', () => {
    const layoutDocument = buildDocument()
    const stack = new LayoutTransactionStack(layoutDocument, 50)

    for (let step = 0; step < 70; step += 1) {
      const bounds = readBounds(layoutDocument, 30)
      stack.commit(`Edit ${step}`, [
        { kind: 'setNodeBounds', nodeId: 30, bounds: { ...bounds, x: bounds.x + 1 } },
      ])
    }

    expect(stack.undoDepth).toBe(50)
  })

  it('clears the redo branch once a new edit lands', () => {
    const layoutDocument = buildDocument()
    const stack = new LayoutTransactionStack(layoutDocument)
    const bounds = readBounds(layoutDocument, 40)

    stack.commit('First', [{ kind: 'setNodeBounds', nodeId: 40, bounds: { ...bounds, x: 1 } }])
    stack.undo()
    expect(stack.canRedo).toBe(true)

    stack.commit('Second', [{ kind: 'setNodeBounds', nodeId: 40, bounds: { ...bounds, x: 2 } }])
    expect(stack.canRedo).toBe(false)
    expect(stack.redoDepth).toBe(0)
  })

  it('round-trips a randomized edit sequence back to the original document', () => {
    const layoutDocument = buildDocument()
    const stack = new LayoutTransactionStack(layoutDocument, 500)
    const before = snapshot(layoutDocument)
    const random = createRandomSource(0xc0ffee)
    const nodeCount = layoutDocument.geometry.nodeCount

    for (let step = 0; step < 240; step += 1) {
      const nodeId = random.nextInteger(0, nodeCount)
      const bounds = readBounds(layoutDocument, nodeId)
      const mutations: LayoutMutation[] = [
        {
          kind: 'setNodeBounds',
          nodeId,
          bounds: {
            x: bounds.x + random.nextInRange(-30, 30),
            y: bounds.y + random.nextInRange(-30, 30),
            width: Math.max(4, bounds.width + random.nextInRange(-20, 20)),
            height: Math.max(4, bounds.height + random.nextInRange(-10, 10)),
          },
        },
      ]
      if (random.nextBoolean(0.25)) {
        mutations.push({ kind: 'setNodeClass', nodeId, classId: random.nextInteger(0, 11) })
      }
      stack.commit(`Random edit ${step}`, mutations)
    }

    while (stack.canUndo) {
      stack.undo()
    }

    expectSnapshotsMatch(snapshot(layoutDocument), before)
  })

  it('replays the whole redo branch back to the edited state', () => {
    const layoutDocument = buildDocument()
    const stack = new LayoutTransactionStack(layoutDocument, 500)
    const random = createRandomSource(0xfeed)

    for (let step = 0; step < 60; step += 1) {
      const nodeId = random.nextInteger(0, layoutDocument.geometry.nodeCount)
      const bounds = readBounds(layoutDocument, nodeId)
      stack.commit(`Edit ${step}`, [
        { kind: 'setNodeBounds', nodeId, bounds: { ...bounds, y: bounds.y + 7 } },
      ])
    }
    const afterEdits = snapshot(layoutDocument)

    while (stack.canUndo) {
      stack.undo()
    }
    while (stack.canRedo) {
      stack.redo()
    }

    expectSnapshotsMatch(snapshot(layoutDocument), afterEdits)
  })
})

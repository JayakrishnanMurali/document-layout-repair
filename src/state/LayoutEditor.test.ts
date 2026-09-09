import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LayoutDocumentBuilder } from '@/document/extraction/LayoutDocumentBuilder'
import { buildPageExtractionPayload } from '@/document/extraction/payloadBuilder'
import { NO_LAYOUT_NODE_ID, type LayoutDocument } from '@/document/layoutTypes'
import { generateSyntheticPageContent } from '@/document/synthetic/pageContentGenerator'
import { LayoutEditor, type EditorChangeKind } from './LayoutEditor'

const DOCUMENT_SEED = 0x33

function buildDocument(): LayoutDocument {
  const builder = new LayoutDocumentBuilder(2)
  builder.ingestPage(
    buildPageExtractionPayload(generateSyntheticPageContent(0, DOCUMENT_SEED), DOCUMENT_SEED),
  )
  builder.ingestPage(
    buildPageExtractionPayload(generateSyntheticPageContent(1, DOCUMENT_SEED), DOCUMENT_SEED),
  )
  return builder.getDocument()
}

describe('LayoutEditor selection', () => {
  let editor: LayoutEditor

  beforeEach(() => {
    editor = new LayoutEditor({ reindexNodes: vi.fn() })
    editor.setDocument(buildDocument())
  })

  it('replaces the selection by default', () => {
    editor.selectNode(4)
    editor.selectNode(9)

    expect(editor.selectedNodeIds).toEqual([9])
    expect(editor.primarySelectedNodeId).toBe(9)
  })

  it('adds and removes with toggle', () => {
    editor.selectNode(4)
    editor.selectNode(9, 'toggle')
    expect(editor.selectedNodeIds).toEqual([4, 9])

    editor.selectNode(4, 'toggle')
    expect(editor.selectedNodeIds).toEqual([9])
  })

  it('treats the most recently added node as primary', () => {
    editor.setSelection([3, 7, 11])
    expect(editor.primarySelectedNodeId).toBe(11)
  })

  it('clears the selection when nothing is hit', () => {
    editor.selectNode(4)
    editor.selectNode(NO_LAYOUT_NODE_ID)
    expect(editor.selectedNodeIds).toEqual([])
  })

  it('drops selection and history when a new document loads', () => {
    editor.selectNode(4)
    editor.commit('Re-label', [{ kind: 'setNodeClass', nodeId: 4, classId: 1 }])
    expect(editor.canUndo).toBe(true)

    editor.setDocument(buildDocument())
    expect(editor.selectedNodeIds).toEqual([])
    expect(editor.canUndo).toBe(false)
  })
})

describe('LayoutEditor change notifications', () => {
  let editor: LayoutEditor
  let changes: EditorChangeKind[]

  beforeEach(() => {
    editor = new LayoutEditor({ reindexNodes: vi.fn() })
    editor.setDocument(buildDocument())
    changes = []
    editor.subscribe((kind) => changes.push(kind))
  })

  it('announces chrome-only changes so the interaction layer repaints', () => {
    editor.setMarqueeWorldRect({ x: 0, y: 0, width: 10, height: 10 })
    expect(changes).toEqual(['interaction'])
  })

  /** The bug this guards: a released marquee stayed painted because clearing it was silent. */
  it('announces clearing the marquee, not just setting it', () => {
    editor.setMarqueeWorldRect({ x: 0, y: 0, width: 10, height: 10 })
    changes.length = 0

    editor.setMarqueeWorldRect(null)
    expect(changes).toEqual(['interaction'])
  })

  it('stays silent when chrome state is set to what it already is', () => {
    editor.setMarqueeWorldRect(null)
    editor.setSnapGuides([])
    editor.setActiveHandleId(null)
    expect(changes).toEqual([])
  })

  it('announces snap guides appearing and being cleared', () => {
    editor.setSnapGuides([
      { orientation: 'vertical', worldPosition: 10, spanStart: 0, spanEnd: 50 },
    ])
    expect(changes).toEqual(['interaction'])

    changes.length = 0
    editor.setSnapGuides([])
    expect(changes).toEqual(['interaction'])
  })

  it('does not announce a selection change that changes nothing', () => {
    editor.selectNode(5)
    changes.length = 0

    editor.selectNode(5)
    editor.setHoveredNodeId(NO_LAYOUT_NODE_ID)
    expect(changes).toEqual([])
  })
})

describe('LayoutEditor index replay', () => {
  it('replays committed geometry, and nothing during a gesture', () => {
    const reindexNodes = vi.fn()
    const editor = new LayoutEditor({ reindexNodes })
    editor.setDocument(buildDocument())

    editor.beginGesture('Move box')
    editor.applyInGesture([
      { kind: 'setNodeBounds', nodeId: 6, bounds: { x: 10, y: 10, width: 20, height: 20 } },
    ])
    expect(reindexNodes).not.toHaveBeenCalled()

    editor.commitGesture()
    expect(reindexNodes).toHaveBeenCalledTimes(1)
    expect(reindexNodes.mock.calls[0][0]).toEqual([6])
  })

  it('replays on undo and redo as well, so the index follows history', () => {
    const reindexNodes = vi.fn()
    const editor = new LayoutEditor({ reindexNodes })
    editor.setDocument(buildDocument())

    editor.commit('Move box', [
      { kind: 'setNodeBounds', nodeId: 6, bounds: { x: 10, y: 10, width: 20, height: 20 } },
    ])
    editor.undo()
    editor.redo()

    expect(reindexNodes).toHaveBeenCalledTimes(3)
  })

  it('clears chrome when a gesture is committed or aborted', () => {
    const editor = new LayoutEditor({ reindexNodes: vi.fn() })
    editor.setDocument(buildDocument())

    editor.beginGesture('Resize box')
    editor.setActiveHandleId('bottomRight')
    editor.setSnapGuides([
      { orientation: 'horizontal', worldPosition: 4, spanStart: 0, spanEnd: 9 },
    ])
    editor.commitGesture()

    expect(editor.getInteractionState().activeHandleId).toBeNull()
    expect(editor.getInteractionState().snapGuides).toEqual([])
  })
})

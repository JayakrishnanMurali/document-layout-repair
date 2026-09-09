import { create } from 'zustand'
import { NO_LAYOUT_NODE_ID, type LayoutNodeId } from '@/document/layoutTypes'
import { LayoutEditor } from './LayoutEditor'
import { replayGeometryIntoIndex } from './extractionWorker'

/**
 * The editing session, shared by the canvas engine and React.
 *
 * The canvas talks to `layoutEditor` directly; this store is a read-only mirror of the
 * few fields the chrome renders. Geometry is deliberately not mirrored — a drag would
 * otherwise re-render the workspace on every pointer move to show numbers nobody reads
 * mid-gesture.
 */
export const layoutEditor = new LayoutEditor({ reindexNodes: replayGeometryIntoIndex })

export type EditorStoreState = {
  selectedNodeIds: LayoutNodeId[]
  hoveredNodeId: LayoutNodeId
  canUndo: boolean
  canRedo: boolean
  undoDepth: number
  nextUndoLabel: string | null
  nextRedoLabel: string | null
  /**
   * Bumped when the document's structure may have changed — a committed transaction or a
   * fresh load. Panels that derive lists from the document watch this instead of the
   * per-frame geometry, so a drag does not rebuild the tree sixty times a second.
   */
  structureVersion: number
}

export const useEditorStore = create<EditorStoreState>(() => ({
  selectedNodeIds: [],
  hoveredNodeId: NO_LAYOUT_NODE_ID,
  canUndo: false,
  canRedo: false,
  undoDepth: 0,
  nextUndoLabel: null,
  nextRedoLabel: null,
  structureVersion: 0,
}))

function mirrorSelection(): void {
  useEditorStore.setState({
    selectedNodeIds: [...layoutEditor.selectedNodeIds],
    hoveredNodeId: layoutEditor.hoveredNodeId,
  })
}

function mirrorHistory(): void {
  useEditorStore.setState((state) => ({
    canUndo: layoutEditor.canUndo,
    canRedo: layoutEditor.canRedo,
    undoDepth: layoutEditor.undoDepth,
    nextUndoLabel: layoutEditor.nextUndoLabel,
    nextRedoLabel: layoutEditor.nextRedoLabel,
    structureVersion: state.structureVersion + 1,
  }))
}

layoutEditor.subscribe((changeKind) => {
  switch (changeKind) {
    case 'selection':
      mirrorSelection()
      break
    case 'history':
      mirrorHistory()
      break
    case 'document':
      mirrorSelection()
      mirrorHistory()
      break
    case 'geometry':
    case 'interaction':
      break
  }
})

export function usePrimarySelectedNodeId(): LayoutNodeId {
  return useEditorStore(
    (state) => state.selectedNodeIds[state.selectedNodeIds.length - 1] ?? NO_LAYOUT_NODE_ID,
  )
}

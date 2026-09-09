import type { Rect } from '@/canvas/geometry'
import type { BoxHandleId } from '@/canvas/interaction/boxHandles'
import {
  createInteractionState,
  type InteractionState,
  type PendingReadingOrderLink,
} from '@/canvas/interaction/interactionTypes'
import type { SnapGuide } from '@/canvas/interaction/snapping'
import {
  NO_LAYOUT_NODE_ID,
  readNodeBounds,
  type LayoutDocument,
  type LayoutNodeId,
} from '@/document/layoutTypes'
import { LayoutTransactionStack, type LayoutTransaction } from './history/LayoutTransactionStack'
import type { LayoutMutation } from './history/layoutMutations'

export type SelectionMode = 'replace' | 'toggle'

/**
 * `interaction` covers chrome-only changes — snap guides, the active handle, the marquee
 * rectangle. It must still trigger a repaint (otherwise a released marquee stays drawn),
 * but it deliberately carries no store state, so a drag never re-renders React.
 */
export type EditorChangeKind = 'selection' | 'geometry' | 'history' | 'document' | 'interaction'

export type LayoutEditorOptions = {
  /** Replays committed geometry changes into the worker that owns the spatial index. */
  reindexNodes: (nodeIds: readonly LayoutNodeId[], layoutDocument: LayoutDocument) => void
}

/**
 * The editing session: selection, interaction chrome, and the transactional history.
 *
 * Canvas code talks to this imperatively; React mirrors only the few fields it renders.
 * Geometry changes never pass through React, which is what keeps a drag at one camera
 * write and one repaint per pointer event.
 */
export class LayoutEditor {
  private readonly interactionState = createInteractionState()
  private readonly listeners = new Set<(kind: EditorChangeKind) => void>()
  private readonly reindexNodes: LayoutEditorOptions['reindexNodes']
  private readonly boundsScratch: Rect = { x: 0, y: 0, width: 0, height: 0 }

  private layoutDocument: LayoutDocument | null = null
  private transactionStack: LayoutTransactionStack | null = null

  constructor(options: LayoutEditorOptions) {
    this.reindexNodes = options.reindexNodes
  }

  subscribe(listener: (kind: EditorChangeKind) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  setDocument(layoutDocument: LayoutDocument | null): void {
    this.layoutDocument = layoutDocument
    this.transactionStack = layoutDocument ? new LayoutTransactionStack(layoutDocument) : null

    this.interactionState.selectedNodeIds = []
    this.interactionState.hoveredNodeId = NO_LAYOUT_NODE_ID
    this.interactionState.snapGuides = []
    this.interactionState.activeHandleId = null
    this.interactionState.marqueeWorldRect = null
    this.interactionState.pendingReadingOrderLink = null

    this.notify('document')
  }

  getDocument(): LayoutDocument | null {
    return this.layoutDocument
  }

  /**
   * Announces that the live stream appended nodes to the document already in place.
   *
   * The document object identity is deliberately unchanged, so selection and the undo
   * stack survive: a stream update extends the document rather than replacing it, and
   * cannot invalidate an edit the reviewer has already made.
   */
  notifyDocumentAppended(): void {
    this.notify('geometry')
    this.notify('history')
  }

  getInteractionState(): InteractionState {
    return this.interactionState
  }

  getNodeBounds(nodeId: LayoutNodeId): Rect | null {
    if (!this.layoutDocument || nodeId < 0 || nodeId >= this.layoutDocument.geometry.nodeCount) {
      return null
    }
    return { ...readNodeBounds(this.layoutDocument.geometry, nodeId, this.boundsScratch) }
  }

  // --- selection -----------------------------------------------------------------

  get selectedNodeIds(): readonly LayoutNodeId[] {
    return this.interactionState.selectedNodeIds
  }

  /** The node whose handles are shown: the most recently added to the selection. */
  get primarySelectedNodeId(): LayoutNodeId {
    const { selectedNodeIds } = this.interactionState
    return selectedNodeIds[selectedNodeIds.length - 1] ?? NO_LAYOUT_NODE_ID
  }

  get hoveredNodeId(): LayoutNodeId {
    return this.interactionState.hoveredNodeId
  }

  selectNode(nodeId: LayoutNodeId, mode: SelectionMode = 'replace'): void {
    const current = this.interactionState.selectedNodeIds

    if (nodeId === NO_LAYOUT_NODE_ID) {
      if (mode === 'replace' && current.length > 0) {
        this.interactionState.selectedNodeIds = []
        this.notify('selection')
      }
      return
    }

    if (mode === 'toggle') {
      this.interactionState.selectedNodeIds = current.includes(nodeId)
        ? current.filter((candidate) => candidate !== nodeId)
        : [...current, nodeId]
    } else {
      if (current.length === 1 && current[0] === nodeId) {
        return
      }
      this.interactionState.selectedNodeIds = [nodeId]
    }

    this.notify('selection')
  }

  setSelection(nodeIds: readonly LayoutNodeId[]): void {
    this.interactionState.selectedNodeIds = [...nodeIds]
    this.notify('selection')
  }

  clearSelection(): void {
    if (this.interactionState.selectedNodeIds.length === 0) {
      return
    }
    this.interactionState.selectedNodeIds = []
    this.notify('selection')
  }

  setHoveredNodeId(nodeId: LayoutNodeId): void {
    if (this.interactionState.hoveredNodeId === nodeId) {
      return
    }
    this.interactionState.hoveredNodeId = nodeId
    this.notify('selection')
  }

  // --- interaction chrome --------------------------------------------------------

  setActiveHandleId(handleId: BoxHandleId | null): void {
    if (this.interactionState.activeHandleId === handleId) {
      return
    }
    this.interactionState.activeHandleId = handleId
    this.notify('interaction')
  }

  setSnapGuides(guides: SnapGuide[]): void {
    if (this.interactionState.snapGuides.length === 0 && guides.length === 0) {
      return
    }
    this.interactionState.snapGuides = guides
    this.notify('interaction')
  }

  setPendingReadingOrderLink(link: PendingReadingOrderLink | null): void {
    if (this.interactionState.pendingReadingOrderLink === null && link === null) {
      return
    }
    this.interactionState.pendingReadingOrderLink = link
    this.notify('interaction')
  }

  setMarqueeWorldRect(rect: Rect | null): void {
    if (this.interactionState.marqueeWorldRect === null && rect === null) {
      return
    }
    this.interactionState.marqueeWorldRect = rect
    this.notify('interaction')
  }

  // --- editing -------------------------------------------------------------------

  get canUndo(): boolean {
    return this.transactionStack?.canUndo ?? false
  }

  get canRedo(): boolean {
    return this.transactionStack?.canRedo ?? false
  }

  get undoDepth(): number {
    return this.transactionStack?.undoDepth ?? 0
  }

  get nextUndoLabel(): string | null {
    return this.transactionStack?.nextUndoLabel ?? null
  }

  get nextRedoLabel(): string | null {
    return this.transactionStack?.nextRedoLabel ?? null
  }

  commit(label: string, mutations: readonly LayoutMutation[]): void {
    const transaction = this.transactionStack?.commit(label, mutations)
    this.afterTransaction(transaction)
  }

  beginGesture(label: string): void {
    this.transactionStack?.beginGesture(label)
  }

  /** Applies mutations inside an open gesture and repaints, without recording history. */
  applyInGesture(mutations: readonly LayoutMutation[]): void {
    this.transactionStack?.applyInGesture(mutations)
    this.notify('geometry')
  }

  commitGesture(): void {
    const transaction = this.transactionStack?.commitGesture()
    this.interactionState.snapGuides = []
    this.interactionState.activeHandleId = null
    this.interactionState.pendingReadingOrderLink = null
    this.afterTransaction(transaction)
  }

  abortGesture(): void {
    const transaction = this.transactionStack?.abortGesture()
    this.interactionState.snapGuides = []
    this.interactionState.activeHandleId = null
    this.interactionState.pendingReadingOrderLink = null
    if (transaction && this.layoutDocument) {
      this.reindexNodes(transaction.affectedNodeIds, this.layoutDocument)
    }
    this.notify('geometry')
  }

  undo(): void {
    this.afterTransaction(this.transactionStack?.undo())
  }

  redo(): void {
    this.afterTransaction(this.transactionStack?.redo())
  }

  private afterTransaction(transaction: LayoutTransaction | null | undefined): void {
    if (!transaction || !this.layoutDocument) {
      this.notify('history')
      return
    }
    this.reindexNodes(transaction.affectedNodeIds, this.layoutDocument)
    this.notify('geometry')
    this.notify('history')
  }

  private notify(kind: EditorChangeKind): void {
    for (const listener of this.listeners) {
      listener(kind)
    }
  }
}

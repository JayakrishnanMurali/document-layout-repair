import type { LayoutDocument, LayoutNodeId } from '@/document/layoutTypes'
import {
  applyLayoutMutation,
  collectAffectedNodeIds,
  getMutationKey,
  type LayoutMutation,
} from './layoutMutations'

export const DEFAULT_MAXIMUM_HISTORY_DEPTH = 100

export type LayoutTransaction = {
  label: string
  mutations: LayoutMutation[]
  /** In application order; undo replays them in reverse. */
  inverses: LayoutMutation[]
  affectedNodeIds: LayoutNodeId[]
}

type ActiveGesture = {
  label: string
  mutations: LayoutMutation[]
  /** First inverse seen per mutation key — the one that restores the pre-gesture state. */
  inverseByKey: Map<string, LayoutMutation>
  keyOrder: string[]
}

/**
 * Undo/redo over invertible mutations.
 *
 * A pointer drag emits a mutation per frame but must undo as a single step, so a gesture
 * keeps only the first inverse it sees for each thing it touches and commits one
 * transaction on release. Everything else commits immediately.
 */
export class LayoutTransactionStack {
  private readonly maximumDepth: number
  private layoutDocument: LayoutDocument
  private undoStack: LayoutTransaction[] = []
  private redoStack: LayoutTransaction[] = []
  private activeGesture: ActiveGesture | null = null

  constructor(layoutDocument: LayoutDocument, maximumDepth = DEFAULT_MAXIMUM_HISTORY_DEPTH) {
    this.layoutDocument = layoutDocument
    this.maximumDepth = maximumDepth
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  get undoDepth(): number {
    return this.undoStack.length
  }

  get redoDepth(): number {
    return this.redoStack.length
  }

  get isGestureActive(): boolean {
    return this.activeGesture !== null
  }

  get nextUndoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null
  }

  get nextRedoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null
  }

  /**
   * Rebinds the stack to a freshly loaded document and drops the history, which is what
   * prevents an undo from replaying a patch against nodes that no longer exist.
   */
  resetDocument(layoutDocument: LayoutDocument): void {
    this.layoutDocument = layoutDocument
    this.undoStack = []
    this.redoStack = []
    this.activeGesture = null
  }

  /** Applies mutations as one atomic, immediately undoable transaction. */
  commit(label: string, mutations: readonly LayoutMutation[]): LayoutTransaction | null {
    if (mutations.length === 0) {
      return null
    }

    const appliedMutations: LayoutMutation[] = []
    const inverses: LayoutMutation[] = []

    for (const mutation of mutations) {
      inverses.push(applyLayoutMutation(this.layoutDocument, mutation))
      appliedMutations.push(mutation)
    }

    return this.push({
      label,
      mutations: appliedMutations,
      inverses,
      affectedNodeIds: this.resolveAffectedNodeIds(appliedMutations),
    })
  }

  beginGesture(label: string): void {
    if (this.activeGesture) {
      this.commitGesture()
    }
    this.activeGesture = { label, mutations: [], inverseByKey: new Map(), keyOrder: [] }
  }

  /** Applies mutations inside the open gesture. Safe to call every pointer move. */
  applyInGesture(mutations: readonly LayoutMutation[]): void {
    const gesture = this.activeGesture
    if (!gesture) {
      throw new Error('applyInGesture was called without an open gesture')
    }

    for (const mutation of mutations) {
      const inverse = applyLayoutMutation(this.layoutDocument, mutation)
      const key = getMutationKey(mutation)
      if (!gesture.inverseByKey.has(key)) {
        gesture.inverseByKey.set(key, inverse)
        gesture.keyOrder.push(key)
      }
      gesture.mutations.push(mutation)
    }
  }

  /** Closes the gesture into one transaction. Returns null when nothing changed. */
  commitGesture(): LayoutTransaction | null {
    const gesture = this.activeGesture
    this.activeGesture = null
    if (!gesture || gesture.mutations.length === 0) {
      return null
    }

    // Only the final mutation per key survives: intermediate drag positions are noise.
    const finalMutationByKey = new Map<string, LayoutMutation>()
    for (const mutation of gesture.mutations) {
      finalMutationByKey.set(getMutationKey(mutation), mutation)
    }

    const mutations = gesture.keyOrder
      .map((key) => finalMutationByKey.get(key))
      .filter((mutation): mutation is LayoutMutation => mutation !== undefined)
    const inverses = gesture.keyOrder
      .map((key) => gesture.inverseByKey.get(key))
      .filter((mutation): mutation is LayoutMutation => mutation !== undefined)

    return this.push({
      label: gesture.label,
      mutations,
      inverses,
      affectedNodeIds: this.resolveAffectedNodeIds(mutations),
    })
  }

  /** Rolls the open gesture back without recording history. */
  abortGesture(): LayoutTransaction | null {
    const gesture = this.activeGesture
    this.activeGesture = null
    if (!gesture || gesture.keyOrder.length === 0) {
      return null
    }

    for (let keyIndex = gesture.keyOrder.length - 1; keyIndex >= 0; keyIndex -= 1) {
      const inverse = gesture.inverseByKey.get(gesture.keyOrder[keyIndex])
      if (inverse) {
        applyLayoutMutation(this.layoutDocument, inverse)
      }
    }

    return {
      label: gesture.label,
      mutations: [],
      inverses: [],
      affectedNodeIds: this.resolveAffectedNodeIds(gesture.mutations),
    }
  }

  undo(): LayoutTransaction | null {
    const transaction = this.undoStack.pop()
    if (!transaction) {
      return null
    }

    for (let index = transaction.inverses.length - 1; index >= 0; index -= 1) {
      applyLayoutMutation(this.layoutDocument, transaction.inverses[index])
    }
    this.redoStack.push(transaction)

    return transaction
  }

  redo(): LayoutTransaction | null {
    const transaction = this.redoStack.pop()
    if (!transaction) {
      return null
    }

    for (const mutation of transaction.mutations) {
      applyLayoutMutation(this.layoutDocument, mutation)
    }
    this.undoStack.push(transaction)

    return transaction
  }

  private push(transaction: LayoutTransaction): LayoutTransaction {
    this.undoStack.push(transaction)
    // A new edit invalidates the redo branch.
    this.redoStack = []

    if (this.undoStack.length > this.maximumDepth) {
      this.undoStack.splice(0, this.undoStack.length - this.maximumDepth)
    }

    return transaction
  }

  private resolveAffectedNodeIds(mutations: readonly LayoutMutation[]): LayoutNodeId[] {
    return [...collectAffectedNodeIds(this.layoutDocument, mutations, new Set<LayoutNodeId>())]
  }
}

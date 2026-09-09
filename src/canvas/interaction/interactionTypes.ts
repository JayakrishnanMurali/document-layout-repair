import type { Rect } from '@/canvas/geometry'
import type { LayoutNodeId } from '@/document/layoutTypes'
import type { BoxHandleId } from './boxHandles'
import type { SnapGuide } from './snapping'

/** A reading-order link being dragged from one block towards another. */
export type PendingReadingOrderLink = {
  fromNodeId: LayoutNodeId
  pointerWorldX: number
  pointerWorldY: number
  /** Block under the pointer that would become the next one in reading order. */
  candidateNodeId: LayoutNodeId
}

/**
 * Everything the interaction layer paints on top of the document.
 *
 * It is a plain mutable object rather than store state on purpose: a drag updates it on
 * every pointer move, and routing that through React would re-render the whole workspace
 * sixty times a second for chrome only the canvas draws.
 */
export type InteractionState = {
  hoveredNodeId: LayoutNodeId
  selectedNodeIds: LayoutNodeId[]
  activeHandleId: BoxHandleId | null
  snapGuides: SnapGuide[]
  /** Marquee rectangle in world units, while a rubber-band selection is in progress. */
  marqueeWorldRect: Rect | null
  pendingReadingOrderLink: PendingReadingOrderLink | null
}

export function createInteractionState(): InteractionState {
  return {
    hoveredNodeId: -1,
    selectedNodeIds: [],
    activeHandleId: null,
    snapGuides: [],
    marqueeWorldRect: null,
    pendingReadingOrderLink: null,
  }
}

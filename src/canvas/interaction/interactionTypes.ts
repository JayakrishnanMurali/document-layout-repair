import type { Rect } from '@/canvas/geometry'
import type { LayoutNodeId } from '@/document/layoutTypes'
import type { BoxHandleId } from './boxHandles'
import type { SnapGuide } from './snapping'

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
}

export function createInteractionState(): InteractionState {
  return {
    hoveredNodeId: -1,
    selectedNodeIds: [],
    activeHandleId: null,
    snapGuides: [],
    marqueeWorldRect: null,
  }
}

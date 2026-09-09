import type { Point } from '@/canvas/geometry'

export type PointerGestureContext = {
  /** Pointer position in world units. */
  worldPoint: Point
  /** Pointer position in CSS pixels relative to the viewport element. */
  screenPoint: Point
  /** CSS pixels per world unit, for screen-space tolerances. */
  screenPixelsPerWorldUnit: number
}

/**
 * An editing tool that can take over a pointer press.
 *
 * Handlers are consulted in order on every press; the first to return true owns the
 * gesture until release, and panning only happens when nobody claimed it. That keeps
 * "am I dragging a handle, a box, a divider, or the canvas?" in one place instead of
 * spread across every tool.
 */
export type PointerGestureHandler = {
  readonly name: string
  onPointerDown(event: PointerEvent, context: PointerGestureContext): boolean
  onPointerMove(event: PointerEvent, context: PointerGestureContext): void
  onPointerUp(event: PointerEvent, context: PointerGestureContext): void
  onCancel(): void
  /** CSS cursor to show while hovering, when this handler would claim the press. */
  getCursor?(context: PointerGestureContext): string | null
}

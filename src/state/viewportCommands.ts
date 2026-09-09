import type { Rect } from '@/canvas/geometry'

export type ViewportCommands = {
  /** Brings a world-space rectangle into view, animating the camera. */
  focusWorldRect: (worldRect: Rect) => void
}

let registeredCommands: ViewportCommands | null = null

/**
 * A tiny imperative bridge from the chrome to the live viewport.
 *
 * The canvas engine is created inside the viewport component and is deliberately not a
 * React value, so panels that need to drive the camera — the structure tree scrolling a
 * node into view — reach it through here rather than by threading a ref down the tree.
 */
export function registerViewportCommands(commands: ViewportCommands | null): void {
  registeredCommands = commands
}

export function focusWorldRect(worldRect: Rect): void {
  registeredCommands?.focusWorldRect(worldRect)
}

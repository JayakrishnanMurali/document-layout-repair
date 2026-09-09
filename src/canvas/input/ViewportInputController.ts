import { clampZoomScale } from '@/canvas/viewport/camera'
import type { ViewportRenderEngine } from '@/canvas/ViewportRenderEngine'

const WHEEL_ZOOM_SENSITIVITY = 0.0016
const PINCH_ZOOM_SENSITIVITY = 0.011
const KEYBOARD_PAN_STEP_IN_SCREEN_PIXELS = 80
const KEYBOARD_ZOOM_STEP = 1.25

export type ViewportInputControllerOptions = {
  element: HTMLElement
  engine: ViewportRenderEngine
  /** Lets an active editing tool claim a drag before it becomes a pan. */
  shouldStartPan?: (event: PointerEvent) => boolean
  onFitDocumentRequested?: () => void
}

type ActivePointer = { pointerId: number; screenX: number; screenY: number }

/**
 * Translates pointer, wheel and keyboard input into camera moves.
 *
 * Deliberately outside React: a pan issues one camera write and one render request per
 * pointer event, with no component re-render and no synthetic event allocation.
 */
export class ViewportInputController {
  private readonly element: HTMLElement
  private readonly engine: ViewportRenderEngine
  private readonly shouldStartPan: (event: PointerEvent) => boolean
  private readonly onFitDocumentRequested?: () => void

  private readonly activePointers = new Map<number, ActivePointer>()
  private panPointerId: number | null = null
  private lastPanScreenX = 0
  private lastPanScreenY = 0
  private isSpaceKeyHeld = false

  private pinchStartDistance = 0
  private pinchStartScale = 1

  constructor(options: ViewportInputControllerOptions) {
    this.element = options.element
    this.engine = options.engine
    this.shouldStartPan = options.shouldStartPan ?? (() => true)
    this.onFitDocumentRequested = options.onFitDocumentRequested

    this.element.style.touchAction = 'none'
    this.element.tabIndex = 0
    this.updateCursor()

    this.element.addEventListener('pointerdown', this.handlePointerDown)
    this.element.addEventListener('pointermove', this.handlePointerMove)
    this.element.addEventListener('pointerup', this.handlePointerUp)
    this.element.addEventListener('pointercancel', this.handlePointerUp)
    this.element.addEventListener('wheel', this.handleWheel, { passive: false })
    this.element.addEventListener('keydown', this.handleKeyDown)
    this.element.addEventListener('keyup', this.handleKeyUp)
    this.element.addEventListener('blur', this.handleBlur)
  }

  dispose(): void {
    this.element.removeEventListener('pointerdown', this.handlePointerDown)
    this.element.removeEventListener('pointermove', this.handlePointerMove)
    this.element.removeEventListener('pointerup', this.handlePointerUp)
    this.element.removeEventListener('pointercancel', this.handlePointerUp)
    this.element.removeEventListener('wheel', this.handleWheel)
    this.element.removeEventListener('keydown', this.handleKeyDown)
    this.element.removeEventListener('keyup', this.handleKeyUp)
    this.element.removeEventListener('blur', this.handleBlur)
    this.activePointers.clear()
  }

  getScreenPoint(event: PointerEvent | WheelEvent): { x: number; y: number } {
    const bounds = this.element.getBoundingClientRect()
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
  }

  private get isPanning(): boolean {
    return this.panPointerId !== null
  }

  private updateCursor(): void {
    this.element.style.cursor = this.isPanning ? 'grabbing' : this.isSpaceKeyHeld ? 'grab' : 'default'
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    this.element.focus({ preventScroll: true })
    const screenPoint = this.getScreenPoint(event)
    this.activePointers.set(event.pointerId, {
      pointerId: event.pointerId,
      screenX: screenPoint.x,
      screenY: screenPoint.y,
    })

    if (this.activePointers.size === 2) {
      this.beginPinch()
      return
    }

    const isMiddleButton = event.button === 1
    const isPanRequested = isMiddleButton || this.isSpaceKeyHeld || this.shouldStartPan(event)
    if (!isPanRequested) {
      return
    }

    this.panPointerId = event.pointerId
    this.lastPanScreenX = screenPoint.x
    this.lastPanScreenY = screenPoint.y
    this.element.setPointerCapture(event.pointerId)
    this.updateCursor()
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const screenPoint = this.getScreenPoint(event)
    const tracked = this.activePointers.get(event.pointerId)
    if (tracked) {
      tracked.screenX = screenPoint.x
      tracked.screenY = screenPoint.y
    }

    if (this.activePointers.size >= 2) {
      this.updatePinch()
      return
    }

    if (this.panPointerId !== event.pointerId) {
      return
    }

    this.engine.panByScreenDelta(
      screenPoint.x - this.lastPanScreenX,
      screenPoint.y - this.lastPanScreenY,
    )
    this.lastPanScreenX = screenPoint.x
    this.lastPanScreenY = screenPoint.y
  }

  private readonly handlePointerUp = (event: PointerEvent): void => {
    this.activePointers.delete(event.pointerId)

    if (this.panPointerId === event.pointerId) {
      this.panPointerId = null
      if (this.element.hasPointerCapture(event.pointerId)) {
        this.element.releasePointerCapture(event.pointerId)
      }
      this.updateCursor()
    }

    if (this.activePointers.size < 2) {
      this.pinchStartDistance = 0
    }
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault()

    const screenPoint = this.getScreenPoint(event)
    const normalizedDeltaY = normalizeWheelDelta(event)
    // Trackpad pinch arrives as a wheel event with `ctrlKey` set.
    const sensitivity = event.ctrlKey ? PINCH_ZOOM_SENSITIVITY : WHEEL_ZOOM_SENSITIVITY

    this.engine.zoomByWheelDelta(screenPoint.x, screenPoint.y, normalizedDeltaY, sensitivity)
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Space' && !this.isSpaceKeyHeld) {
      this.isSpaceKeyHeld = true
      this.updateCursor()
      event.preventDefault()
      return
    }

    switch (event.key) {
      case 'ArrowLeft':
        this.engine.panByScreenDelta(KEYBOARD_PAN_STEP_IN_SCREEN_PIXELS, 0)
        break
      case 'ArrowRight':
        this.engine.panByScreenDelta(-KEYBOARD_PAN_STEP_IN_SCREEN_PIXELS, 0)
        break
      case 'ArrowUp':
        this.engine.panByScreenDelta(0, KEYBOARD_PAN_STEP_IN_SCREEN_PIXELS)
        break
      case 'ArrowDown':
        this.engine.panByScreenDelta(0, -KEYBOARD_PAN_STEP_IN_SCREEN_PIXELS)
        break
      case '+':
      case '=':
        this.zoomAtViewportCenter(this.engine.getCamera().scale * KEYBOARD_ZOOM_STEP)
        break
      case '-':
      case '_':
        this.zoomAtViewportCenter(this.engine.getCamera().scale / KEYBOARD_ZOOM_STEP)
        break
      case '1':
        this.zoomAtViewportCenter(1)
        break
      case '0':
        this.onFitDocumentRequested?.()
        break
      default:
        return
    }

    event.preventDefault()
  }

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    if (event.code === 'Space') {
      this.isSpaceKeyHeld = false
      this.updateCursor()
    }
  }

  private readonly handleBlur = (): void => {
    this.isSpaceKeyHeld = false
    this.panPointerId = null
    this.activePointers.clear()
    this.updateCursor()
  }

  private zoomAtViewportCenter(requestedScale: number): void {
    const viewportSize = this.engine.getViewportSize()
    this.engine.zoomAtScreenPoint(
      viewportSize.width / 2,
      viewportSize.height / 2,
      clampZoomScale(requestedScale),
    )
  }

  private getPinchState(): { midpointX: number; midpointY: number; distance: number } | null {
    const pointers = [...this.activePointers.values()]
    if (pointers.length < 2) {
      return null
    }
    const [first, second] = pointers
    return {
      midpointX: (first.screenX + second.screenX) / 2,
      midpointY: (first.screenY + second.screenY) / 2,
      distance: Math.hypot(second.screenX - first.screenX, second.screenY - first.screenY),
    }
  }

  private beginPinch(): void {
    const pinch = this.getPinchState()
    if (!pinch || pinch.distance < 1) {
      return
    }
    this.panPointerId = null
    this.pinchStartDistance = pinch.distance
    this.pinchStartScale = this.engine.getCamera().scale
    this.updateCursor()
  }

  private updatePinch(): void {
    const pinch = this.getPinchState()
    if (!pinch || this.pinchStartDistance < 1) {
      return
    }
    this.engine.zoomAtScreenPoint(
      pinch.midpointX,
      pinch.midpointY,
      this.pinchStartScale * (pinch.distance / this.pinchStartDistance),
    )
  }
}

/** Wheel deltas arrive in pixels, lines or pages depending on the input device. */
export function normalizeWheelDelta(event: WheelEvent): number {
  switch (event.deltaMode) {
    case 1:
      return event.deltaY * 16
    case 2:
      return event.deltaY * 100
    default:
      return event.deltaY
  }
}

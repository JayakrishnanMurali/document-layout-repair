import type { Point } from '@/canvas/geometry'
import type {
  PointerGestureContext,
  PointerGestureHandler,
} from '@/canvas/interaction/pointerGestures'
import { clampZoomScale, screenToWorld } from '@/canvas/viewport/camera'
import type { ViewportRenderEngine } from '@/canvas/ViewportRenderEngine'

const WHEEL_ZOOM_SENSITIVITY = 0.0016
const PINCH_ZOOM_SENSITIVITY = 0.011
const KEYBOARD_PAN_STEP_IN_SCREEN_PIXELS = 80
const KEYBOARD_ZOOM_STEP = 1.25
/** A pointer that moves less than this between down and up counts as a click. */
const TAP_MOVEMENT_TOLERANCE_IN_SCREEN_PIXELS = 4
const TAP_DURATION_LIMIT_MILLISECONDS = 500

export type ViewportInputControllerOptions = {
  element: HTMLElement
  engine: ViewportRenderEngine
  /** Editing tools, consulted in order when a press begins. */
  gestureHandlers?: PointerGestureHandler[]
  onFitDocumentRequested?: () => void
  /** Fired for a press that no handler claimed and that did not turn into a pan. */
  onTap?: (worldPoint: Point, event: PointerEvent) => void
  /** Called with the hovered world point, or null when the pointer leaves. */
  onHover?: (worldPoint: Point | null) => void
}

type ActivePointer = { screenX: number; screenY: number }

/**
 * Translates pointer, wheel and keyboard input into camera moves and tool gestures.
 *
 * Deliberately outside React: a pan issues one camera write and one render request per
 * pointer event, with no component re-render and no synthetic event allocation.
 */
export class ViewportInputController {
  private readonly element: HTMLElement
  private readonly engine: ViewportRenderEngine
  private readonly onFitDocumentRequested?: () => void
  private readonly onTap?: (worldPoint: Point, event: PointerEvent) => void
  private readonly onHover?: (worldPoint: Point | null) => void

  private gestureHandlers: PointerGestureHandler[]
  private activeGestureHandler: PointerGestureHandler | null = null

  private readonly activePointers = new Map<number, ActivePointer>()
  private panPointerId: number | null = null
  private lastPanScreenX = 0
  private lastPanScreenY = 0
  private isSpaceKeyHeld = false

  private pinchStartDistance = 0
  private pinchStartScale = 1

  private pressStartScreenX = 0
  private pressStartScreenY = 0
  private pressStartTimestamp = 0
  private hasPressMovedBeyondTapTolerance = false

  private readonly gestureContext: PointerGestureContext = {
    worldPoint: { x: 0, y: 0 },
    screenPoint: { x: 0, y: 0 },
    screenPixelsPerWorldUnit: 1,
  }

  constructor(options: ViewportInputControllerOptions) {
    this.element = options.element
    this.engine = options.engine
    this.gestureHandlers = options.gestureHandlers ?? []
    this.onFitDocumentRequested = options.onFitDocumentRequested
    this.onTap = options.onTap
    this.onHover = options.onHover

    this.element.style.touchAction = 'none'
    this.element.tabIndex = 0
    this.updateCursor(null)

    this.element.addEventListener('pointerdown', this.handlePointerDown)
    this.element.addEventListener('pointermove', this.handlePointerMove)
    this.element.addEventListener('pointerup', this.handlePointerUp)
    this.element.addEventListener('pointercancel', this.handlePointerCancel)
    this.element.addEventListener('pointerleave', this.handlePointerLeave)
    this.element.addEventListener('wheel', this.handleWheel, { passive: false })
    this.element.addEventListener('keydown', this.handleKeyDown)
    this.element.addEventListener('keyup', this.handleKeyUp)
    this.element.addEventListener('blur', this.handleBlur)
    this.element.addEventListener('contextmenu', this.handleContextMenu)
  }

  setGestureHandlers(gestureHandlers: PointerGestureHandler[]): void {
    this.gestureHandlers = gestureHandlers
  }

  dispose(): void {
    this.element.removeEventListener('pointerdown', this.handlePointerDown)
    this.element.removeEventListener('pointermove', this.handlePointerMove)
    this.element.removeEventListener('pointerup', this.handlePointerUp)
    this.element.removeEventListener('pointercancel', this.handlePointerCancel)
    this.element.removeEventListener('pointerleave', this.handlePointerLeave)
    this.element.removeEventListener('wheel', this.handleWheel)
    this.element.removeEventListener('keydown', this.handleKeyDown)
    this.element.removeEventListener('keyup', this.handleKeyUp)
    this.element.removeEventListener('blur', this.handleBlur)
    this.element.removeEventListener('contextmenu', this.handleContextMenu)
    this.activePointers.clear()
  }

  private get isPanning(): boolean {
    return this.panPointerId !== null
  }

  private getScreenPoint(event: PointerEvent | WheelEvent): Point {
    const bounds = this.element.getBoundingClientRect()
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
  }

  /** Fills and returns the reused gesture context for the given pointer position. */
  private updateGestureContext(screenPoint: Point): PointerGestureContext {
    const camera = this.engine.getCamera()
    const worldPoint = screenToWorld(camera, screenPoint)
    this.gestureContext.screenPoint.x = screenPoint.x
    this.gestureContext.screenPoint.y = screenPoint.y
    this.gestureContext.worldPoint.x = worldPoint.x
    this.gestureContext.worldPoint.y = worldPoint.y
    this.gestureContext.screenPixelsPerWorldUnit = camera.scale
    return this.gestureContext
  }

  private updateCursor(hoverCursor: string | null): void {
    this.element.style.cursor = this.isPanning
      ? 'grabbing'
      : this.isSpaceKeyHeld
        ? 'grab'
        : (hoverCursor ?? 'default')
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    this.element.focus({ preventScroll: true })
    const screenPoint = this.getScreenPoint(event)
    this.pressStartScreenX = screenPoint.x
    this.pressStartScreenY = screenPoint.y
    this.pressStartTimestamp = event.timeStamp
    this.hasPressMovedBeyondTapTolerance = false
    this.activePointers.set(event.pointerId, { screenX: screenPoint.x, screenY: screenPoint.y })

    if (this.activePointers.size === 2) {
      this.beginPinch()
      return
    }

    const isPrimaryButton = event.button === 0
    const context = this.updateGestureContext(screenPoint)

    if (isPrimaryButton && !this.isSpaceKeyHeld) {
      for (const handler of this.gestureHandlers) {
        if (handler.onPointerDown(event, context)) {
          this.activeGestureHandler = handler
          this.element.setPointerCapture(event.pointerId)
          return
        }
      }
    }

    this.panPointerId = event.pointerId
    this.lastPanScreenX = screenPoint.x
    this.lastPanScreenY = screenPoint.y
    this.element.setPointerCapture(event.pointerId)
    this.updateCursor(null)
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

    if (
      Math.abs(screenPoint.x - this.pressStartScreenX) > TAP_MOVEMENT_TOLERANCE_IN_SCREEN_PIXELS ||
      Math.abs(screenPoint.y - this.pressStartScreenY) > TAP_MOVEMENT_TOLERANCE_IN_SCREEN_PIXELS
    ) {
      this.hasPressMovedBeyondTapTolerance = true
    }

    const context = this.updateGestureContext(screenPoint)

    if (this.activeGestureHandler) {
      this.activeGestureHandler.onPointerMove(event, context)
      return
    }

    if (this.panPointerId === event.pointerId) {
      this.engine.panByScreenDelta(
        screenPoint.x - this.lastPanScreenX,
        screenPoint.y - this.lastPanScreenY,
      )
      this.lastPanScreenX = screenPoint.x
      this.lastPanScreenY = screenPoint.y
      return
    }

    this.onHover?.(context.worldPoint)
    this.updateCursor(this.resolveHoverCursor(context))
  }

  private readonly handlePointerUp = (event: PointerEvent): void => {
    this.activePointers.delete(event.pointerId)
    const screenPoint = this.getScreenPoint(event)
    const context = this.updateGestureContext(screenPoint)

    if (this.activeGestureHandler) {
      this.activeGestureHandler.onPointerUp(event, context)
      this.activeGestureHandler = null
      this.releasePointer(event.pointerId)
      return
    }

    const isTap =
      !this.hasPressMovedBeyondTapTolerance &&
      event.timeStamp - this.pressStartTimestamp < TAP_DURATION_LIMIT_MILLISECONDS

    if (this.panPointerId === event.pointerId) {
      this.panPointerId = null
      this.releasePointer(event.pointerId)
      this.updateCursor(null)
    }

    if (isTap && !this.isSpaceKeyHeld) {
      this.onTap?.(context.worldPoint, event)
    }

    if (this.activePointers.size < 2) {
      this.pinchStartDistance = 0
    }
  }

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    this.activePointers.delete(event.pointerId)
    this.cancelActiveGesture()
    if (this.panPointerId === event.pointerId) {
      this.panPointerId = null
      this.releasePointer(event.pointerId)
    }
    this.updateCursor(null)
  }

  private readonly handlePointerLeave = (): void => {
    if (!this.activeGestureHandler && !this.isPanning) {
      this.onHover?.(null)
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
      this.updateCursor(null)
      event.preventDefault()
      return
    }

    if (event.key === 'Escape') {
      this.cancelActiveGesture()
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
      this.updateCursor(null)
    }
  }

  private readonly handleBlur = (): void => {
    this.isSpaceKeyHeld = false
    this.panPointerId = null
    this.cancelActiveGesture()
    this.activePointers.clear()
    this.updateCursor(null)
  }

  private readonly handleContextMenu = (event: Event): void => {
    event.preventDefault()
  }

  private resolveHoverCursor(context: PointerGestureContext): string | null {
    for (const handler of this.gestureHandlers) {
      const cursor = handler.getCursor?.(context)
      if (cursor) {
        return cursor
      }
    }
    return null
  }

  private cancelActiveGesture(): void {
    this.activeGestureHandler?.onCancel()
    this.activeGestureHandler = null
  }

  private releasePointer(pointerId: number): void {
    if (this.element.hasPointerCapture(pointerId)) {
      this.element.releasePointerCapture(pointerId)
    }
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
    this.cancelActiveGesture()
    this.panPointerId = null
    this.pinchStartDistance = pinch.distance
    this.pinchStartScale = this.engine.getCamera().scale
    this.updateCursor(null)
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

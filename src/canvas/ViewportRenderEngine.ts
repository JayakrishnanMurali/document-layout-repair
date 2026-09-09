import type { Rect, Size } from '@/canvas/geometry'
import { FrameStatistics, type FrameStatisticsSnapshot } from '@/canvas/FrameStatistics'
import { RenderScheduler } from '@/canvas/RenderScheduler'
import type { CanvasBackingSize, RenderFrame, RenderLayer } from '@/canvas/renderTypes'
import {
  createCamera,
  getVisibleWorldRect,
  panCameraByScreenDelta,
  scaleFromWheelDelta,
  zoomCameraAtScreenPoint,
  type Camera,
} from '@/canvas/viewport/camera'

const STATISTICS_INTERVAL_MILLISECONDS = 250

export type ViewportRenderEngineOptions = {
  container: HTMLElement
  pageCount: number
  onStatistics?: (statistics: FrameStatisticsSnapshot) => void
  onCameraChange?: (camera: Camera) => void
}

/**
 * Owns the stacked canvases, the camera, and the single render loop that drives them.
 *
 * React never participates in a frame: it mounts the container, and everything after
 * that is imperative. Per-layer dirty flags mean a pointer move that only affects
 * handles repaints the interaction layer alone.
 */
export class ViewportRenderEngine {
  private readonly container: HTMLElement
  private readonly canvases: HTMLCanvasElement[] = []
  private readonly layers: RenderLayer[] = []
  private readonly dirtyLayerNames = new Set<string>()
  private readonly scheduler: RenderScheduler
  private readonly frameStatistics = new FrameStatistics()
  private readonly resizeObserver: ResizeObserver
  private readonly statisticsIntervalHandle: number

  private readonly onStatistics?: (statistics: FrameStatisticsSnapshot) => void
  private readonly onCameraChange?: (camera: Camera) => void

  /** Reused across frames so a continuous pan allocates nothing per frame. */
  private readonly frame: RenderFrame = {
    camera: createCamera(0, 0, 0.5),
    viewportSize: { width: 0, height: 0 },
    devicePixelRatio: 1,
    visibleWorldRect: { x: 0, y: 0, width: 0, height: 0 },
    pageCount: 0,
    timestampMilliseconds: 0,
  }

  private camera: Camera = createCamera(0, 0, 0.5)
  private viewportSize: Size = { width: 0, height: 0 }
  private devicePixelRatio = 1
  private pageCount: number
  private isDisposed = false

  constructor(options: ViewportRenderEngineOptions) {
    this.container = options.container
    this.pageCount = options.pageCount
    this.onStatistics = options.onStatistics
    this.onCameraChange = options.onCameraChange

    this.scheduler = new RenderScheduler(this.renderFrame)
    this.resizeObserver = new ResizeObserver(this.handleContainerResize)
    this.resizeObserver.observe(this.container)
    this.statisticsIntervalHandle = window.setInterval(
      this.emitStatistics,
      STATISTICS_INTERVAL_MILLISECONDS,
    )
    this.measureViewport()
  }

  /** Creates the next canvas in the stack. Call order defines paint order. */
  createLayerCanvas(): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    canvas.style.position = 'absolute'
    canvas.style.inset = '0'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.display = 'block'
    this.container.append(canvas)
    this.canvases.push(canvas)
    this.applyBackingSizeToCanvas(canvas, this.getBackingSize())
    return canvas
  }

  addLayer(layer: RenderLayer): void {
    this.layers.push(layer)
    layer.resize(this.getBackingSize())
    this.markDirty(layer.name)
  }

  getCamera(): Camera {
    return this.camera
  }

  getViewportSize(): Size {
    return this.viewportSize
  }

  getVisibleWorldRect(): Rect {
    return getVisibleWorldRect(this.camera, this.viewportSize)
  }

  setCamera(camera: Camera): void {
    if (
      camera.worldX === this.camera.worldX &&
      camera.worldY === this.camera.worldY &&
      camera.scale === this.camera.scale
    ) {
      return
    }
    this.camera = camera
    this.markAllDirty()
    this.onCameraChange?.(camera)
  }

  panByScreenDelta(deltaX: number, deltaY: number): void {
    this.setCamera(panCameraByScreenDelta(this.camera, deltaX, deltaY))
  }

  zoomAtScreenPoint(screenAnchorX: number, screenAnchorY: number, requestedScale: number): void {
    this.setCamera(
      zoomCameraAtScreenPoint(this.camera, { x: screenAnchorX, y: screenAnchorY }, requestedScale),
    )
  }

  zoomByWheelDelta(
    screenAnchorX: number,
    screenAnchorY: number,
    wheelDeltaY: number,
    sensitivity: number,
  ): void {
    this.zoomAtScreenPoint(
      screenAnchorX,
      screenAnchorY,
      scaleFromWheelDelta(this.camera.scale, wheelDeltaY, sensitivity),
    )
  }

  setPageCount(pageCount: number): void {
    this.pageCount = pageCount
    this.markAllDirty()
  }

  markDirty(layerName: string): void {
    this.dirtyLayerNames.add(layerName)
    this.scheduler.requestFrame()
  }

  markAllDirty(): void {
    for (const layer of this.layers) {
      this.dirtyLayerNames.add(layer.name)
    }
    this.scheduler.requestFrame()
  }

  getFrameStatistics(): FrameStatisticsSnapshot {
    return this.frameStatistics.snapshot(performance.now())
  }

  dispose(): void {
    this.isDisposed = true
    window.clearInterval(this.statisticsIntervalHandle)
    this.resizeObserver.disconnect()
    this.scheduler.stop()
    for (const layer of this.layers) {
      layer.dispose()
    }
    this.layers.length = 0
    for (const canvas of this.canvases) {
      canvas.remove()
    }
    this.canvases.length = 0
  }

  private getBackingSize(): CanvasBackingSize {
    return {
      cssWidth: this.viewportSize.width,
      cssHeight: this.viewportSize.height,
      deviceWidth: Math.round(this.viewportSize.width * this.devicePixelRatio),
      deviceHeight: Math.round(this.viewportSize.height * this.devicePixelRatio),
      devicePixelRatio: this.devicePixelRatio,
    }
  }

  private applyBackingSizeToCanvas(
    canvas: HTMLCanvasElement,
    backingSize: CanvasBackingSize,
  ): void {
    canvas.width = backingSize.deviceWidth
    canvas.height = backingSize.deviceHeight
  }

  private measureViewport(): void {
    const cssWidth = this.container.clientWidth
    const cssHeight = this.container.clientHeight
    const nextDevicePixelRatio = window.devicePixelRatio || 1

    if (
      cssWidth === this.viewportSize.width &&
      cssHeight === this.viewportSize.height &&
      nextDevicePixelRatio === this.devicePixelRatio
    ) {
      return
    }

    this.viewportSize = { width: cssWidth, height: cssHeight }
    this.devicePixelRatio = nextDevicePixelRatio

    const backingSize = this.getBackingSize()
    for (const canvas of this.canvases) {
      this.applyBackingSizeToCanvas(canvas, backingSize)
    }
    for (const layer of this.layers) {
      layer.resize(backingSize)
    }
    this.markAllDirty()
  }

  private readonly handleContainerResize = (): void => {
    this.measureViewport()
  }

  private readonly renderFrame = (timestampMilliseconds: number): void => {
    if (this.isDisposed || this.viewportSize.width === 0 || this.viewportSize.height === 0) {
      return
    }

    // A window dragged between displays changes DPR without resizing the container.
    if ((window.devicePixelRatio || 1) !== this.devicePixelRatio) {
      this.measureViewport()
    }

    const frameStartedAt = performance.now()
    const { frame } = this
    frame.camera = this.camera
    frame.viewportSize = this.viewportSize
    frame.devicePixelRatio = this.devicePixelRatio
    frame.pageCount = this.pageCount
    frame.timestampMilliseconds = timestampMilliseconds
    frame.visibleWorldRect.x = this.camera.worldX
    frame.visibleWorldRect.y = this.camera.worldY
    frame.visibleWorldRect.width = this.viewportSize.width / this.camera.scale
    frame.visibleWorldRect.height = this.viewportSize.height / this.camera.scale

    for (const layer of this.layers) {
      if (this.dirtyLayerNames.has(layer.name)) {
        layer.render(frame)
      }
    }
    this.dirtyLayerNames.clear()

    this.frameStatistics.recordFrame(performance.now() - frameStartedAt, timestampMilliseconds)
  }

  private readonly emitStatistics = (): void => {
    this.onStatistics?.(this.frameStatistics.snapshot(performance.now()))
  }
}

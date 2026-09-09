import { Canvas2DOverlayRenderer } from '@/canvas/overlay/Canvas2DOverlayRenderer'
import {
  OverlayInstanceBuffer,
  type OverlayCullStatistics,
} from '@/canvas/overlay/OverlayInstanceBuffer'
import { WebGl2OverlayRenderer } from '@/canvas/overlay/WebGl2OverlayRenderer'
import type { CanvasBackingSize, RenderFrame, RenderLayer } from '@/canvas/renderTypes'
import type { LayoutDocument } from '@/document/layoutTypes'

export type OverlayRendererKind = 'webgl2' | 'canvas2d'

export type OverlayBoxLayerStatistics = OverlayCullStatistics & {
  rendererKind: OverlayRendererKind
  uploadCount: number
}

export type OverlayBoxLayerOptions = {
  canvas: HTMLCanvasElement
  getDocument: () => LayoutDocument | null
  /** Debug switch: with culling off, every box in the document is submitted. */
  getIsCullingEnabled: () => boolean
  onContextRestored: () => void
}

/**
 * Middle layer: the bounding-box overlay.
 *
 * All 10k+ boxes go through one packed instance buffer. On WebGL2 that becomes a single
 * instanced draw call; the 2D path is a fallback that reads the same buffer. Selection
 * and hover are deliberately *not* drawn here — they live on the interaction layer, so
 * moving the pointer never touches this buffer.
 */
export class OverlayBoxLayer implements RenderLayer {
  readonly name = 'overlayBoxes'

  private readonly canvas: HTMLCanvasElement
  private readonly getDocument: () => LayoutDocument | null
  private readonly getIsCullingEnabled: () => boolean
  private readonly onContextRestored: () => void
  private readonly instances = new OverlayInstanceBuffer()

  private webglRenderer: WebGl2OverlayRenderer | null = null
  private canvas2dRenderer: Canvas2DOverlayRenderer | null = null
  private backingSize: CanvasBackingSize | null = null
  private uploadCount = 0
  private documentVersion = 0
  private lastRenderedDocumentVersion = -1

  constructor(options: OverlayBoxLayerOptions) {
    this.canvas = options.canvas
    this.getDocument = options.getDocument
    this.getIsCullingEnabled = options.getIsCullingEnabled
    this.onContextRestored = options.onContextRestored

    this.canvas.addEventListener('webglcontextlost', this.handleContextLost)
    this.canvas.addEventListener('webglcontextrestored', this.handleContextRestored)
    this.createRenderer()
  }

  get rendererKind(): OverlayRendererKind {
    return this.webglRenderer ? 'webgl2' : 'canvas2d'
  }

  get statistics(): OverlayBoxLayerStatistics {
    return {
      ...this.instances.statistics,
      rendererKind: this.rendererKind,
      uploadCount: this.uploadCount,
    }
  }

  /** Called when the document is replaced or edited, forcing a re-cull. */
  invalidateDocument(): void {
    this.documentVersion += 1
    this.instances.invalidate()
  }

  resize(backingSize: CanvasBackingSize): void {
    this.backingSize = backingSize
    this.webglRenderer?.setViewport(backingSize.deviceWidth, backingSize.deviceHeight)
    // A resize changes which boxes are visible, so the culled set is stale.
    this.instances.invalidate()
  }

  render(frame: RenderFrame): void {
    if (!this.backingSize) {
      return
    }

    const devicePixelsPerWorldUnit = frame.camera.scale * frame.devicePixelRatio
    const layoutDocument = this.getDocument()

    const wasRepacked =
      this.instances.update(
        layoutDocument,
        frame.pageLayout,
        frame.visibleWorldRect,
        devicePixelsPerWorldUnit,
        this.getIsCullingEnabled(),
      ) ||
      this.lastRenderedDocumentVersion !== this.documentVersion
    this.lastRenderedDocumentVersion = this.documentVersion

    if (this.webglRenderer) {
      this.webglRenderer.clear()
      if (wasRepacked) {
        this.webglRenderer.uploadInstances(this.instances.bytes)
        this.uploadCount += 1
      }
      this.webglRenderer.draw(
        frame.camera,
        frame.viewportSize,
        devicePixelsPerWorldUnit,
        this.instances.instanceCount,
      )
      return
    }

    if (this.canvas2dRenderer) {
      this.canvas2dRenderer.clear(this.backingSize)
      this.canvas2dRenderer.draw(
        this.instances,
        frame.camera,
        frame.devicePixelRatio,
        devicePixelsPerWorldUnit,
      )
    }
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost)
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored)
    this.webglRenderer?.dispose()
    this.webglRenderer = null
    this.canvas2dRenderer = null
  }

  private createRenderer(): void {
    this.webglRenderer = WebGl2OverlayRenderer.create(this.canvas)
    if (this.webglRenderer) {
      if (this.backingSize) {
        this.webglRenderer.setViewport(this.backingSize.deviceWidth, this.backingSize.deviceHeight)
      }
      return
    }

    const context = this.canvas.getContext('2d')
    this.canvas2dRenderer = context ? new Canvas2DOverlayRenderer(context) : null
    if (!this.canvas2dRenderer) {
      throw new Error('Neither WebGL2 nor a 2D context is available for the overlay layer')
    }
  }

  private readonly handleContextLost = (event: Event): void => {
    // Preventing the default is what allows the context to be restored at all.
    event.preventDefault()
    this.webglRenderer = null
  }

  private readonly handleContextRestored = (): void => {
    this.createRenderer()
    this.instances.invalidate()
    this.onContextRestored()
  }
}

import type { Rect, Size } from '@/canvas/geometry'
import type { Camera } from '@/canvas/viewport/camera'
import type { DocumentPageLayout } from '@/document/pageLayout'

/** Canvas sizing in both CSS and device pixels, recomputed on resize or DPR change. */
export type CanvasBackingSize = {
  cssWidth: number
  cssHeight: number
  deviceWidth: number
  deviceHeight: number
  devicePixelRatio: number
}

/** Everything a layer needs for one frame. Reused between frames — never retained. */
export type RenderFrame = {
  camera: Camera
  viewportSize: Size
  devicePixelRatio: number
  visibleWorldRect: Rect
  pageLayout: DocumentPageLayout
  timestampMilliseconds: number
}

export interface RenderLayer {
  readonly name: string
  resize(backingSize: CanvasBackingSize): void
  render(frame: RenderFrame): void
  dispose(): void
}

export type RenderLayerFactory = (canvas: HTMLCanvasElement) => RenderLayer

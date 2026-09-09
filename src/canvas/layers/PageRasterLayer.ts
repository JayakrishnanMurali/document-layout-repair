import { rectsIntersect, type Rect } from '@/canvas/geometry'
import type { CanvasBackingSize, RenderFrame, RenderLayer } from '@/canvas/renderTypes'
import { PageRasterCache } from '@/canvas/textures/PageRasterCache'
import {
  THUMBNAIL_ONLY_TEXELS_PER_WORLD_UNIT,
  getTileBoundsInPage,
  getVisibleTileRange,
  selectTileLevelIndex,
} from '@/canvas/textures/pageTileGrid'
import { applyWorldTransformToContext } from '@/canvas/viewport/camera'
import { computePageBounds, getVisiblePageRange } from '@/document/pageLayout'

const WORKSPACE_BACKGROUND_COLOR = '#0b0e13'
const PAPER_FALLBACK_COLOR = '#f6f4ef'
const PAGE_SHADOW_COLOR = 'rgba(0, 0, 0, 0.45)'
const PAGE_BORDER_COLOR = 'rgba(0, 0, 0, 0.55)'
const PAGE_SHADOW_OFFSET_IN_WORLD_UNITS = 10

/**
 * Bottom layer: composites page rasters produced by the raster worker. It draws paper,
 * never ink — all glyph painting happens off the main thread.
 *
 * Refinement is progressive: the whole-page thumbnail is stretched under the tiles, so a
 * newly revealed page is never blank and never shows gaps while tiles stream in.
 */
export class PageRasterLayer implements RenderLayer {
  readonly name = 'pageRaster'

  private readonly context: CanvasRenderingContext2D
  private readonly rasterCache: PageRasterCache
  private backingSize: CanvasBackingSize | null = null
  private lastDrawnTileCount = 0

  constructor(canvas: HTMLCanvasElement, documentSeed: number, onRasterReady: () => void) {
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) {
      throw new Error('Could not acquire a 2D context for the page raster layer')
    }
    this.context = context
    this.rasterCache = new PageRasterCache(documentSeed, onRasterReady)
  }

  get statistics() {
    return { ...this.rasterCache.statistics, drawnTileCount: this.lastDrawnTileCount }
  }

  setDocumentSeed(documentSeed: number): void {
    this.rasterCache.reset(documentSeed)
  }

  resize(backingSize: CanvasBackingSize): void {
    this.backingSize = backingSize
  }

  render(frame: RenderFrame): void {
    if (!this.backingSize) {
      return
    }

    const { context } = this
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.fillStyle = WORKSPACE_BACKGROUND_COLOR
    context.fillRect(0, 0, this.backingSize.deviceWidth, this.backingSize.deviceHeight)

    const { firstPageIndex, lastPageIndex } = getVisiblePageRange(
      frame.visibleWorldRect,
      frame.pageCount,
    )
    if (firstPageIndex < 0) {
      this.lastDrawnTileCount = 0
      return
    }

    const neededTexelsPerWorldUnit = frame.camera.scale * frame.devicePixelRatio
    const useTiles = neededTexelsPerWorldUnit > THUMBNAIL_ONLY_TEXELS_PER_WORLD_UNIT
    const tileLevelIndex = selectTileLevelIndex(neededTexelsPerWorldUnit)
    if (useTiles) {
      this.rasterCache.setActiveTileLevel(tileLevelIndex)
    }

    applyWorldTransformToContext(context, frame.camera, frame.devicePixelRatio)
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'

    let drawnTileCount = 0

    for (let pageIndex = firstPageIndex; pageIndex <= lastPageIndex; pageIndex += 1) {
      const pageBounds = computePageBounds(pageIndex)
      this.drawPageBackdrop(pageBounds, frame)

      const thumbnail = this.rasterCache.acquireThumbnail(pageIndex)
      if (thumbnail) {
        context.drawImage(
          thumbnail,
          pageBounds.x,
          pageBounds.y,
          pageBounds.width,
          pageBounds.height,
        )
      }

      if (!useTiles) {
        continue
      }

      const visibleRectInPage = intersectIntoPageLocalRect(frame.visibleWorldRect, pageBounds)
      if (!visibleRectInPage) {
        continue
      }

      const tileRange = getVisibleTileRange(tileLevelIndex, visibleRectInPage)
      if (!tileRange) {
        continue
      }

      for (let tileY = tileRange.firstTileY; tileY <= tileRange.lastTileY; tileY += 1) {
        for (let tileX = tileRange.firstTileX; tileX <= tileRange.lastTileX; tileX += 1) {
          const tileBitmap = this.rasterCache.acquireTile(pageIndex, tileLevelIndex, tileX, tileY)
          if (!tileBitmap) {
            continue
          }
          const tileBounds = getTileBoundsInPage(tileLevelIndex, tileX, tileY)
          context.drawImage(
            tileBitmap,
            pageBounds.x + tileBounds.x,
            pageBounds.y + tileBounds.y,
            tileBounds.width,
            tileBounds.height,
          )
          drawnTileCount += 1
        }
      }
    }

    for (let pageIndex = firstPageIndex; pageIndex <= lastPageIndex; pageIndex += 1) {
      this.strokePageBorder(computePageBounds(pageIndex), frame)
    }

    this.lastDrawnTileCount = drawnTileCount
    context.setTransform(1, 0, 0, 1, 0, 0)
  }

  dispose(): void {
    this.rasterCache.dispose()
  }

  private drawPageBackdrop(pageBounds: Rect, frame: RenderFrame): void {
    const { context } = this
    const shadowOffset = Math.min(
      PAGE_SHADOW_OFFSET_IN_WORLD_UNITS,
      PAGE_SHADOW_OFFSET_IN_WORLD_UNITS / Math.max(frame.camera.scale, 0.25),
    )
    context.fillStyle = PAGE_SHADOW_COLOR
    context.fillRect(
      pageBounds.x + shadowOffset,
      pageBounds.y + shadowOffset,
      pageBounds.width,
      pageBounds.height,
    )
    context.fillStyle = PAPER_FALLBACK_COLOR
    context.fillRect(pageBounds.x, pageBounds.y, pageBounds.width, pageBounds.height)
  }

  private strokePageBorder(pageBounds: Rect, frame: RenderFrame): void {
    const { context } = this
    context.lineWidth = 1 / (frame.camera.scale * frame.devicePixelRatio)
    context.strokeStyle = PAGE_BORDER_COLOR
    context.strokeRect(pageBounds.x, pageBounds.y, pageBounds.width, pageBounds.height)
  }
}

/** Intersection of a world rect with a page, expressed in page-local coordinates. */
function intersectIntoPageLocalRect(worldRect: Rect, pageBounds: Rect): Rect | null {
  if (!rectsIntersect(worldRect, pageBounds)) {
    return null
  }
  const left = Math.max(worldRect.x, pageBounds.x)
  const top = Math.max(worldRect.y, pageBounds.y)
  const right = Math.min(worldRect.x + worldRect.width, pageBounds.x + pageBounds.width)
  const bottom = Math.min(worldRect.y + worldRect.height, pageBounds.y + pageBounds.height)

  return {
    x: left - pageBounds.x,
    y: top - pageBounds.y,
    width: right - left,
    height: bottom - top,
  }
}

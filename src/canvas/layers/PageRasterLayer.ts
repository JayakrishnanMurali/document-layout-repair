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
import { collectVisiblePageIndexes, getPageBounds } from '@/document/pageLayout'

const WORKSPACE_BACKGROUND_COLOR = '#0b0e13'
const PAPER_FALLBACK_COLOR = '#f6f4ef'
const PAGE_SHADOW_COLOR = 'rgba(0, 0, 0, 0.45)'
const PAGE_BORDER_COLOR = 'rgba(0, 0, 0, 0.55)'
const PAGE_SHADOW_OFFSET_IN_WORLD_UNITS = 10

type TileDrawCommand = {
  bitmap: ImageBitmap | null
  x: number
  y: number
  width: number
  height: number
}

type TileCollectionResult = {
  /** Tiles that are cached and ready to composite. */
  readyCount: number
  /** Tiles the visible region needs, cached or not. */
  requiredCount: number
}

export type PageRasterLayerStatistics = {
  cachedTileCount: number
  cachedThumbnailCount: number
  pendingRasterCount: number
  lastRasterMilliseconds: number
  drawnTileCount: number
}

/**
 * Bottom layer: composites page rasters produced by the raster worker. It draws paper,
 * never ink — all glyph painting happens off the main thread.
 *
 * Refinement is progressive: while a page is still missing tiles its whole-page
 * thumbnail is stretched underneath, so a newly revealed page is never blank and never
 * shows gaps. Once every visible tile has arrived the thumbnail is dropped, because
 * upscaling it would only be overdrawn.
 */
export class PageRasterLayer implements RenderLayer {
  readonly name = 'pageRaster'

  private readonly context: CanvasRenderingContext2D
  private readonly rasterCache: PageRasterCache
  private readonly tileDrawPool: TileDrawCommand[] = []

  private backingSize: CanvasBackingSize | null = null
  private drawnTileCount = 0
  private readonly visiblePageIndexes: number[] = []

  constructor(canvas: HTMLCanvasElement, documentSeed: number, onRasterReady: () => void) {
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) {
      throw new Error('Could not acquire a 2D context for the page raster layer')
    }
    this.context = context
    this.rasterCache = new PageRasterCache(documentSeed, onRasterReady)
  }

  get statistics(): PageRasterLayerStatistics {
    return { ...this.rasterCache.statistics, drawnTileCount: this.drawnTileCount }
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

    const visiblePageIndexes = collectVisiblePageIndexes(
      frame.pageLayout,
      frame.visibleWorldRect,
      this.visiblePageIndexes,
    )
    if (visiblePageIndexes.length === 0) {
      this.drawnTileCount = 0
      return
    }

    const neededTexelsPerWorldUnit = frame.camera.scale * frame.devicePixelRatio
    const tileLevelIndex =
      neededTexelsPerWorldUnit > THUMBNAIL_ONLY_TEXELS_PER_WORLD_UNIT
        ? selectTileLevelIndex(neededTexelsPerWorldUnit)
        : -1
    if (tileLevelIndex >= 0) {
      this.rasterCache.setActiveTileLevel(tileLevelIndex)
    }

    applyWorldTransformToContext(context, frame.camera, frame.devicePixelRatio)
    context.imageSmoothingEnabled = true

    let drawnTileCount = 0

    for (const pageIndex of visiblePageIndexes) {
      const pageBounds = getPageBounds(frame.pageLayout, pageIndex)
      const tiles = this.collectTileDrawCommands(pageIndex, pageBounds, frame, tileLevelIndex)
      const isFullyTiled = tiles.requiredCount > 0 && tiles.readyCount === tiles.requiredCount

      this.drawPageShadow(pageBounds, frame)
      if (!isFullyTiled) {
        // Paper under the tiles is invisible once they all arrive, and filling a
        // page-sized rect is one of the most expensive operations in the frame.
        this.drawPaperBase(pageBounds)
        this.drawThumbnailUnderlay(pageIndex, pageBounds, frame)
      }

      context.imageSmoothingQuality = 'high'
      for (let commandIndex = 0; commandIndex < tiles.readyCount; commandIndex += 1) {
        const command = this.tileDrawPool[commandIndex]
        if (!command.bitmap) {
          continue
        }
        context.drawImage(command.bitmap, command.x, command.y, command.width, command.height)
        drawnTileCount += 1
      }
    }

    for (const pageIndex of visiblePageIndexes) {
      this.strokePageBorder(getPageBounds(frame.pageLayout, pageIndex), frame)
    }

    this.drawnTileCount = drawnTileCount
    context.setTransform(1, 0, 0, 1, 0, 0)
  }

  dispose(): void {
    this.rasterCache.dispose()
    this.tileDrawPool.length = 0
  }

  private drawThumbnailUnderlay(pageIndex: number, pageBounds: Rect, frame: RenderFrame): void {
    const thumbnail = this.rasterCache.acquireThumbnail(pageIndex)
    if (!thumbnail) {
      return
    }

    // Magnifying a thumbnail produces a placeholder, not a final image, so the expensive
    // resampling filter is reserved for the minifying case — where it is what keeps a
    // densely printed page legible instead of aliased.
    const drawnDeviceWidth = pageBounds.width * frame.camera.scale * frame.devicePixelRatio
    this.context.imageSmoothingQuality = thumbnail.width >= drawnDeviceWidth ? 'high' : 'low'
    this.context.drawImage(thumbnail, pageBounds.x, pageBounds.y, pageBounds.width, pageBounds.height)
  }

  /**
   * Fills the reusable draw pool with every cached tile covering the visible part of a
   * page. Commands are pooled objects, so compositing a frame allocates nothing.
   */
  private collectTileDrawCommands(
    pageIndex: number,
    pageBounds: Rect,
    frame: RenderFrame,
    tileLevelIndex: number,
  ): TileCollectionResult {
    if (tileLevelIndex < 0) {
      return { readyCount: 0, requiredCount: 0 }
    }

    const visibleRectInPage = intersectIntoPageLocalRect(frame.visibleWorldRect, pageBounds)
    if (!visibleRectInPage) {
      return { readyCount: 0, requiredCount: 0 }
    }

    const tileRange = getVisibleTileRange(tileLevelIndex, visibleRectInPage)
    if (!tileRange) {
      return { readyCount: 0, requiredCount: 0 }
    }

    let readyCount = 0
    let requiredCount = 0

    for (let tileY = tileRange.firstTileY; tileY <= tileRange.lastTileY; tileY += 1) {
      for (let tileX = tileRange.firstTileX; tileX <= tileRange.lastTileX; tileX += 1) {
        requiredCount += 1
        const bitmap = this.rasterCache.acquireTile(pageIndex, tileLevelIndex, tileX, tileY)
        if (!bitmap) {
          continue
        }

        const tileBounds = getTileBoundsInPage(tileLevelIndex, tileX, tileY)
        const command = this.acquireTileDrawCommand(readyCount)
        command.bitmap = bitmap
        command.x = pageBounds.x + tileBounds.x
        command.y = pageBounds.y + tileBounds.y
        command.width = tileBounds.width
        command.height = tileBounds.height
        readyCount += 1
      }
    }

    return { readyCount, requiredCount }
  }

  private acquireTileDrawCommand(index: number): TileDrawCommand {
    const existing = this.tileDrawPool[index]
    if (existing) {
      return existing
    }
    const command: TileDrawCommand = { bitmap: null, x: 0, y: 0, width: 0, height: 0 }
    this.tileDrawPool.push(command)
    return command
  }

  /**
   * Only the two strips the page does not cover are ever visible, so drawing those
   * instead of a full page-sized rect saves a multi-megapixel fill every frame.
   */
  private drawPageShadow(pageBounds: Rect, frame: RenderFrame): void {
    const { context } = this
    const offset = PAGE_SHADOW_OFFSET_IN_WORLD_UNITS / Math.max(frame.camera.scale, 0.25)
    context.fillStyle = PAGE_SHADOW_COLOR
    context.fillRect(pageBounds.x + pageBounds.width, pageBounds.y + offset, offset, pageBounds.height)
    context.fillRect(
      pageBounds.x + offset,
      pageBounds.y + pageBounds.height,
      pageBounds.width,
      offset,
    )
  }

  private drawPaperBase(pageBounds: Rect): void {
    this.context.fillStyle = PAPER_FALLBACK_COLOR
    this.context.fillRect(pageBounds.x, pageBounds.y, pageBounds.width, pageBounds.height)
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

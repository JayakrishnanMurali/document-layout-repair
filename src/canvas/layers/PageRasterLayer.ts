import { rectsIntersect, type Rect } from '@/canvas/geometry'
import type { CanvasBackingSize, RenderFrame, RenderLayer } from '@/canvas/renderTypes'
import { PageRasterCache } from '@/canvas/textures/PageRasterCache'
import {
  THUMBNAIL_ONLY_TEXELS_PER_WORLD_UNIT,
  getTileBoundsInPage,
  getVisibleTileRange,
  selectTileLevelIndex,
} from '@/canvas/textures/pageTileGrid'
import { collectVisiblePageIndexes, getPageBounds } from '@/document/pageLayout'

const WORKSPACE_BACKGROUND_COLOR = '#0b0e13'
const PAPER_FALLBACK_COLOR = '#f6f4ef'
const PAGE_SHADOW_COLOR = 'rgba(0, 0, 0, 0.45)'
const PAGE_BORDER_COLOR = 'rgba(0, 0, 0, 0.55)'
const PAGE_SHADOW_OFFSET_IN_WORLD_UNITS = 10

/** Destination rectangle in device pixels, snapped so neighbouring tiles share edges. */
type TileDrawCommand = {
  bitmap: ImageBitmap | null
  deviceLeft: number
  deviceTop: number
  deviceRight: number
  deviceBottom: number
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
 *
 * Everything here is composited in device pixels with snapped edges rather than through a
 * world transform. Left to the browser, adjacent tiles land on fractional device
 * boundaries and leave hairline gaps — which, over a canvas cleared to the dark workspace
 * colour, read as a black grid across the page.
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

    const devicePixelsPerWorldUnit = frame.camera.scale * frame.devicePixelRatio
    const tileLevelIndex =
      devicePixelsPerWorldUnit > THUMBNAIL_ONLY_TEXELS_PER_WORLD_UNIT
        ? selectTileLevelIndex(devicePixelsPerWorldUnit)
        : -1
    if (tileLevelIndex >= 0) {
      this.rasterCache.setActiveTileLevel(tileLevelIndex)
    }

    context.imageSmoothingEnabled = true
    let drawnTileCount = 0

    for (const pageIndex of visiblePageIndexes) {
      const pageBounds = getPageBounds(frame.pageLayout, pageIndex)
      const pageDeviceLeft = Math.round(
        (pageBounds.x - frame.camera.worldX) * devicePixelsPerWorldUnit,
      )
      const pageDeviceTop = Math.round(
        (pageBounds.y - frame.camera.worldY) * devicePixelsPerWorldUnit,
      )
      const pageDeviceRight = Math.round(
        (pageBounds.x + pageBounds.width - frame.camera.worldX) * devicePixelsPerWorldUnit,
      )
      const pageDeviceBottom = Math.round(
        (pageBounds.y + pageBounds.height - frame.camera.worldY) * devicePixelsPerWorldUnit,
      )

      this.drawPageShadow(
        pageDeviceLeft,
        pageDeviceTop,
        pageDeviceRight,
        pageDeviceBottom,
        frame,
        devicePixelsPerWorldUnit,
      )

      const tiles = this.collectTileDrawCommands(
        pageIndex,
        pageBounds,
        frame,
        devicePixelsPerWorldUnit,
        tileLevelIndex,
      )

      if (tiles.readyCount < tiles.requiredCount || tiles.requiredCount === 0) {
        // Paper and the thumbnail are only needed while tiles are still missing. Once the
        // page is fully tiled they would be overdrawn pixel for pixel, and a page-sized
        // fill is one of the most expensive things in the frame.
        context.fillStyle = PAPER_FALLBACK_COLOR
        context.fillRect(
          pageDeviceLeft,
          pageDeviceTop,
          pageDeviceRight - pageDeviceLeft,
          pageDeviceBottom - pageDeviceTop,
        )
        this.drawThumbnailUnderlay(
          pageIndex,
          pageDeviceLeft,
          pageDeviceTop,
          pageDeviceRight,
          pageDeviceBottom,
        )
      }

      context.imageSmoothingQuality = 'high'
      for (let commandIndex = 0; commandIndex < tiles.readyCount; commandIndex += 1) {
        const command = this.tileDrawPool[commandIndex]
        if (!command.bitmap) {
          continue
        }
        context.drawImage(
          command.bitmap,
          command.deviceLeft,
          command.deviceTop,
          command.deviceRight - command.deviceLeft,
          command.deviceBottom - command.deviceTop,
        )
        drawnTileCount += 1
      }

      this.strokePageBorder(
        pageDeviceLeft,
        pageDeviceTop,
        pageDeviceRight,
        pageDeviceBottom,
        frame,
      )
    }

    this.drawnTileCount = drawnTileCount
  }

  dispose(): void {
    this.rasterCache.dispose()
    this.tileDrawPool.length = 0
  }

  private drawThumbnailUnderlay(
    pageIndex: number,
    deviceLeft: number,
    deviceTop: number,
    deviceRight: number,
    deviceBottom: number,
  ): void {
    const thumbnail = this.rasterCache.acquireThumbnail(pageIndex)
    if (!thumbnail) {
      return
    }

    // Magnifying a thumbnail produces a placeholder, not a final image, so the expensive
    // resampling filter is reserved for the minifying case — where it is what keeps a
    // densely printed page legible instead of aliased.
    this.context.imageSmoothingQuality =
      thumbnail.width >= deviceRight - deviceLeft ? 'high' : 'low'
    this.context.drawImage(
      thumbnail,
      deviceLeft,
      deviceTop,
      deviceRight - deviceLeft,
      deviceBottom - deviceTop,
    )
  }

  /**
   * Fills the reusable draw pool with every cached tile covering the visible part of a
   * page. Commands are pooled objects, so compositing a frame allocates nothing.
   *
   * Each edge is rounded from its world position, so tile `n`'s right edge and tile
   * `n + 1`'s left edge round to the same device pixel and no seam can open between them.
   */
  private collectTileDrawCommands(
    pageIndex: number,
    pageBounds: Rect,
    frame: RenderFrame,
    devicePixelsPerWorldUnit: number,
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

    const toDeviceX = (worldX: number) =>
      Math.round((pageBounds.x + worldX - frame.camera.worldX) * devicePixelsPerWorldUnit)
    const toDeviceY = (worldY: number) =>
      Math.round((pageBounds.y + worldY - frame.camera.worldY) * devicePixelsPerWorldUnit)

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
        command.deviceLeft = toDeviceX(tileBounds.x)
        command.deviceTop = toDeviceY(tileBounds.y)
        command.deviceRight = toDeviceX(tileBounds.x + tileBounds.width)
        command.deviceBottom = toDeviceY(tileBounds.y + tileBounds.height)
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
    const command: TileDrawCommand = {
      bitmap: null,
      deviceLeft: 0,
      deviceTop: 0,
      deviceRight: 0,
      deviceBottom: 0,
    }
    this.tileDrawPool.push(command)
    return command
  }

  /**
   * Only the two strips the page does not cover are ever visible, so drawing those
   * instead of a full page-sized rect saves a multi-megapixel fill every frame.
   */
  private drawPageShadow(
    deviceLeft: number,
    deviceTop: number,
    deviceRight: number,
    deviceBottom: number,
    frame: RenderFrame,
    devicePixelsPerWorldUnit: number,
  ): void {
    const { context } = this
    const offset = Math.max(
      1,
      Math.round(
        (PAGE_SHADOW_OFFSET_IN_WORLD_UNITS / Math.max(frame.camera.scale, 0.25)) *
          devicePixelsPerWorldUnit,
      ),
    )

    context.fillStyle = PAGE_SHADOW_COLOR
    context.fillRect(deviceRight, deviceTop + offset, offset, deviceBottom - deviceTop)
    context.fillRect(deviceLeft + offset, deviceBottom, deviceRight - deviceLeft, offset)
  }

  private strokePageBorder(
    deviceLeft: number,
    deviceTop: number,
    deviceRight: number,
    deviceBottom: number,
    frame: RenderFrame,
  ): void {
    const { context } = this
    const strokeWidth = Math.max(1, Math.round(frame.devicePixelRatio))
    context.lineWidth = strokeWidth
    context.strokeStyle = PAGE_BORDER_COLOR
    // Half-pixel inset puts a one-pixel stroke on a pixel centre rather than across two.
    context.strokeRect(
      deviceLeft + strokeWidth / 2,
      deviceTop + strokeWidth / 2,
      deviceRight - deviceLeft - strokeWidth,
      deviceBottom - deviceTop - strokeWidth,
    )
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

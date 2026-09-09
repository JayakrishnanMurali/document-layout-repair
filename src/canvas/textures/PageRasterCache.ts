import type { PageRasterRequestMessage, PageRasterResponseMessage } from '@/workers/pageRasterProtocol'
import { makePageTileKey, type PageTileKey } from './pageTileGrid'

const MAXIMUM_CACHED_TILES = 96
const MAXIMUM_CACHED_THUMBNAILS = 128

export type PageRasterCacheStatistics = {
  cachedTileCount: number
  cachedThumbnailCount: number
  pendingRasterCount: number
  lastRasterMilliseconds: number
}

type PendingRasterDescriptor =
  | { kind: 'thumbnail'; pageIndex: number }
  | { kind: 'tile'; tileKey: PageTileKey }

/**
 * Owns the page raster worker and an LRU of the `ImageBitmap`s it produces.
 *
 * Bitmaps are backed by GPU/driver memory that garbage collection cannot reclaim on its
 * own, so every eviction and teardown path calls `close()` explicitly.
 */
export class PageRasterCache {
  private readonly worker: Worker
  private readonly tileBitmaps = new Map<PageTileKey, ImageBitmap>()
  private readonly thumbnailBitmaps = new Map<number, ImageBitmap>()
  private readonly pendingTileKeys = new Set<PageTileKey>()
  private readonly pendingThumbnailPageIndexes = new Set<number>()
  private readonly pendingRequests = new Map<number, PendingRasterDescriptor>()
  private readonly onRasterReady: () => void

  private nextRequestId = 1
  private activeTileLevelIndex = -1
  private lastRasterMilliseconds = 0
  private isDisposed = false

  constructor(documentSeed: number, onRasterReady: () => void) {
    this.onRasterReady = onRasterReady
    this.worker = new Worker(new URL('../../workers/pageRaster.worker.ts', import.meta.url), {
      type: 'module',
      name: 'page-raster',
    })
    this.worker.onmessage = this.handleWorkerMessage
    this.postToWorker({ kind: 'configure', documentSeed })
  }

  get statistics(): PageRasterCacheStatistics {
    return {
      cachedTileCount: this.tileBitmaps.size,
      cachedThumbnailCount: this.thumbnailBitmaps.size,
      pendingRasterCount: this.pendingRequests.size,
      lastRasterMilliseconds: this.lastRasterMilliseconds,
    }
  }

  reset(documentSeed: number): void {
    this.postToWorker({ kind: 'configure', documentSeed })
    this.pendingRequests.clear()
    this.pendingTileKeys.clear()
    this.pendingThumbnailPageIndexes.clear()
    this.closeAllBitmaps()
    this.activeTileLevelIndex = -1
  }

  /**
   * Crossing a level-of-detail boundary makes every queued tile obsolete; dropping them
   * keeps the freshest viewport at the front of the worker queue.
   */
  setActiveTileLevel(levelIndex: number): void {
    if (levelIndex === this.activeTileLevelIndex) {
      return
    }
    this.activeTileLevelIndex = levelIndex
    this.postToWorker({ kind: 'dropPendingRequests' })
    this.pendingTileKeys.clear()
    for (const [requestId, descriptor] of this.pendingRequests) {
      if (descriptor.kind === 'tile') {
        this.pendingRequests.delete(requestId)
      }
    }
  }

  /** Returns the bitmap and marks it as recently used, or requests it and returns null. */
  acquireThumbnail(pageIndex: number): ImageBitmap | null {
    const bitmap = this.thumbnailBitmaps.get(pageIndex)
    if (bitmap) {
      this.thumbnailBitmaps.delete(pageIndex)
      this.thumbnailBitmaps.set(pageIndex, bitmap)
      return bitmap
    }

    if (!this.pendingThumbnailPageIndexes.has(pageIndex)) {
      this.pendingThumbnailPageIndexes.add(pageIndex)
      const requestId = this.nextRequestId++
      this.pendingRequests.set(requestId, { kind: 'thumbnail', pageIndex })
      this.postToWorker({ kind: 'renderThumbnail', requestId, pageIndex })
    }

    return null
  }

  acquireTile(
    pageIndex: number,
    levelIndex: number,
    tileX: number,
    tileY: number,
  ): ImageBitmap | null {
    const tileKey = makePageTileKey(pageIndex, levelIndex, tileX, tileY)
    const bitmap = this.tileBitmaps.get(tileKey)
    if (bitmap) {
      this.tileBitmaps.delete(tileKey)
      this.tileBitmaps.set(tileKey, bitmap)
      return bitmap
    }

    if (!this.pendingTileKeys.has(tileKey)) {
      this.pendingTileKeys.add(tileKey)
      const requestId = this.nextRequestId++
      this.pendingRequests.set(requestId, { kind: 'tile', tileKey })
      this.postToWorker({ kind: 'renderTile', requestId, pageIndex, levelIndex, tileX, tileY })
    }

    return null
  }

  dispose(): void {
    this.isDisposed = true
    this.worker.onmessage = null
    this.worker.terminate()
    this.closeAllBitmaps()
    this.pendingRequests.clear()
    this.pendingTileKeys.clear()
    this.pendingThumbnailPageIndexes.clear()
  }

  private readonly handleWorkerMessage = (event: MessageEvent<PageRasterResponseMessage>): void => {
    const message = event.data

    switch (message.kind) {
      case 'thumbnailReady': {
        this.pendingRequests.delete(message.requestId)
        this.pendingThumbnailPageIndexes.delete(message.pageIndex)
        this.lastRasterMilliseconds = message.rasterMilliseconds

        if (this.isDisposed) {
          message.bitmap.close()
          return
        }

        this.thumbnailBitmaps.get(message.pageIndex)?.close()
        this.thumbnailBitmaps.set(message.pageIndex, message.bitmap)
        this.evictOldest(this.thumbnailBitmaps, MAXIMUM_CACHED_THUMBNAILS)
        this.onRasterReady()
        break
      }

      case 'tileReady': {
        const tileKey = makePageTileKey(
          message.pageIndex,
          message.levelIndex,
          message.tileX,
          message.tileY,
        )
        this.pendingRequests.delete(message.requestId)
        this.pendingTileKeys.delete(tileKey)
        this.lastRasterMilliseconds = message.rasterMilliseconds

        if (this.isDisposed) {
          message.bitmap.close()
          return
        }

        this.tileBitmaps.get(tileKey)?.close()
        this.tileBitmaps.set(tileKey, message.bitmap)
        this.evictOldest(this.tileBitmaps, MAXIMUM_CACHED_TILES)
        this.onRasterReady()
        break
      }

      case 'rasterFailed': {
        const descriptor = this.pendingRequests.get(message.requestId)
        this.pendingRequests.delete(message.requestId)
        if (descriptor?.kind === 'tile') {
          this.pendingTileKeys.delete(descriptor.tileKey)
        } else if (descriptor?.kind === 'thumbnail') {
          this.pendingThumbnailPageIndexes.delete(descriptor.pageIndex)
        }
        console.warn('Page raster failed:', message.reason)
        break
      }
    }
  }

  private evictOldest<KeyType>(bitmaps: Map<KeyType, ImageBitmap>, maximumCount: number): void {
    while (bitmaps.size > maximumCount) {
      const oldestEntry = bitmaps.entries().next()
      if (oldestEntry.done) {
        return
      }
      const [key, bitmap] = oldestEntry.value
      bitmap.close()
      bitmaps.delete(key)
    }
  }

  private closeAllBitmaps(): void {
    for (const bitmap of this.tileBitmaps.values()) {
      bitmap.close()
    }
    for (const bitmap of this.thumbnailBitmaps.values()) {
      bitmap.close()
    }
    this.tileBitmaps.clear()
    this.thumbnailBitmaps.clear()
  }

  private postToWorker(message: PageRasterRequestMessage): void {
    this.worker.postMessage(message)
  }
}

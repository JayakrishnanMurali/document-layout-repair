import type { Rect } from '@/canvas/geometry'
import {
  PAGE_THUMBNAIL_TEXELS_PER_WORLD_UNIT,
  TILE_TEXEL_SIZE,
  getTileBoundsInPage,
  getTileTexelsPerWorldUnit,
} from '@/canvas/textures/pageTileGrid'
import { PAGE_HEIGHT_IN_WORLD_UNITS, PAGE_WIDTH_IN_WORLD_UNITS } from '@/document/pageLayout'
import {
  generateSyntheticPageContent,
  type SyntheticPageContent,
} from '@/document/synthetic/pageContentGenerator'
import {
  FULL_PAGE_BOUNDS,
  paintSyntheticPageRegion,
  type Canvas2DContext,
} from '@/document/synthetic/pageTexturePainter'
import type { PageRasterRequestMessage, PageRasterResponseMessage } from './pageRasterProtocol'
import { getTypedWorkerScope } from './typedWorkerScope'

/**
 * Rasterizes synthetic document pages off the main thread. The page layer never
 * paints ink itself: it only composites the `ImageBitmap`s produced here, so a
 * 100-page document costs the main thread nothing beyond `drawImage` calls.
 */

const workerScope = getTypedWorkerScope<PageRasterRequestMessage, PageRasterResponseMessage>()

const MAXIMUM_CACHED_PAGE_CONTENTS = 24

let documentSeed = 1
const pageContentCache = new Map<number, SyntheticPageContent>()

let pendingRequests: PageRasterRequestMessage[] = []
let isDraining = false

const tileCanvas = new OffscreenCanvas(TILE_TEXEL_SIZE, TILE_TEXEL_SIZE)
const tileContext = tileCanvas.getContext('2d', { alpha: false }) as Canvas2DContext | null

const thumbnailCanvas = new OffscreenCanvas(
  Math.round(PAGE_WIDTH_IN_WORLD_UNITS * PAGE_THUMBNAIL_TEXELS_PER_WORLD_UNIT),
  Math.round(PAGE_HEIGHT_IN_WORLD_UNITS * PAGE_THUMBNAIL_TEXELS_PER_WORLD_UNIT),
)
const thumbnailContext = thumbnailCanvas.getContext('2d', { alpha: false }) as Canvas2DContext | null

function getPageContent(pageIndex: number): SyntheticPageContent {
  const cached = pageContentCache.get(pageIndex)
  if (cached) {
    pageContentCache.delete(pageIndex)
    pageContentCache.set(pageIndex, cached)
    return cached
  }

  const content = generateSyntheticPageContent(pageIndex, documentSeed)
  pageContentCache.set(pageIndex, content)

  if (pageContentCache.size > MAXIMUM_CACHED_PAGE_CONTENTS) {
    const oldestPageIndex = pageContentCache.keys().next().value
    if (oldestPageIndex !== undefined) {
      pageContentCache.delete(oldestPageIndex)
    }
  }

  return content
}

function postResponse(message: PageRasterResponseMessage, transfer: Transferable[] = []): void {
  workerScope.postMessage(message, transfer)
}

async function renderThumbnail(requestId: number, pageIndex: number): Promise<void> {
  if (!thumbnailContext) {
    postResponse({ kind: 'rasterFailed', requestId, reason: 'No 2D context for thumbnails' })
    return
  }

  const startedAt = performance.now()
  paintSyntheticPageRegion(
    thumbnailContext,
    getPageContent(pageIndex),
    FULL_PAGE_BOUNDS,
    PAGE_THUMBNAIL_TEXELS_PER_WORLD_UNIT,
  )
  const bitmap = await createImageBitmap(thumbnailCanvas)

  postResponse(
    {
      kind: 'thumbnailReady',
      requestId,
      pageIndex,
      bitmap,
      rasterMilliseconds: performance.now() - startedAt,
    },
    [bitmap],
  )
}

async function renderTile(
  requestId: number,
  pageIndex: number,
  levelIndex: number,
  tileX: number,
  tileY: number,
): Promise<void> {
  if (!tileContext) {
    postResponse({ kind: 'rasterFailed', requestId, reason: 'No 2D context for tiles' })
    return
  }

  const startedAt = performance.now()
  const texelsPerWorldUnit = getTileTexelsPerWorldUnit(levelIndex)
  const tileBounds: Rect = getTileBoundsInPage(levelIndex, tileX, tileY)
  const texelWidth = Math.round(tileBounds.width * texelsPerWorldUnit)
  const texelHeight = Math.round(tileBounds.height * texelsPerWorldUnit)

  paintSyntheticPageRegion(tileContext, getPageContent(pageIndex), tileBounds, texelsPerWorldUnit)

  // Edge tiles only fill part of the reusable canvas, so crop while snapshotting.
  const bitmap = await createImageBitmap(tileCanvas, 0, 0, texelWidth, texelHeight)

  postResponse(
    {
      kind: 'tileReady',
      requestId,
      pageIndex,
      levelIndex,
      tileX,
      tileY,
      bitmap,
      rasterMilliseconds: performance.now() - startedAt,
    },
    [bitmap],
  )
}

async function drainPendingRequests(): Promise<void> {
  if (isDraining) {
    return
  }
  isDraining = true

  try {
    while (pendingRequests.length > 0) {
      const request = pendingRequests.shift()
      if (!request) {
        break
      }

      // Awaiting `createImageBitmap` yields to the message queue between rasters, so a
      // `dropPendingRequests` sent mid-drain takes effect immediately.
      if (request.kind === 'renderThumbnail') {
        await renderThumbnail(request.requestId, request.pageIndex)
      } else if (request.kind === 'renderTile') {
        await renderTile(
          request.requestId,
          request.pageIndex,
          request.levelIndex,
          request.tileX,
          request.tileY,
        )
      }
    }
  } finally {
    isDraining = false
  }
}

workerScope.onmessage = (event: MessageEvent<PageRasterRequestMessage>) => {
  const message = event.data

  switch (message.kind) {
    case 'configure':
      documentSeed = message.documentSeed
      pageContentCache.clear()
      pendingRequests = []
      break

    case 'dropPendingRequests':
      pendingRequests = []
      break

    case 'renderThumbnail':
    case 'renderTile':
      pendingRequests.push(message)
      void drainPendingRequests()
      break
  }
}

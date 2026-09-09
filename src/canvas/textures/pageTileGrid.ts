import type { Rect } from '@/canvas/geometry'
import { PAGE_HEIGHT_IN_WORLD_UNITS, PAGE_WIDTH_IN_WORLD_UNITS } from '@/document/pageLayout'

/**
 * Page rasters come in two tiers:
 *
 * 1. a whole-page thumbnail, used while zoomed out far enough that a full-resolution
 *    raster would be thrown away by downscaling, and as the instant fallback under
 *    tiles that have not arrived yet;
 * 2. fixed-size tiles at power-of-two levels of detail, so the texels drawn on screen
 *    stay within a factor of two of the device pixels they cover — sharp without ever
 *    allocating a full-resolution bitmap of a 100-page document.
 */

export const PAGE_THUMBNAIL_TEXELS_PER_WORLD_UNIT = 0.125

/** Below this device-pixel density the thumbnail alone is already oversampled. */
export const THUMBNAIL_ONLY_TEXELS_PER_WORLD_UNIT = 0.25

export const TILE_TEXEL_SIZE = 512

export const TILE_TEXELS_PER_WORLD_UNIT_BY_LEVEL = [0.25, 0.5, 1, 2, 4, 8, 16] as const

export const MAXIMUM_TILE_LEVEL_INDEX = TILE_TEXELS_PER_WORLD_UNIT_BY_LEVEL.length - 1

export function selectTileLevelIndex(neededTexelsPerWorldUnit: number): number {
  for (let levelIndex = 0; levelIndex < TILE_TEXELS_PER_WORLD_UNIT_BY_LEVEL.length; levelIndex += 1) {
    if (TILE_TEXELS_PER_WORLD_UNIT_BY_LEVEL[levelIndex] >= neededTexelsPerWorldUnit) {
      return levelIndex
    }
  }
  return MAXIMUM_TILE_LEVEL_INDEX
}

export function getTileTexelsPerWorldUnit(levelIndex: number): number {
  return TILE_TEXELS_PER_WORLD_UNIT_BY_LEVEL[
    Math.min(Math.max(levelIndex, 0), MAXIMUM_TILE_LEVEL_INDEX)
  ]
}

export function getTileSizeInWorldUnits(levelIndex: number): number {
  return TILE_TEXEL_SIZE / getTileTexelsPerWorldUnit(levelIndex)
}

export type PageTileGridSize = { columnCount: number; rowCount: number }

export function getPageTileGridSize(levelIndex: number): PageTileGridSize {
  const tileSizeInWorldUnits = getTileSizeInWorldUnits(levelIndex)
  return {
    columnCount: Math.ceil(PAGE_WIDTH_IN_WORLD_UNITS / tileSizeInWorldUnits),
    rowCount: Math.ceil(PAGE_HEIGHT_IN_WORLD_UNITS / tileSizeInWorldUnits),
  }
}

/** Tile bounds in page-local world units, clipped to the page. */
export function getTileBoundsInPage(levelIndex: number, tileX: number, tileY: number): Rect {
  const tileSizeInWorldUnits = getTileSizeInWorldUnits(levelIndex)
  const x = tileX * tileSizeInWorldUnits
  const y = tileY * tileSizeInWorldUnits
  return {
    x,
    y,
    width: Math.min(tileSizeInWorldUnits, PAGE_WIDTH_IN_WORLD_UNITS - x),
    height: Math.min(tileSizeInWorldUnits, PAGE_HEIGHT_IN_WORLD_UNITS - y),
  }
}

export type PageTileRange = {
  firstTileX: number
  lastTileX: number
  firstTileY: number
  lastTileY: number
}

/** Tiles of one page that intersect `visibleRectInPage` (page-local world units). */
export function getVisibleTileRange(
  levelIndex: number,
  visibleRectInPage: Rect,
): PageTileRange | null {
  const tileSizeInWorldUnits = getTileSizeInWorldUnits(levelIndex)
  const { columnCount, rowCount } = getPageTileGridSize(levelIndex)

  const firstTileX = Math.max(0, Math.floor(visibleRectInPage.x / tileSizeInWorldUnits))
  const lastTileX = Math.min(
    columnCount - 1,
    Math.floor((visibleRectInPage.x + visibleRectInPage.width) / tileSizeInWorldUnits),
  )
  const firstTileY = Math.max(0, Math.floor(visibleRectInPage.y / tileSizeInWorldUnits))
  const lastTileY = Math.min(
    rowCount - 1,
    Math.floor((visibleRectInPage.y + visibleRectInPage.height) / tileSizeInWorldUnits),
  )

  if (firstTileX > lastTileX || firstTileY > lastTileY) {
    return null
  }

  return { firstTileX, lastTileX, firstTileY, lastTileY }
}

export type PageTileKey = string

export function makePageTileKey(
  pageIndex: number,
  levelIndex: number,
  tileX: number,
  tileY: number,
): PageTileKey {
  return `${pageIndex}:${levelIndex}:${tileX}:${tileY}`
}

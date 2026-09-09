import { describe, expect, it } from 'vitest'
import { PAGE_HEIGHT_IN_WORLD_UNITS, PAGE_WIDTH_IN_WORLD_UNITS } from '@/document/pageLayout'
import {
  MAXIMUM_TILE_LEVEL_INDEX,
  TILE_TEXELS_PER_WORLD_UNIT_BY_LEVEL,
  getPageTileGridSize,
  getTileBoundsInPage,
  getTileSizeInWorldUnits,
  getVisibleTileRange,
  selectTileLevelIndex,
} from './pageTileGrid'

describe('selectTileLevelIndex', () => {
  it('never picks a level that would upscale the texture', () => {
    for (const needed of [0.26, 0.4, 0.9, 1.1, 3.9, 7.2]) {
      const levelIndex = selectTileLevelIndex(needed)
      expect(TILE_TEXELS_PER_WORLD_UNIT_BY_LEVEL[levelIndex]).toBeGreaterThanOrEqual(needed)
    }
  })

  it('picks the tightest level that satisfies the requirement', () => {
    expect(selectTileLevelIndex(0.1)).toBe(0)
    expect(selectTileLevelIndex(0.25)).toBe(0)
    expect(selectTileLevelIndex(0.26)).toBe(1)
    expect(selectTileLevelIndex(2)).toBe(3)
  })

  it('clamps at the highest level instead of allocating unbounded textures', () => {
    expect(selectTileLevelIndex(1000)).toBe(MAXIMUM_TILE_LEVEL_INDEX)
  })
})

describe('tile grid', () => {
  it('covers the page exactly at every level', () => {
    for (let levelIndex = 0; levelIndex <= MAXIMUM_TILE_LEVEL_INDEX; levelIndex += 1) {
      const { columnCount, rowCount } = getPageTileGridSize(levelIndex)
      const lastTile = getTileBoundsInPage(levelIndex, columnCount - 1, rowCount - 1)

      expect(lastTile.x + lastTile.width).toBeCloseTo(PAGE_WIDTH_IN_WORLD_UNITS, 6)
      expect(lastTile.y + lastTile.height).toBeCloseTo(PAGE_HEIGHT_IN_WORLD_UNITS, 6)
      expect(lastTile.width).toBeGreaterThan(0)
      expect(lastTile.height).toBeGreaterThan(0)
    }
  })

  it('halves the world coverage of a tile for each level up', () => {
    for (let levelIndex = 1; levelIndex <= MAXIMUM_TILE_LEVEL_INDEX; levelIndex += 1) {
      expect(getTileSizeInWorldUnits(levelIndex)).toBeCloseTo(
        getTileSizeInWorldUnits(levelIndex - 1) / 2,
        6,
      )
    }
  })
})

describe('getVisibleTileRange', () => {
  it('returns only the tiles overlapping the visible page rect', () => {
    const levelIndex = 3
    const tileSize = getTileSizeInWorldUnits(levelIndex)
    const range = getVisibleTileRange(levelIndex, {
      x: tileSize * 1.2,
      y: tileSize * 0.4,
      width: tileSize * 0.9,
      height: tileSize * 1.1,
    })

    expect(range).toEqual({ firstTileX: 1, lastTileX: 2, firstTileY: 0, lastTileY: 1 })
  })

  it('clamps to the page and reports nothing when fully outside', () => {
    const levelIndex = 2
    expect(getVisibleTileRange(levelIndex, { x: -5000, y: -5000, width: 100, height: 100 })).toBeNull()

    const clamped = getVisibleTileRange(levelIndex, {
      x: -1000,
      y: -1000,
      width: 100_000,
      height: 100_000,
    })
    const grid = getPageTileGridSize(levelIndex)
    expect(clamped).toEqual({
      firstTileX: 0,
      lastTileX: grid.columnCount - 1,
      firstTileY: 0,
      lastTileY: grid.rowCount - 1,
    })
  })
})

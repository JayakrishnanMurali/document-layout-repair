export type PageRasterRequestMessage =
  | { kind: 'configure'; documentSeed: number }
  | { kind: 'renderThumbnail'; requestId: number; pageIndex: number }
  | {
      kind: 'renderTile'
      requestId: number
      pageIndex: number
      levelIndex: number
      tileX: number
      tileY: number
    }
  | { kind: 'dropPendingRequests' }

export type PageRasterResponseMessage =
  | {
      kind: 'thumbnailReady'
      requestId: number
      pageIndex: number
      bitmap: ImageBitmap
      rasterMilliseconds: number
    }
  | {
      kind: 'tileReady'
      requestId: number
      pageIndex: number
      levelIndex: number
      tileX: number
      tileY: number
      bitmap: ImageBitmap
      rasterMilliseconds: number
    }
  | { kind: 'rasterFailed'; requestId: number; reason: string }

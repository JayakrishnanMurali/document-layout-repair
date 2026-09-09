import type { Rect } from '@/canvas/geometry'
import {
  NODE_FLAG_LOW_CONFIDENCE,
  NODE_FLAG_REMOVED,
  getLayoutNodeClassName,
  type LayoutDocument,
} from '@/document/layoutTypes'
import {
  collectVisiblePageIndexes,
  getDocumentBounds,
  type DocumentPageLayout,
} from '@/document/pageLayout'
import {
  LOW_CONFIDENCE_BORDER_COLOR,
  LOW_CONFIDENCE_FILL_COLOR,
  NODE_CLASS_STYLES,
} from './nodeClassStyles'

/**
 * Per-instance layout, 28 bytes:
 *
 * | offset | type       | meaning                        |
 * | ------ | ---------- | ------------------------------ |
 * | 0      | float32[4] | world x, y, width, height      |
 * | 16     | uint8[4]   | fill colour, normalized         |
 * | 20     | uint8[4]   | border colour, normalized       |
 * | 24     | float32    | border width in device pixels   |
 */
export const INSTANCE_BYTE_STRIDE = 28
const FLOATS_PER_INSTANCE = INSTANCE_BYTE_STRIDE / 4

export const INSTANCE_RECT_BYTE_OFFSET = 0
export const INSTANCE_FILL_COLOR_BYTE_OFFSET = 16
export const INSTANCE_BORDER_COLOR_BYTE_OFFSET = 20
export const INSTANCE_BORDER_WIDTH_BYTE_OFFSET = 24

/**
 * Boxes thinner than this on screen collapse to a solid tint: at that size a border and
 * a fill are the same pixel, and drawing both just makes a grey smear.
 */
const SOLID_TINT_DEVICE_PIXEL_THRESHOLD = 3.5

/** Fraction of the viewport the culled set is padded by, so small pans reuse it. */
const CULL_ENVELOPE_PADDING_FRACTION = 0.35

export type OverlayCullStatistics = {
  instanceCount: number
  scannedNodeCount: number
  visiblePageCount: number
  rebuildMilliseconds: number
  rebuildCount: number
}

/**
 * Culls the document down to the boxes the camera can see and packs them into a single
 * interleaved buffer for one instanced draw call.
 *
 * Culling exploits the document's own partition: pages are stacked, each page owns a
 * contiguous range of node ids, so only the ranges the viewport overlaps are ever
 * scanned. The result is kept for a padded envelope around the viewport, so ordinary
 * panning re-uses the packed buffer and only the transform uniform changes.
 */
export class OverlayInstanceBuffer {
  private data = new ArrayBuffer(0)
  private floatView = new Float32Array(0)
  private byteView = new Uint8Array(0)
  private capacity = 0

  private packedInstanceCount = 0
  private scannedNodeCount = 0
  private visiblePageCount = 0
  private rebuildMilliseconds = 0
  private rebuildCount = 0

  private readonly visiblePageIndexes: number[] = []
  private envelope: Rect = { x: 0, y: 0, width: 0, height: 0 }
  private envelopeDevicePixelsPerWorldUnit = 0
  private wasCullingEnabled = true
  private hasContent = false

  get byteLength(): number {
    return this.packedInstanceCount * INSTANCE_BYTE_STRIDE
  }

  get bytes(): Uint8Array {
    return this.byteView.subarray(0, this.byteLength)
  }

  get instanceCount(): number {
    return this.packedInstanceCount
  }

  /** Full views over the packed buffer, for renderers that read fields individually. */
  get floatData(): Float32Array {
    return this.floatView
  }

  get byteData(): Uint8Array {
    return this.byteView
  }

  get statistics(): OverlayCullStatistics {
    return {
      instanceCount: this.packedInstanceCount,
      scannedNodeCount: this.scannedNodeCount,
      visiblePageCount: this.visiblePageCount,
      rebuildMilliseconds: this.rebuildMilliseconds,
      rebuildCount: this.rebuildCount,
    }
  }

  invalidate(): void {
    this.hasContent = false
    this.packedInstanceCount = 0
  }

  /**
   * Returns true when the packed buffer changed and must be re-uploaded.
   *
   * Level of detail depends on zoom, so a scale change invalidates the envelope even if
   * the viewport still sits inside it.
   */
  update(
    document: LayoutDocument | null,
    pageLayout: DocumentPageLayout,
    visibleWorldRect: Rect,
    devicePixelsPerWorldUnit: number,
    isCullingEnabled = true,
  ): boolean {
    if (!document || document.geometry.nodeCount === 0) {
      const wasPopulated = this.packedInstanceCount > 0
      this.packedInstanceCount = 0
      this.hasContent = false
      return wasPopulated
    }

    const isEnvelopeStillValid =
      this.hasContent &&
      this.wasCullingEnabled === isCullingEnabled &&
      this.envelopeDevicePixelsPerWorldUnit === devicePixelsPerWorldUnit &&
      (!isCullingEnabled || containsRect(this.envelope, visibleWorldRect))
    if (isEnvelopeStillValid) {
      return false
    }

    const startedAt = performance.now()
    this.envelope = isCullingEnabled
      ? inflateToEnvelope(visibleWorldRect)
      : getDocumentBounds(pageLayout)
    this.envelopeDevicePixelsPerWorldUnit = devicePixelsPerWorldUnit
    this.wasCullingEnabled = isCullingEnabled
    this.pack(document, pageLayout, this.envelope, devicePixelsPerWorldUnit)
    this.rebuildMilliseconds = performance.now() - startedAt
    this.rebuildCount += 1
    this.hasContent = true

    return true
  }

  private pack(
    document: LayoutDocument,
    pageLayout: DocumentPageLayout,
    cullRect: Rect,
    devicePixelsPerWorldUnit: number,
  ): void {
    const { geometry } = document
    const visiblePageIndexes = collectVisiblePageIndexes(
      pageLayout,
      cullRect,
      this.visiblePageIndexes,
    )

    this.packedInstanceCount = 0
    this.scannedNodeCount = 0
    this.visiblePageCount = visiblePageIndexes.length

    if (visiblePageIndexes.length === 0) {
      return
    }

    const cullRight = cullRect.x + cullRect.width
    const cullBottom = cullRect.y + cullRect.height

    let upperBoundInstanceCount = 0
    for (const pageIndex of visiblePageIndexes) {
      upperBoundInstanceCount += document.pageNodeRanges[pageIndex]?.nodeCount ?? 0
    }
    this.ensureCapacity(upperBoundInstanceCount)

    for (const pageIndex of visiblePageIndexes) {
      const range = document.pageNodeRanges[pageIndex]
      if (!range || range.nodeCount === 0) {
        continue
      }

      const lastNodeId = range.firstNodeId + range.nodeCount
      this.scannedNodeCount += range.nodeCount

      for (let nodeId = range.firstNodeId; nodeId < lastNodeId; nodeId += 1) {
        if ((geometry.flags[nodeId] & NODE_FLAG_REMOVED) !== 0) {
          continue
        }

        const offset = nodeId * 4
        const x = geometry.bounds[offset]
        const y = geometry.bounds[offset + 1]
        const width = geometry.bounds[offset + 2]
        const height = geometry.bounds[offset + 3]

        if (x >= cullRight || y >= cullBottom || x + width <= cullRect.x || y + height <= cullRect.y) {
          continue
        }

        this.writeInstance(geometry, nodeId, x, y, width, height, devicePixelsPerWorldUnit)
      }
    }
  }

  private writeInstance(
    geometry: LayoutDocument['geometry'],
    nodeId: number,
    x: number,
    y: number,
    width: number,
    height: number,
    devicePixelsPerWorldUnit: number,
  ): void {
    const style = NODE_CLASS_STYLES[getLayoutNodeClassName(geometry.classIds[nodeId])]
    const isLowConfidence = (geometry.flags[nodeId] & NODE_FLAG_LOW_CONFIDENCE) !== 0
    const borderColor = isLowConfidence ? LOW_CONFIDENCE_BORDER_COLOR : style.borderColor
    const baseFillColor = isLowConfidence ? LOW_CONFIDENCE_FILL_COLOR : style.fillColor

    // Below a few device pixels a border and a fill land on the same pixel, so the box
    // collapses to a solid tint of its class colour instead of a grey smear.
    const isSolidTint =
      Math.min(height * devicePixelsPerWorldUnit, width * devicePixelsPerWorldUnit) <
      SOLID_TINT_DEVICE_PIXEL_THRESHOLD

    const fillRed = isSolidTint ? borderColor[0] : baseFillColor[0]
    const fillGreen = isSolidTint ? borderColor[1] : baseFillColor[1]
    const fillBlue = isSolidTint ? borderColor[2] : baseFillColor[2]
    const fillAlpha = isSolidTint ? Math.round(borderColor[3] * 0.7) : baseFillColor[3]
    const borderWidth = isSolidTint ? 0 : style.borderWidthInDevicePixels

    const instanceIndex = this.packedInstanceCount
    const floatBase = instanceIndex * FLOATS_PER_INSTANCE
    const byteBase = instanceIndex * INSTANCE_BYTE_STRIDE

    this.floatView[floatBase] = x
    this.floatView[floatBase + 1] = y
    this.floatView[floatBase + 2] = width
    this.floatView[floatBase + 3] = height

    this.byteView[byteBase + INSTANCE_FILL_COLOR_BYTE_OFFSET] = fillRed
    this.byteView[byteBase + INSTANCE_FILL_COLOR_BYTE_OFFSET + 1] = fillGreen
    this.byteView[byteBase + INSTANCE_FILL_COLOR_BYTE_OFFSET + 2] = fillBlue
    this.byteView[byteBase + INSTANCE_FILL_COLOR_BYTE_OFFSET + 3] = fillAlpha

    this.byteView[byteBase + INSTANCE_BORDER_COLOR_BYTE_OFFSET] = borderColor[0]
    this.byteView[byteBase + INSTANCE_BORDER_COLOR_BYTE_OFFSET + 1] = borderColor[1]
    this.byteView[byteBase + INSTANCE_BORDER_COLOR_BYTE_OFFSET + 2] = borderColor[2]
    this.byteView[byteBase + INSTANCE_BORDER_COLOR_BYTE_OFFSET + 3] = borderColor[3]

    this.floatView[floatBase + 6] = borderWidth

    this.packedInstanceCount = instanceIndex + 1
  }

  private ensureCapacity(instanceCount: number): void {
    if (instanceCount <= this.capacity) {
      return
    }

    let nextCapacity = Math.max(this.capacity, 1024)
    while (nextCapacity < instanceCount) {
      nextCapacity *= 2
    }

    this.data = new ArrayBuffer(nextCapacity * INSTANCE_BYTE_STRIDE)
    this.floatView = new Float32Array(this.data)
    this.byteView = new Uint8Array(this.data)
    this.capacity = nextCapacity
  }
}

function inflateToEnvelope(visibleWorldRect: Rect): Rect {
  const paddingX = visibleWorldRect.width * CULL_ENVELOPE_PADDING_FRACTION
  const paddingY = visibleWorldRect.height * CULL_ENVELOPE_PADDING_FRACTION
  return {
    x: visibleWorldRect.x - paddingX,
    y: visibleWorldRect.y - paddingY,
    width: visibleWorldRect.width + paddingX * 2,
    height: visibleWorldRect.height + paddingY * 2,
  }
}

function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}

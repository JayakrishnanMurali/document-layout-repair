import type { CanvasBackingSize } from '@/canvas/renderTypes'
import { applyWorldTransformToContext, type Camera } from '@/canvas/viewport/camera'
import {
  INSTANCE_BORDER_COLOR_BYTE_OFFSET,
  INSTANCE_BYTE_STRIDE,
  INSTANCE_FILL_COLOR_BYTE_OFFSET,
  type OverlayInstanceBuffer,
} from './OverlayInstanceBuffer'

const FLOATS_PER_INSTANCE = INSTANCE_BYTE_STRIDE / 4

/**
 * Fallback overlay renderer for contexts without WebGL2.
 *
 * It reads exactly the same packed instance buffer as the GPU path, so culling and
 * level-of-detail behave identically; only the submission cost differs, since a 2D
 * context needs one call per box instead of one call per frame.
 */
export class Canvas2DOverlayRenderer {
  private readonly context: CanvasRenderingContext2D

  constructor(context: CanvasRenderingContext2D) {
    this.context = context
  }

  clear(backingSize: CanvasBackingSize): void {
    this.context.setTransform(1, 0, 0, 1, 0, 0)
    this.context.clearRect(0, 0, backingSize.deviceWidth, backingSize.deviceHeight)
  }

  draw(
    instances: OverlayInstanceBuffer,
    camera: Camera,
    devicePixelRatio: number,
    devicePixelsPerWorldUnit: number,
  ): void {
    const { context } = this
    const floatView = instances.floatData
    const byteView = instances.byteData

    applyWorldTransformToContext(context, camera, devicePixelRatio)

    for (let instanceIndex = 0; instanceIndex < instances.instanceCount; instanceIndex += 1) {
      const floatBase = instanceIndex * FLOATS_PER_INSTANCE
      const byteBase = instanceIndex * INSTANCE_BYTE_STRIDE

      const x = floatView[floatBase]
      const y = floatView[floatBase + 1]
      const width = Math.max(floatView[floatBase + 2], 1 / devicePixelsPerWorldUnit)
      const height = Math.max(floatView[floatBase + 3], 1 / devicePixelsPerWorldUnit)
      const borderWidthInDevicePixels = floatView[floatBase + 6]

      const fillAlpha = byteView[byteBase + INSTANCE_FILL_COLOR_BYTE_OFFSET + 3]
      if (fillAlpha > 0) {
        context.fillStyle = readColor(byteView, byteBase + INSTANCE_FILL_COLOR_BYTE_OFFSET)
        context.fillRect(x, y, width, height)
      }

      if (borderWidthInDevicePixels > 0) {
        const borderWidthInWorldUnits = borderWidthInDevicePixels / devicePixelsPerWorldUnit
        context.lineWidth = borderWidthInWorldUnits
        context.strokeStyle = readColor(byteView, byteBase + INSTANCE_BORDER_COLOR_BYTE_OFFSET)
        context.strokeRect(
          x + borderWidthInWorldUnits / 2,
          y + borderWidthInWorldUnits / 2,
          width - borderWidthInWorldUnits,
          height - borderWidthInWorldUnits,
        )
      }
    }

    context.setTransform(1, 0, 0, 1, 0, 0)
  }
}

function readColor(byteView: Uint8Array, offset: number): string {
  const alpha = byteView[offset + 3] / 255
  return `rgba(${byteView[offset]}, ${byteView[offset + 1]}, ${byteView[offset + 2]}, ${alpha.toFixed(3)})`
}

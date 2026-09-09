import type { Size } from '@/canvas/geometry'
import { writeWorldToClipMatrix, type Camera } from '@/canvas/viewport/camera'
import {
  INSTANCE_BORDER_COLOR_BYTE_OFFSET,
  INSTANCE_BORDER_WIDTH_BYTE_OFFSET,
  INSTANCE_BYTE_STRIDE,
  INSTANCE_FILL_COLOR_BYTE_OFFSET,
  INSTANCE_RECT_BYTE_OFFSET,
} from './OverlayInstanceBuffer'

const VERTEX_SHADER_SOURCE = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aWorldRect;
layout(location = 2) in vec4 aFillColor;
layout(location = 3) in vec4 aBorderColor;
layout(location = 4) in float aBorderWidthInDevicePixels;

uniform mat3 uWorldToClip;
uniform float uDevicePixelsPerWorldUnit;

out vec4 vFillColor;
out vec4 vBorderColor;
out vec2 vPositionInDevicePixels;
out vec2 vSizeInDevicePixels;
out float vBorderWidthInDevicePixels;

void main() {
  // A box must never vanish between device pixels, so its drawn size is clamped to one.
  vec2 sizeInDevicePixels = max(aWorldRect.zw * uDevicePixelsPerWorldUnit, vec2(1.0));
  vec2 sizeInWorldUnits = sizeInDevicePixels / uDevicePixelsPerWorldUnit;
  vec2 worldPosition = aWorldRect.xy + aCorner * sizeInWorldUnits;

  vFillColor = aFillColor;
  vBorderColor = aBorderColor;
  vSizeInDevicePixels = sizeInDevicePixels;
  vPositionInDevicePixels = aCorner * sizeInDevicePixels;
  vBorderWidthInDevicePixels = aBorderWidthInDevicePixels;

  vec3 clipPosition = uWorldToClip * vec3(worldPosition, 1.0);
  gl_Position = vec4(clipPosition.xy, 0.0, 1.0);
}
`

const FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;

in vec4 vFillColor;
in vec4 vBorderColor;
in vec2 vPositionInDevicePixels;
in vec2 vSizeInDevicePixels;
in float vBorderWidthInDevicePixels;

out vec4 outColor;

void main() {
  // Distance to the nearest edge, measured in device pixels, keeps the border a constant
  // on-screen weight at every zoom level.
  float distanceToEdge = min(
    min(vPositionInDevicePixels.x, vSizeInDevicePixels.x - vPositionInDevicePixels.x),
    min(vPositionInDevicePixels.y, vSizeInDevicePixels.y - vPositionInDevicePixels.y)
  );

  float borderMix = 1.0 - smoothstep(
    vBorderWidthInDevicePixels - 0.5,
    vBorderWidthInDevicePixels + 0.5,
    distanceToEdge
  );

  vec4 color = mix(vFillColor, vBorderColor, borderMix);
  if (color.a <= 0.0) {
    discard;
  }

  // Premultiplied output, matching the canvas compositing mode and blend function.
  outColor = vec4(color.rgb * color.a, color.a);
}
`

const UNIT_QUAD_CORNERS = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1])

const CORNER_ATTRIBUTE_LOCATION = 0
const WORLD_RECT_ATTRIBUTE_LOCATION = 1
const FILL_COLOR_ATTRIBUTE_LOCATION = 2
const BORDER_COLOR_ATTRIBUTE_LOCATION = 3
const BORDER_WIDTH_ATTRIBUTE_LOCATION = 4

/**
 * Draws every visible bounding box in a single instanced draw call.
 *
 * One quad, one buffer of per-instance rectangles and colours: the cost of a frame is
 * independent of how many boxes are on screen, which is what makes the 10k-box viewport
 * hold 60 FPS while zoomed out over the whole document.
 */
export class WebGl2OverlayRenderer {
  private readonly gl: WebGL2RenderingContext
  private readonly program: WebGLProgram
  private readonly vertexArray: WebGLVertexArrayObject
  private readonly cornerBuffer: WebGLBuffer
  private readonly instanceBuffer: WebGLBuffer
  private readonly worldToClipLocation: WebGLUniformLocation
  private readonly devicePixelsPerWorldUnitLocation: WebGLUniformLocation
  private readonly worldToClipMatrix = new Float32Array(9)

  private allocatedInstanceByteLength = 0

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    this.program = createProgram(gl, VERTEX_SHADER_SOURCE, FRAGMENT_SHADER_SOURCE)

    const worldToClipLocation = gl.getUniformLocation(this.program, 'uWorldToClip')
    const devicePixelsPerWorldUnitLocation = gl.getUniformLocation(
      this.program,
      'uDevicePixelsPerWorldUnit',
    )
    if (!worldToClipLocation || !devicePixelsPerWorldUnitLocation) {
      throw new Error('Overlay shader is missing expected uniforms')
    }
    this.worldToClipLocation = worldToClipLocation
    this.devicePixelsPerWorldUnitLocation = devicePixelsPerWorldUnitLocation

    const vertexArray = gl.createVertexArray()
    const cornerBuffer = gl.createBuffer()
    const instanceBuffer = gl.createBuffer()
    if (!vertexArray || !cornerBuffer || !instanceBuffer) {
      throw new Error('Could not allocate overlay GL resources')
    }
    this.vertexArray = vertexArray
    this.cornerBuffer = cornerBuffer
    this.instanceBuffer = instanceBuffer

    this.configureVertexArray()

    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  }

  static create(canvas: HTMLCanvasElement): WebGl2OverlayRenderer | null {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
    })
    return gl ? new WebGl2OverlayRenderer(gl) : null
  }

  setViewport(deviceWidth: number, deviceHeight: number): void {
    this.gl.viewport(0, 0, deviceWidth, deviceHeight)
  }

  clear(): void {
    this.gl.clearColor(0, 0, 0, 0)
    this.gl.clear(this.gl.COLOR_BUFFER_BIT)
  }

  uploadInstances(instanceBytes: Uint8Array): void {
    const { gl } = this
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer)

    if (instanceBytes.byteLength > this.allocatedInstanceByteLength) {
      // Grow in powers of two so a deep zoom-out does not reallocate every frame.
      let nextByteLength = Math.max(this.allocatedInstanceByteLength, 64 * INSTANCE_BYTE_STRIDE)
      while (nextByteLength < instanceBytes.byteLength) {
        nextByteLength *= 2
      }
      gl.bufferData(gl.ARRAY_BUFFER, nextByteLength, gl.DYNAMIC_DRAW)
      this.allocatedInstanceByteLength = nextByteLength
    }

    gl.bufferSubData(gl.ARRAY_BUFFER, 0, instanceBytes)
  }

  draw(camera: Camera, viewportSize: Size, devicePixelsPerWorldUnit: number, instanceCount: number): void {
    if (instanceCount === 0) {
      return
    }

    const { gl } = this
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vertexArray)

    writeWorldToClipMatrix(this.worldToClipMatrix, camera, viewportSize)
    gl.uniformMatrix3fv(this.worldToClipLocation, false, this.worldToClipMatrix)
    gl.uniform1f(this.devicePixelsPerWorldUnitLocation, devicePixelsPerWorldUnit)

    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instanceCount)
    gl.bindVertexArray(null)
  }

  dispose(): void {
    const { gl } = this
    gl.deleteVertexArray(this.vertexArray)
    gl.deleteBuffer(this.cornerBuffer)
    gl.deleteBuffer(this.instanceBuffer)
    gl.deleteProgram(this.program)
  }

  private configureVertexArray(): void {
    const { gl } = this
    gl.bindVertexArray(this.vertexArray)

    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, UNIT_QUAD_CORNERS, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(CORNER_ATTRIBUTE_LOCATION)
    gl.vertexAttribPointer(CORNER_ATTRIBUTE_LOCATION, 2, gl.FLOAT, false, 0, 0)

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer)

    gl.enableVertexAttribArray(WORLD_RECT_ATTRIBUTE_LOCATION)
    gl.vertexAttribPointer(
      WORLD_RECT_ATTRIBUTE_LOCATION,
      4,
      gl.FLOAT,
      false,
      INSTANCE_BYTE_STRIDE,
      INSTANCE_RECT_BYTE_OFFSET,
    )
    gl.vertexAttribDivisor(WORLD_RECT_ATTRIBUTE_LOCATION, 1)

    gl.enableVertexAttribArray(FILL_COLOR_ATTRIBUTE_LOCATION)
    gl.vertexAttribPointer(
      FILL_COLOR_ATTRIBUTE_LOCATION,
      4,
      gl.UNSIGNED_BYTE,
      true,
      INSTANCE_BYTE_STRIDE,
      INSTANCE_FILL_COLOR_BYTE_OFFSET,
    )
    gl.vertexAttribDivisor(FILL_COLOR_ATTRIBUTE_LOCATION, 1)

    gl.enableVertexAttribArray(BORDER_COLOR_ATTRIBUTE_LOCATION)
    gl.vertexAttribPointer(
      BORDER_COLOR_ATTRIBUTE_LOCATION,
      4,
      gl.UNSIGNED_BYTE,
      true,
      INSTANCE_BYTE_STRIDE,
      INSTANCE_BORDER_COLOR_BYTE_OFFSET,
    )
    gl.vertexAttribDivisor(BORDER_COLOR_ATTRIBUTE_LOCATION, 1)

    gl.enableVertexAttribArray(BORDER_WIDTH_ATTRIBUTE_LOCATION)
    gl.vertexAttribPointer(
      BORDER_WIDTH_ATTRIBUTE_LOCATION,
      1,
      gl.FLOAT,
      false,
      INSTANCE_BYTE_STRIDE,
      INSTANCE_BORDER_WIDTH_BYTE_OFFSET,
    )
    gl.vertexAttribDivisor(BORDER_WIDTH_ATTRIBUTE_LOCATION, 1)

    gl.bindVertexArray(null)
  }
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) {
    throw new Error('Could not create shader')
  }

  gl.shaderSource(shader, source)
  gl.compileShader(shader)

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`Overlay shader failed to compile: ${log ?? 'unknown error'}`)
  }

  return shader
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const program = gl.createProgram()
  if (!program) {
    throw new Error('Could not create overlay program')
  }

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource)
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource)

  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)

  // The shaders are linked into the program; the objects themselves are no longer needed.
  gl.deleteShader(vertexShader)
  gl.deleteShader(fragmentShader)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    throw new Error(`Overlay program failed to link: ${log ?? 'unknown error'}`)
  }

  return program
}

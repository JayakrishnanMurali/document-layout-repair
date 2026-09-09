import { rectsIntersect, type Rect } from '@/canvas/geometry'
import type { CanvasBackingSize, RenderFrame, RenderLayer } from '@/canvas/renderTypes'
import {
  NODE_FLAG_REMOVED,
  getTableCellBounds,
  type LayoutDocument,
  type TableMesh,
} from '@/document/layoutTypes'
import { collectVisiblePageIndexes } from '@/document/pageLayout'
import { getInteriorDividerIndexes } from '@/document/tableMesh'

const TABLE_OUTLINE_COLOR = 'rgba(245, 158, 11, 0.95)'
const DIVIDER_COLOR = 'rgba(245, 158, 11, 0.75)'
const DIVIDER_GRAB_COLOR = 'rgba(253, 224, 71, 0.95)'
const MERGED_CELL_FILL_COLOR = 'rgba(245, 158, 11, 0.18)'
const MERGED_CELL_BORDER_COLOR = 'rgba(253, 224, 71, 0.95)'

const OUTLINE_WIDTH_IN_SCREEN_PIXELS = 2
const DIVIDER_WIDTH_IN_SCREEN_PIXELS = 1.5
const DIVIDER_GRAB_WIDTH_IN_SCREEN_PIXELS = 3.5
/** Below this zoom the mesh would be a solid smear, so only the table outline is drawn. */
const MINIMUM_MESH_SCALE = 0.2

/**
 * Draws the editable table mesh: the table outline, every divider, and a highlight on
 * merged cells so a reviewer can see which cells are no longer on the grid.
 *
 * The divider currently under the pointer is drawn thicker, which is the affordance that
 * says it can be dragged.
 */
export class TableMeshLayer implements RenderLayer {
  readonly name = 'tableMesh'

  private readonly context: CanvasRenderingContext2D
  private readonly getDocument: () => LayoutDocument | null
  private readonly getIsActive: () => boolean
  private readonly getHighlightedDivider: () => {
    tableNodeId: number
    axis: 'column' | 'row'
    dividerIndex: number
  } | null
  private readonly visiblePageIndexes: number[] = []

  private backingSize: CanvasBackingSize | null = null
  private drawnMeshCount = 0

  constructor(
    canvas: HTMLCanvasElement,
    getDocument: () => LayoutDocument | null,
    getIsActive: () => boolean,
    getHighlightedDivider: TableMeshLayer['getHighlightedDivider'],
  ) {
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('Could not acquire a 2D context for the table mesh layer')
    }
    this.context = context
    this.getDocument = getDocument
    this.getIsActive = getIsActive
    this.getHighlightedDivider = getHighlightedDivider
  }

  get statistics(): { drawnMeshCount: number } {
    return { drawnMeshCount: this.drawnMeshCount }
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
    context.clearRect(0, 0, this.backingSize.deviceWidth, this.backingSize.deviceHeight)
    this.drawnMeshCount = 0

    const layoutDocument = this.getDocument()
    if (!layoutDocument || !this.getIsActive()) {
      return
    }

    const devicePixelsPerWorldUnit = frame.camera.scale * frame.devicePixelRatio
    const toDeviceX = (worldX: number) =>
      (worldX - frame.camera.worldX) * devicePixelsPerWorldUnit
    const toDeviceY = (worldY: number) =>
      (worldY - frame.camera.worldY) * devicePixelsPerWorldUnit

    const highlightedDivider = this.getHighlightedDivider()
    const visiblePageIndexes = collectVisiblePageIndexes(
      frame.pageLayout,
      frame.visibleWorldRect,
      this.visiblePageIndexes,
    )

    for (const pageIndex of visiblePageIndexes) {
      for (const mesh of layoutDocument.tableMeshesByPage[pageIndex] ?? []) {
        const meshBounds = getMeshBounds(mesh)
        if (!rectsIntersect(meshBounds, frame.visibleWorldRect)) {
          continue
        }

        this.drawTableOutline(meshBounds, frame, toDeviceX, toDeviceY)
        if (frame.camera.scale >= MINIMUM_MESH_SCALE) {
          this.drawDividers(mesh, meshBounds, frame, toDeviceX, toDeviceY, highlightedDivider)
          this.drawMergedCells(layoutDocument, mesh, frame, toDeviceX, toDeviceY)
        }
        this.drawnMeshCount += 1
      }
    }
  }

  dispose(): void {
    // The canvas element is owned and removed by the render engine.
  }

  private drawTableOutline(
    meshBounds: Rect,
    frame: RenderFrame,
    toDeviceX: (worldX: number) => number,
    toDeviceY: (worldY: number) => number,
  ): void {
    const { context } = this
    context.lineWidth = OUTLINE_WIDTH_IN_SCREEN_PIXELS * frame.devicePixelRatio
    context.strokeStyle = TABLE_OUTLINE_COLOR
    context.strokeRect(
      toDeviceX(meshBounds.x),
      toDeviceY(meshBounds.y),
      meshBounds.width * frame.camera.scale * frame.devicePixelRatio,
      meshBounds.height * frame.camera.scale * frame.devicePixelRatio,
    )
  }

  private drawDividers(
    mesh: TableMesh,
    meshBounds: Rect,
    frame: RenderFrame,
    toDeviceX: (worldX: number) => number,
    toDeviceY: (worldY: number) => number,
    highlightedDivider: ReturnType<TableMeshLayer['getHighlightedDivider']>,
  ): void {
    const { context } = this
    const top = toDeviceY(meshBounds.y)
    const bottom = toDeviceY(meshBounds.y + meshBounds.height)
    const left = toDeviceX(meshBounds.x)
    const right = toDeviceX(meshBounds.x + meshBounds.width)

    const isHighlighted = (axis: 'column' | 'row', dividerIndex: number) =>
      highlightedDivider !== null &&
      highlightedDivider.tableNodeId === mesh.tableNodeId &&
      highlightedDivider.axis === axis &&
      highlightedDivider.dividerIndex === dividerIndex

    for (const dividerIndex of getInteriorDividerIndexes(mesh, 'column')) {
      const highlighted = isHighlighted('column', dividerIndex)
      context.lineWidth =
        (highlighted ? DIVIDER_GRAB_WIDTH_IN_SCREEN_PIXELS : DIVIDER_WIDTH_IN_SCREEN_PIXELS) *
        frame.devicePixelRatio
      context.strokeStyle = highlighted ? DIVIDER_GRAB_COLOR : DIVIDER_COLOR

      // The +0.5 keeps a hairline on a pixel centre instead of straddling two.
      const deviceX = Math.round(toDeviceX(mesh.columnEdges[dividerIndex])) + 0.5
      context.beginPath()
      context.moveTo(deviceX, top)
      context.lineTo(deviceX, bottom)
      context.stroke()
    }

    for (const dividerIndex of getInteriorDividerIndexes(mesh, 'row')) {
      const highlighted = isHighlighted('row', dividerIndex)
      context.lineWidth =
        (highlighted ? DIVIDER_GRAB_WIDTH_IN_SCREEN_PIXELS : DIVIDER_WIDTH_IN_SCREEN_PIXELS) *
        frame.devicePixelRatio
      context.strokeStyle = highlighted ? DIVIDER_GRAB_COLOR : DIVIDER_COLOR

      const deviceY = Math.round(toDeviceY(mesh.rowEdges[dividerIndex])) + 0.5
      context.beginPath()
      context.moveTo(left, deviceY)
      context.lineTo(right, deviceY)
      context.stroke()
    }
  }

  private drawMergedCells(
    layoutDocument: LayoutDocument,
    mesh: TableMesh,
    frame: RenderFrame,
    toDeviceX: (worldX: number) => number,
    toDeviceY: (worldY: number) => number,
  ): void {
    const { context } = this
    const devicePixelsPerWorldUnit = frame.camera.scale * frame.devicePixelRatio

    for (const cell of mesh.cells) {
      if (cell.rowSpan === 1 && cell.columnSpan === 1) {
        continue
      }
      if ((layoutDocument.geometry.flags[cell.nodeId] & NODE_FLAG_REMOVED) !== 0) {
        continue
      }

      const cellBounds = getTableCellBounds(mesh, cell)
      if (!rectsIntersect(cellBounds, frame.visibleWorldRect)) {
        continue
      }

      const deviceX = toDeviceX(cellBounds.x)
      const deviceY = toDeviceY(cellBounds.y)
      const deviceWidth = cellBounds.width * devicePixelsPerWorldUnit
      const deviceHeight = cellBounds.height * devicePixelsPerWorldUnit

      context.fillStyle = MERGED_CELL_FILL_COLOR
      context.fillRect(deviceX, deviceY, deviceWidth, deviceHeight)
      context.lineWidth = OUTLINE_WIDTH_IN_SCREEN_PIXELS * frame.devicePixelRatio
      context.strokeStyle = MERGED_CELL_BORDER_COLOR
      context.strokeRect(deviceX, deviceY, deviceWidth, deviceHeight)
    }
  }
}

export function getMeshBounds(mesh: TableMesh): Rect {
  const left = mesh.columnEdges[0]
  const top = mesh.rowEdges[0]
  return {
    x: left,
    y: top,
    width: mesh.columnEdges[mesh.columnEdges.length - 1] - left,
    height: mesh.rowEdges[mesh.rowEdges.length - 1] - top,
  }
}

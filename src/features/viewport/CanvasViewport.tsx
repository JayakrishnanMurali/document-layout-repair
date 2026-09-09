import { useEffect, useRef, useState } from 'react'
import type { FrameStatisticsSnapshot } from '@/canvas/FrameStatistics'
import { ViewportInputController } from '@/canvas/input/ViewportInputController'
import { BoxEditGestureHandler } from '@/canvas/interaction/BoxEditGestureHandler'
import { MarqueeSelectGestureHandler } from '@/canvas/interaction/MarqueeSelectGestureHandler'
import { ReadingOrderGestureHandler } from '@/canvas/interaction/ReadingOrderGestureHandler'
import {
  TableMeshGestureHandler,
  type HighlightedDivider,
} from '@/canvas/interaction/TableMeshGestureHandler'
import { InteractionLayer } from '@/canvas/layers/InteractionLayer'
import { OverlayBoxLayer, type OverlayBoxLayerStatistics } from '@/canvas/layers/OverlayBoxLayer'
import { PageRasterLayer, type PageRasterLayerStatistics } from '@/canvas/layers/PageRasterLayer'
import { ReadingOrderLayer } from '@/canvas/layers/ReadingOrderLayer'
import { TableMeshLayer } from '@/canvas/layers/TableMeshLayer'
import { ViewportRenderEngine } from '@/canvas/ViewportRenderEngine'
import { clampZoomScale, fitWorldRectInViewport } from '@/canvas/viewport/camera'
import type { Rect } from '@/canvas/geometry'
import { NO_LAYOUT_NODE_ID } from '@/document/layoutTypes'
import { createDocumentPageLayout, getDocumentBounds, getPageBounds } from '@/document/pageLayout'
import { useDocumentStore } from '@/state/documentStore'
import { layoutEditor } from '@/state/editorStore'
import { registerViewportCommands } from '@/state/viewportCommands'
import { useWorkspaceStore } from '@/state/workspaceStore'
import { ViewportStatisticsOverlay } from './ViewportStatisticsOverlay'
import styles from './CanvasViewport.module.css'

export type CanvasViewportProps = {
  pageCount: number
  documentSeed: number
}

const LAYER_STATISTICS_INTERVAL_MILLISECONDS = 250
/** Focusing a small box should not slam the viewport to 500%. */
const MAXIMUM_FOCUS_SCALE = 2
const FOCUS_PADDING_FRACTION = 0.3

const EMPTY_FRAME_STATISTICS: FrameStatisticsSnapshot = {
  framesPerSecond: 0,
  lastFrameMilliseconds: 0,
  worstFrameMilliseconds: 0,
  ninetyFifthPercentileFrameMilliseconds: 0,
  renderedFrameCount: 0,
}

export function CanvasViewport({ pageCount, documentSeed }: CanvasViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [frameStatistics, setFrameStatistics] = useState(EMPTY_FRAME_STATISTICS)
  const [overlayStatistics, setOverlayStatistics] = useState<OverlayBoxLayerStatistics | null>(null)
  const [rasterStatistics, setRasterStatistics] = useState<PageRasterLayerStatistics | null>(null)
  const [zoomScale, setZoomScale] = useState(1)
  const [cameraOrigin, setCameraOrigin] = useState({ worldX: 0, worldY: 0 })

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const engine = new ViewportRenderEngine({
      container,
      pageCount,
      onStatistics: setFrameStatistics,
      onCameraChange: (camera) => {
        setZoomScale(camera.scale)
        setCameraOrigin({ worldX: camera.worldX, worldY: camera.worldY })
      },
    })

    const pageRasterLayer = new PageRasterLayer(engine.createLayerCanvas(), documentSeed, () =>
      engine.markDirty('pageRaster'),
    )
    engine.addLayer(pageRasterLayer)

    const overlayBoxLayer = new OverlayBoxLayer({
      canvas: engine.createLayerCanvas(),
      getDocument: () => layoutEditor.getDocument(),
      getIsCullingEnabled: () => useWorkspaceStore.getState().isViewportCullingEnabled,
      onContextRestored: () => engine.markDirty('overlayBoxes'),
    })
    engine.addLayer(overlayBoxLayer)

    const isReadingOrderToolActive = () =>
      useWorkspaceStore.getState().activeToolId === 'readingOrder'

    const readingOrderLayer = new ReadingOrderLayer(
      engine.createLayerCanvas(),
      () => layoutEditor.getDocument(),
      isReadingOrderToolActive,
    )
    engine.addLayer(readingOrderLayer)

    const isTableMeshToolActive = () => useWorkspaceStore.getState().activeToolId === 'tableMesh'

    let highlightedDivider: HighlightedDivider | null = null
    const tableMeshLayer = new TableMeshLayer(
      engine.createLayerCanvas(),
      () => layoutEditor.getDocument(),
      isTableMeshToolActive,
      () => highlightedDivider,
    )
    engine.addLayer(tableMeshLayer)

    const interactionLayer = new InteractionLayer(
      engine.createLayerCanvas(),
      () => layoutEditor.getDocument(),
      () => layoutEditor.getInteractionState(),
    )
    engine.addLayer(interactionLayer)

    const unsubscribeFromEditor = layoutEditor.subscribe((changeKind) => {
      // Only a geometry or document change can move a box, so only those re-cull the
      // instanced overlay; selection and chrome repaint the interaction layer alone.
      if (changeKind === 'geometry' || changeKind === 'document') {
        overlayBoxLayer.invalidateDocument()
        engine.markDirty(overlayBoxLayer.name)
        engine.markDirty(readingOrderLayer.name)
        engine.markDirty(tableMeshLayer.name)
      }
      engine.markDirty(interactionLayer.name)
    })

    let lastSeenCullingSetting = useWorkspaceStore.getState().isViewportCullingEnabled
    let lastSeenToolId = useWorkspaceStore.getState().activeToolId
    const unsubscribeFromWorkspace = useWorkspaceStore.subscribe((state) => {
      if (state.isViewportCullingEnabled !== lastSeenCullingSetting) {
        lastSeenCullingSetting = state.isViewportCullingEnabled
        engine.markDirty(overlayBoxLayer.name)
      }
      if (state.activeToolId !== lastSeenToolId) {
        lastSeenToolId = state.activeToolId
        highlightedDivider = null
        engine.markDirty(readingOrderLayer.name)
        engine.markDirty(tableMeshLayer.name)
        engine.markDirty(interactionLayer.name)
      }
    })

    const selectAtWorldPoint = async (
      worldPoint: { x: number; y: number },
      mode: 'replace' | 'toggle',
    ) => {
      const nodeId = await useDocumentStore.getState().hitTestAtWorldPoint(worldPoint.x, worldPoint.y)
      layoutEditor.selectNode(nodeId, mode)
    }

    let isHoverHitTestInFlight = false
    const updateHover = async (worldPoint: { x: number; y: number } | null) => {
      if (!worldPoint) {
        layoutEditor.setHoveredNodeId(NO_LAYOUT_NODE_ID)
        return
      }
      // One outstanding hover query at a time; the next pointer move re-issues it, so
      // dropping intermediate positions costs nothing and bounds the message traffic.
      if (isHoverHitTestInFlight) {
        return
      }
      isHoverHitTestInFlight = true
      try {
        const nodeId = await useDocumentStore.getState().hitTestAtWorldPoint(worldPoint.x, worldPoint.y)
        layoutEditor.setHoveredNodeId(nodeId)
      } finally {
        isHoverHitTestInFlight = false
      }
    }

    const inputController = new ViewportInputController({
      element: container,
      engine,
      gestureHandlers: [
        new ReadingOrderGestureHandler({
          editor: layoutEditor,
          getPageLayout: () => engine.getPageLayout(),
          getIsActive: isReadingOrderToolActive,
        }),
        new TableMeshGestureHandler({
          editor: layoutEditor,
          getPageLayout: () => engine.getPageLayout(),
          getIsActive: isTableMeshToolActive,
          onHighlightedDividerChanged: (divider) => {
            const hasChanged =
              divider?.tableNodeId !== highlightedDivider?.tableNodeId ||
              divider?.axis !== highlightedDivider?.axis ||
              divider?.dividerIndex !== highlightedDivider?.dividerIndex
            if (!hasChanged) {
              return
            }
            highlightedDivider = divider
            engine.markDirty(tableMeshLayer.name)
          },
        }),
        new BoxEditGestureHandler({
          editor: layoutEditor,
          getPageLayout: () => engine.getPageLayout(),
          getIsEnabled: () => useWorkspaceStore.getState().activeToolId === 'select',
        }),
        new MarqueeSelectGestureHandler({
          editor: layoutEditor,
          getPageLayout: () => engine.getPageLayout(),
          onToggleAtWorldPoint: (worldPoint) => {
            void selectAtWorldPoint(worldPoint, 'toggle')
          },
        }),
      ],
      onFitDocumentRequested: () =>
        engine.setCamera(
          fitWorldRectInViewport(
            getDocumentBounds(engine.getPageLayout()),
            engine.getViewportSize(),
          ),
        ),
      onTap: (worldPoint, event) => {
        void selectAtWorldPoint(worldPoint, event.shiftKey ? 'toggle' : 'replace')
      },
      onHover: (worldPoint) => {
        void updateHover(worldPoint)
      },
    })

    /**
     * Eases the camera until a world rectangle is comfortably in view. Used by the
     * structure tree to ground a row on the page without teleporting the reviewer.
     */
    const focusWorldRect = (worldRect: Rect) => {
      const viewportSize = engine.getViewportSize()
      if (viewportSize.width === 0 || viewportSize.height === 0) {
        return
      }

      const fitted = fitWorldRectInViewport(worldRect, viewportSize, FOCUS_PADDING_FRACTION)
      const targetScale = clampZoomScale(Math.min(fitted.scale, MAXIMUM_FOCUS_SCALE))

      engine.animateCameraTo({
        worldX: worldRect.x + worldRect.width / 2 - viewportSize.width / (2 * targetScale),
        worldY: worldRect.y + worldRect.height / 2 - viewportSize.height / (2 * targetScale),
        scale: targetScale,
      })
    }
    registerViewportCommands({ focusWorldRect })

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      const isUndoRedoChord = event.metaKey || event.ctrlKey
      if (isUndoRedoChord && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) {
          layoutEditor.redo()
        } else {
          layoutEditor.undo()
        }
        return
      }
      if (event.key === 'Escape') {
        layoutEditor.clearSelection()
      }
    }
    window.addEventListener('keydown', handleWindowKeyDown)

    engine.setCamera(
      fitWorldRectInViewport(
        getPageBounds(createDocumentPageLayout(pageCount), 0),
        engine.getViewportSize(),
      ),
    )
    setZoomScale(engine.getCamera().scale)
    setCameraOrigin({
      worldX: engine.getCamera().worldX,
      worldY: engine.getCamera().worldY,
    })

    const layerStatisticsInterval = window.setInterval(() => {
      setOverlayStatistics(overlayBoxLayer.statistics)
      setRasterStatistics(pageRasterLayer.statistics)
    }, LAYER_STATISTICS_INTERVAL_MILLISECONDS)

    return () => {
      window.clearInterval(layerStatisticsInterval)
      window.removeEventListener('keydown', handleWindowKeyDown)
      registerViewportCommands(null)
      unsubscribeFromEditor()
      unsubscribeFromWorkspace()
      inputController.dispose()
      engine.dispose()
    }
  }, [pageCount, documentSeed])

  return (
    <div className={styles.viewport} ref={containerRef} aria-label="Document layout canvas">
      <ViewportStatisticsOverlay
        frameStatistics={frameStatistics}
        overlayStatistics={overlayStatistics}
        rasterStatistics={rasterStatistics}
        zoomScale={zoomScale}
        cameraOrigin={cameraOrigin}
      />
    </div>
  )
}

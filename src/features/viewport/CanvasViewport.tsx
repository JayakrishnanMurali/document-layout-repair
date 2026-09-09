import { useEffect, useRef, useState } from 'react'
import type { FrameStatisticsSnapshot } from '@/canvas/FrameStatistics'
import { ViewportInputController } from '@/canvas/input/ViewportInputController'
import { BoxEditGestureHandler } from '@/canvas/interaction/BoxEditGestureHandler'
import { MarqueeSelectGestureHandler } from '@/canvas/interaction/MarqueeSelectGestureHandler'
import { InteractionLayer } from '@/canvas/layers/InteractionLayer'
import { OverlayBoxLayer, type OverlayBoxLayerStatistics } from '@/canvas/layers/OverlayBoxLayer'
import { PageRasterLayer, type PageRasterLayerStatistics } from '@/canvas/layers/PageRasterLayer'
import { ViewportRenderEngine } from '@/canvas/ViewportRenderEngine'
import { fitWorldRectInViewport } from '@/canvas/viewport/camera'
import { NO_LAYOUT_NODE_ID } from '@/document/layoutTypes'
import { createDocumentPageLayout, getDocumentBounds, getPageBounds } from '@/document/pageLayout'
import { useDocumentStore } from '@/state/documentStore'
import { layoutEditor } from '@/state/editorStore'
import { useWorkspaceStore } from '@/state/workspaceStore'
import { ViewportStatisticsOverlay } from './ViewportStatisticsOverlay'
import styles from './CanvasViewport.module.css'

export type CanvasViewportProps = {
  pageCount: number
  documentSeed: number
}

const LAYER_STATISTICS_INTERVAL_MILLISECONDS = 250

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

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const engine = new ViewportRenderEngine({
      container,
      pageCount,
      onStatistics: setFrameStatistics,
      onCameraChange: (camera) => setZoomScale(camera.scale),
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
      }
      engine.markDirty(interactionLayer.name)
    })

    let lastSeenCullingSetting = useWorkspaceStore.getState().isViewportCullingEnabled
    const unsubscribeFromWorkspace = useWorkspaceStore.subscribe((state) => {
      if (state.isViewportCullingEnabled === lastSeenCullingSetting) {
        return
      }
      lastSeenCullingSetting = state.isViewportCullingEnabled
      engine.markDirty(overlayBoxLayer.name)
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
        new BoxEditGestureHandler({ editor: layoutEditor, getPageLayout: () => engine.getPageLayout() }),
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

    const layerStatisticsInterval = window.setInterval(() => {
      setOverlayStatistics(overlayBoxLayer.statistics)
      setRasterStatistics(pageRasterLayer.statistics)
    }, LAYER_STATISTICS_INTERVAL_MILLISECONDS)

    return () => {
      window.clearInterval(layerStatisticsInterval)
      window.removeEventListener('keydown', handleWindowKeyDown)
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
      />
    </div>
  )
}

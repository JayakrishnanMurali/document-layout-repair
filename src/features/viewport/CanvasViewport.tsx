import { useEffect, useRef, useState } from 'react'
import type { FrameStatisticsSnapshot } from '@/canvas/FrameStatistics'
import { ViewportInputController } from '@/canvas/input/ViewportInputController'
import { OverlayBoxLayer, type OverlayBoxLayerStatistics } from '@/canvas/layers/OverlayBoxLayer'
import { PageRasterLayer, type PageRasterLayerStatistics } from '@/canvas/layers/PageRasterLayer'
import { ViewportRenderEngine } from '@/canvas/ViewportRenderEngine'
import { fitWorldRectInViewport } from '@/canvas/viewport/camera'
import { createDocumentPageLayout, getDocumentBounds, getPageBounds } from '@/document/pageLayout'
import { useDocumentStore } from '@/state/documentStore'
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
      getDocument: () => useDocumentStore.getState().document,
      getIsCullingEnabled: () => useWorkspaceStore.getState().isViewportCullingEnabled,
      onContextRestored: () => engine.markDirty('overlayBoxes'),
    })
    engine.addLayer(overlayBoxLayer)

    let lastSeenCullingSetting = useWorkspaceStore.getState().isViewportCullingEnabled
    const unsubscribeFromWorkspace = useWorkspaceStore.subscribe((state) => {
      if (state.isViewportCullingEnabled === lastSeenCullingSetting) {
        return
      }
      lastSeenCullingSetting = state.isViewportCullingEnabled
      engine.markDirty(overlayBoxLayer.name)
    })

    let lastSeenDocument = useDocumentStore.getState().document
    const unsubscribeFromDocument = useDocumentStore.subscribe((state) => {
      if (state.document === lastSeenDocument) {
        return
      }
      lastSeenDocument = state.document
      overlayBoxLayer.invalidateDocument()
      engine.markDirty(overlayBoxLayer.name)
    })

    const inputController = new ViewportInputController({
      element: container,
      engine,
      onFitDocumentRequested: () =>
        engine.setCamera(
          fitWorldRectInViewport(
            getDocumentBounds(engine.getPageLayout()),
            engine.getViewportSize(),
          ),
        ),
      onTap: (worldPoint) => {
        void useDocumentStore.getState().selectNodeAtWorldPoint(worldPoint.x, worldPoint.y)
      },
    })

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
      unsubscribeFromDocument()
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

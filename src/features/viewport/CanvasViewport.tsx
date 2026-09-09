import { useEffect, useRef, useState } from 'react'
import { ViewportInputController } from '@/canvas/input/ViewportInputController'
import { PageRasterLayer } from '@/canvas/layers/PageRasterLayer'
import { ViewportRenderEngine } from '@/canvas/ViewportRenderEngine'
import { fitWorldRectInViewport } from '@/canvas/viewport/camera'
import type { FrameStatisticsSnapshot } from '@/canvas/FrameStatistics'
import { computeDocumentBounds, computePageBounds } from '@/document/pageLayout'
import { useDocumentStore } from '@/state/documentStore'
import { ViewportStatisticsOverlay } from './ViewportStatisticsOverlay'
import styles from './CanvasViewport.module.css'

export type CanvasViewportProps = {
  pageCount: number
  documentSeed: number
}

const EMPTY_STATISTICS: FrameStatisticsSnapshot = {
  framesPerSecond: 0,
  lastFrameMilliseconds: 0,
  worstFrameMilliseconds: 0,
  ninetyFifthPercentileFrameMilliseconds: 0,
  renderedFrameCount: 0,
}

export function CanvasViewport({ pageCount, documentSeed }: CanvasViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [frameStatistics, setFrameStatistics] = useState(EMPTY_STATISTICS)
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

    const fitFirstPage = () => {
      engine.setCamera(fitWorldRectInViewport(computePageBounds(0), engine.getViewportSize()))
    }
    const fitWholeDocument = () => {
      engine.setCamera(
        fitWorldRectInViewport(computeDocumentBounds(pageCount), engine.getViewportSize()),
      )
    }

    const inputController = new ViewportInputController({
      element: container,
      engine,
      onFitDocumentRequested: fitWholeDocument,
      onTap: (worldPoint) => {
        void useDocumentStore.getState().selectNodeAtWorldPoint(worldPoint.x, worldPoint.y)
      },
    })

    fitFirstPage()
    setZoomScale(engine.getCamera().scale)

    return () => {
      inputController.dispose()
      engine.dispose()
    }
  }, [pageCount, documentSeed])

  return (
    <div className={styles.viewport} ref={containerRef} aria-label="Document layout canvas">
      <ViewportStatisticsOverlay statistics={frameStatistics} zoomScale={zoomScale} />
    </div>
  )
}

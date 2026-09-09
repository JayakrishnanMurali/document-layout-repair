import type { FrameStatisticsSnapshot } from '@/canvas/FrameStatistics'
import type { OverlayBoxLayerStatistics } from '@/canvas/layers/OverlayBoxLayer'
import type { PageRasterLayerStatistics } from '@/canvas/layers/PageRasterLayer'
import styles from './ViewportStatisticsOverlay.module.css'

const FRAME_BUDGET_MILLISECONDS = 16.67
const NUMBER_FORMATTER = new Intl.NumberFormat('en-US')

export type ViewportStatisticsOverlayProps = {
  frameStatistics: FrameStatisticsSnapshot
  overlayStatistics: OverlayBoxLayerStatistics | null
  rasterStatistics: PageRasterLayerStatistics | null
  zoomScale: number
}

export function ViewportStatisticsOverlay({
  frameStatistics,
  overlayStatistics,
  rasterStatistics,
  zoomScale,
}: ViewportStatisticsOverlayProps) {
  const isWithinFrameBudget =
    frameStatistics.ninetyFifthPercentileFrameMilliseconds <= FRAME_BUDGET_MILLISECONDS
  const budgetClassName = isWithinFrameBudget ? styles.valueHealthy : styles.valueDegraded

  return (
    <div className={styles.overlay}>
      <span className={styles.label}>fps</span>
      <span data-testid="frames-per-second" className={budgetClassName}>
        {frameStatistics.framesPerSecond === 0 ? 'idle' : frameStatistics.framesPerSecond}
      </span>

      <span className={styles.label}>frame</span>
      <span className={styles.value}>{frameStatistics.lastFrameMilliseconds.toFixed(2)} ms</span>

      <span className={styles.label}>p95</span>
      <span className={budgetClassName}>
        {frameStatistics.ninetyFifthPercentileFrameMilliseconds.toFixed(2)} ms
      </span>

      <span className={styles.label}>zoom</span>
      <span className={styles.value} data-testid="zoom-readout">
        {Math.round(zoomScale * 100)}%
      </span>

      {overlayStatistics && (
        <>
          <span className={styles.label}>boxes drawn</span>
          <span className={styles.value} data-testid="drawn-box-count">
            {NUMBER_FORMATTER.format(overlayStatistics.instanceCount)}
          </span>

          <span className={styles.label}>culled from</span>
          <span className={styles.value}>
            {NUMBER_FORMATTER.format(overlayStatistics.scannedNodeCount)}
          </span>

          <span className={styles.label}>cull</span>
          <span className={styles.value}>
            {overlayStatistics.rebuildMilliseconds.toFixed(2)} ms
          </span>

          <span className={styles.label}>renderer</span>
          <span className={styles.value} data-testid="overlay-renderer">
            {overlayStatistics.rendererKind}
          </span>
        </>
      )}

      {rasterStatistics && (
        <>
          <span className={styles.label}>tiles</span>
          <span className={styles.value}>
            {rasterStatistics.drawnTileCount}/{rasterStatistics.cachedTileCount}
            {rasterStatistics.pendingRasterCount > 0
              ? ` +${rasterStatistics.pendingRasterCount}`
              : ''}
          </span>
        </>
      )}
    </div>
  )
}

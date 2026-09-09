import type { FrameStatisticsSnapshot } from '@/canvas/FrameStatistics'
import styles from './ViewportStatisticsOverlay.module.css'

const FRAME_BUDGET_MILLISECONDS = 16.67

export type ViewportStatisticsOverlayProps = {
  statistics: FrameStatisticsSnapshot
  zoomScale: number
}

export function ViewportStatisticsOverlay({
  statistics,
  zoomScale,
}: ViewportStatisticsOverlayProps) {
  const isWithinFrameBudget =
    statistics.ninetyFifthPercentileFrameMilliseconds <= FRAME_BUDGET_MILLISECONDS

  return (
    <div className={styles.overlay}>
      <span className={styles.label}>fps</span>
      <span
        data-testid="frames-per-second"
        className={isWithinFrameBudget ? styles.valueHealthy : styles.valueDegraded}
      >
        {statistics.framesPerSecond === 0 ? 'idle' : statistics.framesPerSecond}
      </span>

      <span className={styles.label}>frame</span>
      <span className={styles.value}>{statistics.lastFrameMilliseconds.toFixed(2)} ms</span>

      <span className={styles.label}>p95</span>
      <span className={isWithinFrameBudget ? styles.valueHealthy : styles.valueDegraded}>
        {statistics.ninetyFifthPercentileFrameMilliseconds.toFixed(2)} ms
      </span>

      <span className={styles.label}>worst</span>
      <span className={styles.value}>{statistics.worstFrameMilliseconds.toFixed(2)} ms</span>

      <span className={styles.label}>zoom</span>
      <span className={styles.value} data-testid="zoom-readout">
        {Math.round(zoomScale * 100)}%
      </span>
    </div>
  )
}

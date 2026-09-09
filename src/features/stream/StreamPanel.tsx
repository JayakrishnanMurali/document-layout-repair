import { useDocumentStore } from '@/state/documentStore'
import { useActiveDocumentPreset } from '@/state/workspaceStore'
import { useMainThreadLongTasks } from './useMainThreadLongTasks'
import styles from './StreamPanel.module.css'

const NUMBER_FORMATTER = new Intl.NumberFormat('en-US')

/**
 * Live view of the extraction stream.
 *
 * The numbers that matter here are the two the brief asks about: how long the worker
 * spends on the heaviest event, and how many long tasks the main thread suffered while
 * pages were arriving. Both are measured, not claimed.
 */
export function StreamPanel() {
  const activePreset = useActiveDocumentPreset()
  const streamStatus = useDocumentStore((state) => state.streamStatus)
  const streamSource = useDocumentStore((state) => state.streamSource)
  const statistics = useDocumentStore((state) => state.streamStatistics)
  const streamLog = useDocumentStore((state) => state.streamLog)
  const failureReason = useDocumentStore((state) => state.streamFailureReason)
  const stopStream = useDocumentStore((state) => state.stopStream)
  const loadPreset = useDocumentStore((state) => state.loadPreset)
  const streamRunId = useDocumentStore((state) => state.streamRunId)
  const streamStartedAtMilliseconds = useDocumentStore(
    (state) => state.streamStartedAtMilliseconds,
  )

  const longTasks = useMainThreadLongTasks(streamRunId, streamStartedAtMilliseconds)

  if (streamStatus === 'idle') {
    return null
  }

  const ingestedPageCount = statistics?.ingestedPageCount ?? 0
  const progressFraction = activePreset.pageCount
    ? Math.min(1, ingestedPageCount / activePreset.pageCount)
    : 0
  const isLive = streamStatus === 'streaming' || streamStatus === 'connecting'

  return (
    <section className={styles.panel} aria-label="Extraction stream" data-testid="stream-panel">
      <header className={styles.header}>
        <span
          className={
            streamStatus === 'failed'
              ? styles.statusDotFailed
              : isLive
                ? styles.statusDotLive
                : styles.statusDot
          }
        />
        <span className={styles.title}>Extraction stream</span>
        <span className={styles.label} data-testid="stream-status">
          {streamStatus}
          {streamSource ? ` · ${streamSource}` : ''}
        </span>

        {isLive ? (
          <button type="button" className={styles.headerAction} onClick={stopStream}>
            disconnect
          </button>
        ) : (
          <button
            type="button"
            className={styles.headerAction}
            onClick={() => void loadPreset(activePreset)}
          >
            reconnect
          </button>
        )}
      </header>

      <div className={styles.progressTrack}>
        <div className={styles.progressBar} style={{ width: `${progressFraction * 100}%` }} />
      </div>

      <div className={styles.metrics}>
        <span className={styles.label}>pages</span>
        <span className={styles.value} data-testid="stream-pages">
          {ingestedPageCount}/{activePreset.pageCount}
        </span>
        <span className={styles.label}>boxes</span>
        <span className={styles.value}>
          {NUMBER_FORMATTER.format(statistics?.nodeCount ?? 0)}
        </span>

        <span className={styles.label}>events</span>
        <span className={styles.value}>{statistics?.eventCount ?? 0}</span>
        <span className={styles.label}>worst event</span>
        <span
          className={
            (statistics?.worstEventMilliseconds ?? 0) < 16 ? styles.valueHealthy : styles.valueDegraded
          }
          data-testid="stream-worst-event"
        >
          {(statistics?.worstEventMilliseconds ?? 0).toFixed(2)} ms
        </span>

        <span className={styles.label}>long tasks</span>
        <span
          className={longTasks.longTaskCount === 0 ? styles.valueHealthy : styles.valueDegraded}
          data-testid="stream-long-tasks"
        >
          {longTasks.isSupported ? longTasks.longTaskCount : 'n/a'}
        </span>
        <span className={styles.label}>worst task</span>
        <span className={styles.value}>
          {longTasks.isSupported
            ? `${longTasks.worstLongTaskMilliseconds.toFixed(0)} ms`
            : 'n/a'}
        </span>
      </div>

      {failureReason && <p className={styles.note}>{failureReason}</p>}

      <div className={styles.log} data-testid="stream-log">
        {streamLog.map((entry) => (
          <div className={styles.logRow} key={entry.eventIndex}>
            <span className={styles.logPage}>p{entry.pageIndex + 1}</span>
            <span>+{entry.nodeCount} boxes</span>
            <span>{entry.workerMilliseconds.toFixed(2)} ms</span>
          </div>
        ))}
      </div>

      <p className={styles.note}>
        Chunks arrive out of order and interleaved. Parsing, reconciliation and spatial
        indexing all happen in the worker — the main thread only composites.
      </p>
    </section>
  )
}

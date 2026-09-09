import { getLayoutNodeClassName, NO_LAYOUT_NODE_ID } from '@/document/layoutTypes'
import { useDocumentStore } from '@/state/documentStore'
import styles from './WorkspaceStatusBar.module.css'

const NUMBER_FORMATTER = new Intl.NumberFormat('en-US')

export function WorkspaceStatusBar() {
  const status = useDocumentStore((state) => state.status)
  const pageCount = useDocumentStore((state) => state.pageCount)
  const nodeCount = useDocumentStore((state) => state.nodeCount)
  const ingestedPageCount = useDocumentStore((state) => state.ingestedPageCount)
  const timings = useDocumentStore((state) => state.timings)
  const lastHitTestMilliseconds = useDocumentStore((state) => state.lastHitTestMilliseconds)
  const selectedNodeId = useDocumentStore((state) => state.selectedNodeId)
  const layoutDocument = useDocumentStore((state) => state.document)

  const selectionLabel = (() => {
    if (selectedNodeId === NO_LAYOUT_NODE_ID || !layoutDocument) {
      return null
    }
    const className = getLayoutNodeClassName(layoutDocument.geometry.classIds[selectedNodeId])
    const text = layoutDocument.texts[selectedNodeId]
    const confidence = layoutDocument.geometry.confidences[selectedNodeId]
    const truncatedText = text && text.length > 64 ? `${text.slice(0, 64)}…` : text
    return `${className} · ${(confidence * 100).toFixed(1)}%${truncatedText ? ` · "${truncatedText}"` : ''}`
  })()

  return (
    <footer className={styles.statusBar}>
      <span className={styles.metric}>
        <span className={styles.metricValue}>{pageCount}</span> pages
      </span>

      {status === 'loading' ? (
        <span className={styles.metric} data-testid="load-progress">
          extracting <span className={styles.metricValue}>{ingestedPageCount}</span>/{pageCount} ·{' '}
          {NUMBER_FORMATTER.format(nodeCount)} boxes
        </span>
      ) : (
        <span className={styles.metric} data-testid="box-count">
          <span className={styles.metricValue}>{NUMBER_FORMATTER.format(nodeCount)}</span> boxes
        </span>
      )}

      {timings && (
        <span className={styles.metric}>
          parse <span className={styles.metricValue}>{timings.parseMilliseconds.toFixed(0)} ms</span>
          {' · '}index{' '}
          <span className={styles.metricValue}>{timings.indexMilliseconds.toFixed(0)} ms</span>
        </span>
      )}

      {lastHitTestMilliseconds > 0 && (
        <span className={styles.metric} data-testid="hit-test-time">
          hit-test{' '}
          <span className={styles.metricValue}>{lastHitTestMilliseconds.toFixed(3)} ms</span>
        </span>
      )}

      {selectionLabel && (
        <span className={styles.selection} data-testid="selection-label">
          {selectionLabel}
        </span>
      )}

      <span className={styles.hints}>
        drag pan · wheel zoom · click select · 0 fit · 1 actual size
      </span>
    </footer>
  )
}

import { useMemo, useState } from 'react'
import { NO_LAYOUT_NODE_ID } from '@/document/layoutTypes'
import { createDocumentPageLayout } from '@/document/pageLayout'
import {
  serializeNodeAsMarkdown,
  serializeNodeSubtree,
  serializePage,
  serializePageAsMarkdown,
} from '@/document/serialization/nodeSerialization'
import { useDocumentStore } from '@/state/documentStore'
import { useEditorStore, usePrimarySelectedNodeId } from '@/state/editorStore'
import { SelectionInspector } from './SelectionInspector'
import styles from './InspectorPanel.module.css'

type InspectorTabId = 'properties' | 'json' | 'markdown'

const TAB_LABELS: Record<InspectorTabId, string> = {
  properties: 'Properties',
  json: 'JSON',
  markdown: 'Markdown',
}

/**
 * The other half of bi-directional grounding: whatever is selected on the canvas is
 * described here as properties, as the JSON that will be exported, and as the Markdown
 * the repaired structure produces.
 */
export function InspectorPanel() {
  const layoutDocument = useDocumentStore((state) => state.document)
  const selectedNodeId = usePrimarySelectedNodeId()
  // Re-serialize after every committed transaction.
  const structureVersion = useEditorStore((state) => state.structureVersion)
  const [activeTabId, setActiveTabId] = useState<InspectorTabId>('properties')

  const scopePageIndex =
    layoutDocument && selectedNodeId !== NO_LAYOUT_NODE_ID
      ? layoutDocument.geometry.pageIndexes[selectedNodeId]
      : 0

  const serializedText = useMemo(() => {
    if (!layoutDocument || activeTabId === 'properties') {
      return ''
    }

    const pageLayout = createDocumentPageLayout(layoutDocument.pageCount)
    const hasSelection = selectedNodeId !== NO_LAYOUT_NODE_ID

    if (activeTabId === 'json') {
      const serialized = hasSelection
        ? serializeNodeSubtree(layoutDocument, pageLayout, selectedNodeId)
        : serializePage(layoutDocument, pageLayout, scopePageIndex)
      return JSON.stringify(serialized, null, 2)
    }

    return hasSelection
      ? serializeNodeAsMarkdown(layoutDocument, selectedNodeId)
      : serializePageAsMarkdown(layoutDocument, scopePageIndex)
    // `structureVersion` is not read above, but an edit changes the document in place —
    // it is what marks the serialized text stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutDocument, activeTabId, selectedNodeId, scopePageIndex, structureVersion])

  return (
    <div className={styles.panel}>
      <div className={styles.tabBar}>
        {(Object.keys(TAB_LABELS) as InspectorTabId[]).map((tabId) => (
          <button
            key={tabId}
            type="button"
            className={tabId === activeTabId ? styles.tabActive : styles.tab}
            aria-pressed={tabId === activeTabId}
            onClick={() => setActiveTabId(tabId)}
          >
            {TAB_LABELS[tabId]}
          </button>
        ))}

        {activeTabId !== 'properties' && serializedText.length > 0 && (
          <button
            type="button"
            className={styles.copyButton}
            onClick={() => void navigator.clipboard?.writeText(serializedText)}
          >
            copy
          </button>
        )}
      </div>

      <div className={styles.body}>
        {activeTabId === 'properties' ? (
          <SelectionInspector />
        ) : (
          <>
            <p className={styles.scopeNote}>
              {selectedNodeId === NO_LAYOUT_NODE_ID
                ? `whole page ${scopePageIndex + 1} — select a box to narrow this down`
                : 'selected box and its children'}
            </p>
            <pre
              className={
                activeTabId === 'markdown' ? `${styles.code} ${styles.markdown}` : styles.code
              }
              data-testid={activeTabId === 'json' ? 'inspector-json' : 'inspector-markdown'}
            >
              {serializedText}
            </pre>
          </>
        )}
      </div>
    </div>
  )
}

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
import { TableMeshTools } from './TableMeshTools'
import styles from './InspectorPanel.module.css'

type InspectorTabId = 'properties' | 'json' | 'markdown'

/**
 * A marquee can enclose hundreds of boxes; serializing all of them on every pointer move
 * would be wasted work nobody reads. The panes show a bounded prefix and say so.
 */
const MAXIMUM_SERIALIZED_SELECTION_SIZE = 50

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
  const primarySelectedNodeId = usePrimarySelectedNodeId()
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds)
  // Re-serialize after every committed transaction.
  const structureVersion = useEditorStore((state) => state.structureVersion)
  const [activeTabId, setActiveTabId] = useState<InspectorTabId>('properties')

  const scopePageIndex =
    layoutDocument && primarySelectedNodeId !== NO_LAYOUT_NODE_ID
      ? layoutDocument.geometry.pageIndexes[primarySelectedNodeId]
      : 0

  /**
   * Document order, not selection order: node ids are handed out page by page in reading
   * order, so the panes read top-to-bottom and stay stable while a marquee grows instead
   * of jumping to whichever box happened to be enclosed last.
   */
  const serializedNodeIds = useMemo(
    () =>
      [...selectedNodeIds]
        .sort((left, right) => left - right)
        .slice(0, MAXIMUM_SERIALIZED_SELECTION_SIZE),
    [selectedNodeIds],
  )

  const serializedText = useMemo(() => {
    if (!layoutDocument || activeTabId === 'properties') {
      return ''
    }

    const pageLayout = createDocumentPageLayout(layoutDocument.pageCount)

    if (activeTabId === 'json') {
      if (serializedNodeIds.length === 0) {
        return JSON.stringify(serializePage(layoutDocument, pageLayout, scopePageIndex), null, 2)
      }
      const serializedNodes = serializedNodeIds
        .map((nodeId) => serializeNodeSubtree(layoutDocument, pageLayout, nodeId))
        .filter((node) => node !== null)
      return JSON.stringify(
        serializedNodes.length === 1 ? serializedNodes[0] : serializedNodes,
        null,
        2,
      )
    }

    if (serializedNodeIds.length === 0) {
      return serializePageAsMarkdown(layoutDocument, scopePageIndex)
    }
    return serializedNodeIds
      .map((nodeId) => serializeNodeAsMarkdown(layoutDocument, nodeId))
      .filter((block) => block.length > 0)
      .join('\n\n')
    // `structureVersion` is not read above, but an edit changes the document in place —
    // it is what marks the serialized text stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutDocument, activeTabId, serializedNodeIds, scopePageIndex, structureVersion])

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
          <>
            <TableMeshTools />
            <SelectionInspector />
          </>
        ) : (
          <>
            <p className={styles.scopeNote} data-testid="inspector-scope">
              {describeScope(selectedNodeIds.length, serializedNodeIds.length, scopePageIndex)}
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

function describeScope(
  selectedNodeCount: number,
  serializedNodeCount: number,
  scopePageIndex: number,
): string {
  if (selectedNodeCount === 0) {
    return `whole page ${scopePageIndex + 1} — select a box to narrow this down`
  }
  if (selectedNodeCount === 1) {
    return 'selected box and its children'
  }
  if (serializedNodeCount < selectedNodeCount) {
    return `first ${serializedNodeCount} of ${selectedNodeCount} selected boxes, in reading order`
  }
  return `${selectedNodeCount} selected boxes, in reading order`
}

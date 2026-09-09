import { useMemo } from 'react'
import { NODE_CLASS_STYLES } from '@/canvas/overlay/nodeClassStyles'
import {
  LAYOUT_NODE_CLASSES,
  LOW_CONFIDENCE_THRESHOLD,
  NODE_FLAG_EDITED,
  NODE_FLAG_LOW_CONFIDENCE,
  NO_LAYOUT_NODE_ID,
  getLayoutNodeClassId,
  getLayoutNodeClassName,
  type LayoutDocument,
  type LayoutNodeClass,
  type LayoutNodeId,
} from '@/document/layoutTypes'
import { useDocumentStore } from '@/state/documentStore'
import { layoutEditor, useEditorStore, usePrimarySelectedNodeId } from '@/state/editorStore'
import styles from './SelectionInspector.module.css'

/** Characters of combined text to show before truncating a multi-box selection. */
const MAXIMUM_COMBINED_TEXT_LENGTH = 2000

type SelectionSummary = {
  countsByClassName: { className: LayoutNodeClass; count: number }[]
  lowConfidenceCount: number
  editedCount: number
  lowestConfidence: number
  highestConfidence: number
  pageNumbers: number[]
  combinedText: string
  isCombinedTextTruncated: boolean
}

function summarizeSelection(
  layoutDocument: LayoutDocument,
  selectedNodeIds: readonly LayoutNodeId[],
): SelectionSummary {
  const { geometry } = layoutDocument
  const countsByClassId = new Map<number, number>()
  const pageNumbers = new Set<number>()
  const textFragments: string[] = []

  let lowConfidenceCount = 0
  let editedCount = 0
  let lowestConfidence = 1
  let highestConfidence = 0
  let combinedTextLength = 0
  let isCombinedTextTruncated = false

  // Document order rather than selection order: node ids are assigned page by page in
  // reading order, so this stays stable while a marquee is still growing.
  for (const nodeId of [...selectedNodeIds].sort((left, right) => left - right)) {
    countsByClassId.set(geometry.classIds[nodeId], (countsByClassId.get(geometry.classIds[nodeId]) ?? 0) + 1)
    pageNumbers.add(geometry.pageIndexes[nodeId] + 1)

    if ((geometry.flags[nodeId] & NODE_FLAG_LOW_CONFIDENCE) !== 0) {
      lowConfidenceCount += 1
    }
    if ((geometry.flags[nodeId] & NODE_FLAG_EDITED) !== 0) {
      editedCount += 1
    }
    lowestConfidence = Math.min(lowestConfidence, geometry.confidences[nodeId])
    highestConfidence = Math.max(highestConfidence, geometry.confidences[nodeId])

    const text = layoutDocument.texts[nodeId]
    if (text) {
      if (combinedTextLength + text.length > MAXIMUM_COMBINED_TEXT_LENGTH) {
        isCombinedTextTruncated = true
      } else {
        textFragments.push(text)
        combinedTextLength += text.length + 1
      }
    }
  }

  return {
    countsByClassName: [...countsByClassId.entries()]
      .map(([classId, count]) => ({ className: getLayoutNodeClassName(classId), count }))
      .sort((left, right) => right.count - left.count),
    lowConfidenceCount,
    editedCount,
    lowestConfidence,
    highestConfidence,
    pageNumbers: [...pageNumbers].sort((left, right) => left - right),
    combinedText: textFragments.join('\n'),
    isCombinedTextTruncated,
  }
}

/**
 * Describes the selection and offers the class picker used to correct a mis-label.
 *
 * A single box gets its own properties; a multi-box selection gets a breakdown by class
 * and confidence instead. Listing the boxes individually would only duplicate the
 * structure tree, which already shows them in place and in order.
 */
export function SelectionInspector() {
  const layoutDocument = useDocumentStore((state) => state.document)
  const primarySelectedNodeId = usePrimarySelectedNodeId()
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds)
  // Re-read after every committed transaction so what is shown stays current.
  const structureVersion = useEditorStore((state) => state.structureVersion)
  const selectedNodeCount = selectedNodeIds.length

  const summary = useMemo(
    () =>
      layoutDocument && selectedNodeCount > 1
        ? summarizeSelection(layoutDocument, selectedNodeIds)
        : null,
    // `structureVersion` marks in-place edits; see InspectorPanel for the same note.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutDocument, selectedNodeIds, selectedNodeCount, structureVersion],
  )

  if (!layoutDocument || primarySelectedNodeId === NO_LAYOUT_NODE_ID) {
    return (
      <div className={styles.panel}>
        <div className={styles.header}>Selection</div>
        <p className={styles.emptyState}>
          Click a box on the canvas to inspect it. Shift-drag to marquee-select, drag the
          handles to resize, and press ⌘Z to undo.
        </p>
      </div>
    )
  }

  const { geometry } = layoutDocument
  const activeClassName = getLayoutNodeClassName(geometry.classIds[primarySelectedNodeId])
  const relabelClassNames = summary
    ? new Set(summary.countsByClassName.map((entry) => entry.className))
    : new Set([activeClassName])

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span>Selection</span>
        <span className={styles.fieldLabel} data-testid="selection-count">
          {selectedNodeCount > 1
            ? `${selectedNodeCount} boxes`
            : layoutDocument.sourceNodeIds[primarySelectedNodeId]}
        </span>
      </div>

      {summary ? (
        <MultiSelectionSummary summary={summary} />
      ) : (
        <SingleBoxProperties layoutDocument={layoutDocument} nodeId={primarySelectedNodeId} />
      )}

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>
          {selectedNodeCount > 1 ? `Re-label ${selectedNodeCount} boxes` : 'Re-label'}
        </h3>
        <div className={styles.classGrid}>
          {LAYOUT_NODE_CLASSES.map((candidateClassName) => {
            const style = NODE_CLASS_STYLES[candidateClassName]
            const isActive = relabelClassNames.has(candidateClassName)
            return (
              <button
                key={candidateClassName}
                type="button"
                className={isActive ? styles.classChipActive : styles.classChip}
                aria-pressed={isActive}
                onClick={() =>
                  layoutEditor.commit(
                    selectedNodeCount > 1 ? `Re-label ${selectedNodeCount} boxes` : 'Re-label box',
                    selectedNodeIds.map((nodeId) => ({
                      kind: 'setNodeClass',
                      nodeId,
                      classId: getLayoutNodeClassId(candidateClassName),
                    })),
                  )
                }
              >
                <span
                  className={styles.classSwatch}
                  style={{
                    background: `rgb(${style.borderColor.slice(0, 3).join(', ')})`,
                  }}
                />
                {candidateClassName}
              </button>
            )
          })}
        </div>
      </div>

      <ExtractedText
        layoutDocument={layoutDocument}
        nodeId={primarySelectedNodeId}
        summary={summary}
      />
    </div>
  )
}

function SingleBoxProperties({
  layoutDocument,
  nodeId,
}: {
  layoutDocument: LayoutDocument
  nodeId: LayoutNodeId
}) {
  const { geometry } = layoutDocument
  const boundsOffset = nodeId * 4
  const confidence = geometry.confidences[nodeId]
  const isLowConfidence = (geometry.flags[nodeId] & NODE_FLAG_LOW_CONFIDENCE) !== 0
  const isEdited = (geometry.flags[nodeId] & NODE_FLAG_EDITED) !== 0

  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>Properties</h3>
      <div className={styles.fieldGrid}>
        <span className={styles.fieldLabel}>class</span>
        <span className={styles.fieldValue}>
          {getLayoutNodeClassName(geometry.classIds[nodeId])}
        </span>

        <span className={styles.fieldLabel}>page</span>
        <span className={styles.fieldValue}>{geometry.pageIndexes[nodeId] + 1}</span>

        <span className={styles.fieldLabel}>confidence</span>
        <span className={isLowConfidence ? styles.lowConfidence : styles.fieldValue}>
          {(confidence * 100).toFixed(1)}%
        </span>

        <span className={styles.fieldLabel}>x, y</span>
        <span className={styles.fieldValue} data-testid="selection-position">
          {geometry.bounds[boundsOffset].toFixed(1)}, {geometry.bounds[boundsOffset + 1].toFixed(1)}
        </span>

        <span className={styles.fieldLabel}>w × h</span>
        <span className={styles.fieldValue} data-testid="selection-size">
          {geometry.bounds[boundsOffset + 2].toFixed(1)} ×{' '}
          {geometry.bounds[boundsOffset + 3].toFixed(1)}
        </span>

        <span className={styles.fieldLabel}>edited</span>
        <span className={styles.fieldValue}>{isEdited ? 'yes' : 'no'}</span>
      </div>
    </div>
  )
}

function MultiSelectionSummary({ summary }: { summary: SelectionSummary }) {
  return (
    <div className={styles.section} data-testid="selection-summary">
      <h3 className={styles.sectionTitle}>Breakdown</h3>
      <div className={styles.fieldGrid}>
        {summary.countsByClassName.map((entry) => (
          <span key={entry.className} className={styles.countRow}>
            <span
              className={styles.classSwatch}
              style={{
                background: `rgb(${NODE_CLASS_STYLES[entry.className].borderColor.slice(0, 3).join(', ')})`,
              }}
            />
            <span className={styles.fieldLabel}>{entry.className}</span>
            <span className={styles.countValue}>{entry.count}</span>
          </span>
        ))}
      </div>

      <div className={styles.fieldGrid} style={{ marginTop: 10 }}>
        <span className={styles.fieldLabel}>pages</span>
        <span className={styles.fieldValue}>
          {summary.pageNumbers.length > 4
            ? `${summary.pageNumbers[0]}–${summary.pageNumbers[summary.pageNumbers.length - 1]}`
            : summary.pageNumbers.join(', ')}
        </span>

        <span className={styles.fieldLabel}>confidence</span>
        <span className={styles.fieldValue}>
          {(summary.lowestConfidence * 100).toFixed(1)}% – {(summary.highestConfidence * 100).toFixed(1)}%
        </span>

        <span className={styles.fieldLabel}>
          below {Math.round(LOW_CONFIDENCE_THRESHOLD * 100)}%
        </span>
        <span className={summary.lowConfidenceCount > 0 ? styles.lowConfidence : styles.fieldValue}>
          {summary.lowConfidenceCount}
        </span>

        <span className={styles.fieldLabel}>edited</span>
        <span className={styles.fieldValue}>{summary.editedCount}</span>
      </div>
    </div>
  )
}

function ExtractedText({
  layoutDocument,
  nodeId,
  summary,
}: {
  layoutDocument: LayoutDocument
  nodeId: LayoutNodeId
  summary: SelectionSummary | null
}) {
  const text = summary ? summary.combinedText : layoutDocument.texts[nodeId]
  if (!text) {
    return null
  }

  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>
        {summary ? 'Extracted text · whole selection' : 'Extracted text'}
      </h3>
      <p className={styles.text} data-testid="extracted-text">
        {text}
        {summary?.isCombinedTextTruncated ? '\n…' : ''}
      </p>
    </div>
  )
}

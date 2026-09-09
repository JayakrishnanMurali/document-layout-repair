import { NODE_CLASS_STYLES } from '@/canvas/overlay/nodeClassStyles'
import {
  LAYOUT_NODE_CLASSES,
  NODE_FLAG_EDITED,
  NODE_FLAG_LOW_CONFIDENCE,
  NO_LAYOUT_NODE_ID,
  getLayoutNodeClassId,
  getLayoutNodeClassName,
} from '@/document/layoutTypes'
import { useDocumentStore } from '@/state/documentStore'
import { layoutEditor, useEditorStore, usePrimarySelectedNodeId } from '@/state/editorStore'
import styles from './SelectionInspector.module.css'

/**
 * Details of the primary selection, and the class picker used to correct a mis-labelled
 * box. Re-labelling goes through the same transaction stack as a drag, so it undoes with
 * the same keystroke.
 */
export function SelectionInspector() {
  const layoutDocument = useDocumentStore((state) => state.document)
  const selectedNodeId = usePrimarySelectedNodeId()
  const selectedNodeCount = useEditorStore((state) => state.selectedNodeIds.length)
  // Re-read after every committed transaction so the geometry shown stays current.
  useEditorStore((state) => state.undoDepth)

  if (!layoutDocument || selectedNodeId === NO_LAYOUT_NODE_ID) {
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
  const className = getLayoutNodeClassName(geometry.classIds[selectedNodeId])
  const boundsOffset = selectedNodeId * 4
  const confidence = geometry.confidences[selectedNodeId]
  const isLowConfidence = (geometry.flags[selectedNodeId] & NODE_FLAG_LOW_CONFIDENCE) !== 0
  const isEdited = (geometry.flags[selectedNodeId] & NODE_FLAG_EDITED) !== 0
  const text = layoutDocument.texts[selectedNodeId]

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span>Selection</span>
        <span className={styles.fieldLabel}>
          {selectedNodeCount > 1 ? `${selectedNodeCount} boxes` : layoutDocument.sourceNodeIds[selectedNodeId]}
        </span>
      </div>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Properties</h3>
        <div className={styles.fieldGrid}>
          <span className={styles.fieldLabel}>class</span>
          <span className={styles.fieldValue}>{className}</span>

          <span className={styles.fieldLabel}>page</span>
          <span className={styles.fieldValue}>{geometry.pageIndexes[selectedNodeId] + 1}</span>

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

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Re-label</h3>
        <div className={styles.classGrid}>
          {LAYOUT_NODE_CLASSES.map((candidateClassName) => {
            const style = NODE_CLASS_STYLES[candidateClassName]
            const isActive = candidateClassName === className
            return (
              <button
                key={candidateClassName}
                type="button"
                className={isActive ? styles.classChipActive : styles.classChip}
                aria-pressed={isActive}
                onClick={() =>
                  layoutEditor.commit('Re-label box', [
                    {
                      kind: 'setNodeClass',
                      nodeId: selectedNodeId,
                      classId: getLayoutNodeClassId(candidateClassName),
                    },
                  ])
                }
              >
                <span
                  className={styles.classSwatch}
                  style={{
                    background: `rgb(${style.borderColor[0]}, ${style.borderColor[1]}, ${style.borderColor[2]})`,
                  }}
                />
                {candidateClassName}
              </button>
            )
          })}
        </div>
      </div>

      {text && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Extracted text</h3>
          <p className={styles.text}>{text}</p>
        </div>
      )}
    </div>
  )
}

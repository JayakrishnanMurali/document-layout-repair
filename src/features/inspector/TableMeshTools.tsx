import { findCellByNodeId, getMeshColumnCount, getMeshRowCount } from '@/document/tableMesh'
import { useDocumentStore } from '@/state/documentStore'
import { layoutEditor, useEditorStore } from '@/state/editorStore'
import {
  collectSelectedCellNodeIds,
  mergeTableCells,
  splitTableCell,
  unmergeTableCell,
} from '@/state/tableMeshCommands'
import { useWorkspaceStore } from '@/state/workspaceStore'
import styles from './TableMeshTools.module.css'

/**
 * Split, merge and unmerge for the selected table cells.
 *
 * Divider dragging happens on the canvas; these are the operations that need a target,
 * and they reuse the ordinary selection — shift-drag a marquee across two cells and merge
 * them — rather than inventing a second selection model for tables.
 */
export function TableMeshTools() {
  const activeToolId = useWorkspaceStore((state) => state.activeToolId)
  const layoutDocument = useDocumentStore((state) => state.document)
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds)
  // Re-read after every committed transaction so spans and counts stay current.
  useEditorStore((state) => state.structureVersion)

  if (activeToolId !== 'tableMesh' || !layoutDocument) {
    return null
  }

  const selection = collectSelectedCellNodeIds(layoutDocument, selectedNodeIds)
  if (!selection) {
    return (
      <div className={styles.panel} data-testid="table-mesh-tools">
        <h3 className={styles.title}>Table mesh</h3>
        <p className={styles.hint}>
          Drag a row or column divider on the canvas to reshape a table. Select a cell to
          split it, or shift-drag across several cells to merge them.
        </p>
      </div>
    )
  }

  const { mesh, cellNodeIds } = selection
  const singleCell = cellNodeIds.length === 1 ? findCellByNodeId(mesh, cellNodeIds[0]) : undefined
  const isMerged = singleCell !== undefined && (singleCell.rowSpan > 1 || singleCell.columnSpan > 1)

  return (
    <div className={styles.panel} data-testid="table-mesh-tools">
      <h3 className={styles.title}>Table mesh</h3>
      <p className={styles.address} data-testid="table-mesh-address">
        {getMeshRowCount(mesh)} × {getMeshColumnCount(mesh)} grid ·{' '}
        {singleCell
          ? `row ${singleCell.rowIndex + 1}, column ${singleCell.columnIndex + 1} · spans ${singleCell.rowSpan}×${singleCell.columnSpan}`
          : `${cellNodeIds.length} cells selected`}
      </p>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.action}
          disabled={!singleCell}
          onClick={() => singleCell && splitTableCell(layoutEditor, singleCell.nodeId, 'column')}
        >
          Split columns
        </button>
        <button
          type="button"
          className={styles.action}
          disabled={!singleCell}
          onClick={() => singleCell && splitTableCell(layoutEditor, singleCell.nodeId, 'row')}
        >
          Split rows
        </button>
        <button
          type="button"
          className={styles.action}
          disabled={cellNodeIds.length < 2}
          onClick={() => mergeTableCells(layoutEditor, cellNodeIds)}
        >
          Merge cells
        </button>
        <button
          type="button"
          className={styles.action}
          disabled={!isMerged}
          onClick={() => singleCell && unmergeTableCell(layoutEditor, singleCell.nodeId)}
        >
          Unmerge
        </button>
      </div>
    </div>
  )
}

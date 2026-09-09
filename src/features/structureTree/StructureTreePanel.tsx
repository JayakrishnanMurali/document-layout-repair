import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { NODE_CLASS_STYLES } from '@/canvas/overlay/nodeClassStyles'
import {
  NODE_FLAG_LOW_CONFIDENCE,
  NO_LAYOUT_NODE_ID,
  getPageNodeCount,
  readNodeBounds,
  type LayoutNodeId,
} from '@/document/layoutTypes'
import { useDocumentStore } from '@/state/documentStore'
import { layoutEditor, useEditorStore, usePrimarySelectedNodeId } from '@/state/editorStore'
import { focusWorldRect } from '@/state/viewportCommands'
import {
  collectAncestorRowKeys,
  flattenStructureTree,
  getNodeRowKey,
  getPageRowKey,
  type StructureTreeRow,
  type StructureTreeRowKey,
} from './structureTreeModel'
import styles from './StructureTreePanel.module.css'

const ROW_HEIGHT_IN_PIXELS = 22
const OVERSCAN_ROW_COUNT = 8
const INDENT_PER_DEPTH_IN_PIXELS = 13

/**
 * The hierarchical view of the extraction, kept in sync with the canvas in both
 * directions.
 *
 * Only the rows inside the scroll window are mounted: an expanded page contributes a few
 * hundred rows and the document as a whole eleven thousand, which is far more than the
 * DOM should ever hold at once.
 */
export function StructureTreePanel() {
  const layoutDocument = useDocumentStore((state) => state.document)
  const structureVersion = useEditorStore((state) => state.structureVersion)
  const primarySelectedNodeId = usePrimarySelectedNodeId()
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds)
  const hoveredNodeId = useEditorStore((state) => state.hoveredNodeId)

  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const [treeState, setTreeState] = useState(() => ({
    layoutDocument,
    revealedNodeId: NO_LAYOUT_NODE_ID as LayoutNodeId,
    expandedRowKeys: new Set<StructureTreeRowKey>([getPageRowKey(0)]),
  }))
  const [scrollTop, setScrollTop] = useState(0)
  const [containerHeight, setContainerHeight] = useState(0)

  // Adjusting state during render is the sanctioned way to react to a changed input
  // without an extra effect and an extra render pass.
  if (treeState.layoutDocument !== layoutDocument) {
    setTreeState({
      layoutDocument,
      revealedNodeId: NO_LAYOUT_NODE_ID,
      expandedRowKeys: new Set([getPageRowKey(0)]),
    })
  } else if (treeState.revealedNodeId !== primarySelectedNodeId) {
    /**
     * Canvas → tree, part one: a newly selected node has its ancestors expanded once, so
     * a click on the canvas always reveals a row instead of hiding inside a collapsed
     * branch. Expanding once rather than deriving it every render is what lets the
     * reviewer collapse that branch again afterwards.
     */
    const ancestorRowKeys = layoutDocument
      ? collectAncestorRowKeys(layoutDocument, primarySelectedNodeId)
      : []
    setTreeState({
      ...treeState,
      revealedNodeId: primarySelectedNodeId,
      expandedRowKeys: ancestorRowKeys.every((rowKey) => treeState.expandedRowKeys.has(rowKey))
        ? treeState.expandedRowKeys
        : new Set([...treeState.expandedRowKeys, ...ancestorRowKeys]),
    })
  }

  const expandedRowKeys = treeState.expandedRowKeys

  const rows = useMemo(
    () => flattenStructureTree(layoutDocument, expandedRowKeys),
    // `structureVersion` is not read below, but a committed transaction can re-order
    // reading order or hide a node in place while the document object stays identical —
    // the version is what tells us the flattened rows are stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutDocument, expandedRowKeys, structureVersion],
  )

  const rowIndexByKey = useMemo(() => {
    const indexes = new Map<StructureTreeRowKey, number>()
    rows.forEach((row, rowIndex) => indexes.set(row.key, rowIndex))
    return indexes
  }, [rows])

  // Mirrored into a ref so the scroll effect below can read the current indexes without
  // taking them as a dependency. Declared first, so it has already run by the time that
  // effect fires in the same commit.
  const rowIndexByKeyRef = useRef(rowIndexByKey)
  useLayoutEffect(() => {
    rowIndexByKeyRef.current = rowIndexByKey
  }, [rowIndexByKey])

  const selectedNodeIdSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds])

  /**
   * Attached as a callback ref rather than from an effect: the container only exists once
   * a document has loaded, and a one-shot mount effect would have measured nothing and
   * never run again — leaving the virtualizer with a zero-height window.
   */
  const attachScrollContainer = useCallback((container: HTMLDivElement | null) => {
    resizeObserverRef.current?.disconnect()
    scrollContainerRef.current = container

    if (!container) {
      resizeObserverRef.current = null
      return
    }

    // ResizeObserver reports the current size as soon as it observes, so the initial
    // height arrives through the same path as later ones.
    const resizeObserver = new ResizeObserver((entries) => {
      setContainerHeight(entries[0]?.contentRect.height ?? container.clientHeight)
    })
    resizeObserver.observe(container)
    resizeObserverRef.current = resizeObserver
  }, [])

  /**
   * Canvas → tree, part two: scroll the revealed row into view.
   *
   * Keyed on the selection alone. Depending on the row indexes instead would re-scroll
   * on every expand and collapse, yanking the reviewer back to a selection they had
   * deliberately scrolled away from.
   */
  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    if (!container || containerHeight === 0 || primarySelectedNodeId === NO_LAYOUT_NODE_ID) {
      return
    }

    const rowIndex = rowIndexByKeyRef.current.get(getNodeRowKey(primarySelectedNodeId))
    if (rowIndex === undefined) {
      return
    }

    const rowTop = rowIndex * ROW_HEIGHT_IN_PIXELS
    const isAboveWindow = rowTop < container.scrollTop
    const isBelowWindow = rowTop + ROW_HEIGHT_IN_PIXELS > container.scrollTop + containerHeight
    if (!isAboveWindow && !isBelowWindow) {
      return
    }

    container.scrollTo({
      top: Math.max(0, rowTop - containerHeight / 2 + ROW_HEIGHT_IN_PIXELS / 2),
      behavior: 'smooth',
    })
  }, [primarySelectedNodeId, containerHeight])

  const toggleRow = useCallback((rowKey: StructureTreeRowKey) => {
    setTreeState((previous) => {
      const nextExpandedRowKeys = new Set(previous.expandedRowKeys)
      if (nextExpandedRowKeys.has(rowKey)) {
        nextExpandedRowKeys.delete(rowKey)
      } else {
        nextExpandedRowKeys.add(rowKey)
      }
      return { ...previous, expandedRowKeys: nextExpandedRowKeys }
    })
  }, [])

  // Tree → canvas: focus the camera on a node without changing its zoom wildly.
  const focusNode = useCallback(
    (nodeId: LayoutNodeId) => {
      if (!layoutDocument) {
        return
      }
      focusWorldRect(
        readNodeBounds(layoutDocument.geometry, nodeId, { x: 0, y: 0, width: 0, height: 0 }),
      )
    },
    [layoutDocument],
  )

  if (!layoutDocument) {
    return (
      <div className={styles.panel}>
        <div className={styles.header}>Structure</div>
        <p className={styles.emptyState}>Extracting…</p>
      </div>
    )
  }

  const firstVisibleRowIndex = Math.max(
    0,
    Math.floor(scrollTop / ROW_HEIGHT_IN_PIXELS) - OVERSCAN_ROW_COUNT,
  )
  const lastVisibleRowIndex = Math.min(
    rows.length,
    Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT_IN_PIXELS) + OVERSCAN_ROW_COUNT,
  )
  const visibleRows = rows.slice(firstVisibleRowIndex, lastVisibleRowIndex)

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span>Structure</span>
        <span className={styles.headerHint} data-testid="tree-row-count">
          {rows.length} rows · double-click to focus
        </span>
      </div>

      <div
        className={styles.scrollContainer}
        ref={attachScrollContainer}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onMouseLeave={() => layoutEditor.setHoveredNodeId(NO_LAYOUT_NODE_ID)}
        role="tree"
        aria-label="Document structure"
      >
        <div
          className={styles.rowSpacer}
          style={{ height: rows.length * ROW_HEIGHT_IN_PIXELS }}
          data-testid="tree-rows"
        >
          <div
            className={styles.rowWindow}
            style={{ transform: `translateY(${firstVisibleRowIndex * ROW_HEIGHT_IN_PIXELS}px)` }}
          >
            {visibleRows.map((row) => (
              <StructureTreeRowButton
                key={row.key}
                row={row}
                isSelected={row.nodeId !== null && selectedNodeIdSet.has(row.nodeId)}
                isHovered={row.nodeId !== null && row.nodeId === hoveredNodeId}
                isLowConfidence={
                  row.nodeId !== null &&
                  (layoutDocument.geometry.flags[row.nodeId] & NODE_FLAG_LOW_CONFIDENCE) !== 0
                }
                nodeCountOnPage={
                  row.kind === 'page'
                    ? getPageNodeCount(layoutDocument, row.pageIndex)
                    : 0
                }
                onToggle={toggleRow}
                onFocus={focusNode}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

type StructureTreeRowButtonProps = {
  row: StructureTreeRow
  isSelected: boolean
  isHovered: boolean
  isLowConfidence: boolean
  nodeCountOnPage: number
  onToggle: (rowKey: StructureTreeRowKey) => void
  onFocus: (nodeId: LayoutNodeId) => void
}

function StructureTreeRowButton({
  row,
  isSelected,
  isHovered,
  isLowConfidence,
  nodeCountOnPage,
  onToggle,
  onFocus,
}: StructureTreeRowButtonProps) {
  const className = isSelected ? styles.rowSelected : isHovered ? styles.rowHovered : styles.row

  return (
    <button
      type="button"
      className={className}
      style={{ paddingLeft: 8 + row.depth * INDENT_PER_DEPTH_IN_PIXELS }}
      role="treeitem"
      aria-expanded={row.hasChildren ? row.isExpanded : undefined}
      aria-selected={isSelected}
      onClick={() => {
        if (row.kind === 'page') {
          onToggle(row.key)
          return
        }
        layoutEditor.selectNode(row.nodeId, 'replace')
      }}
      onDoubleClick={() => {
        if (row.kind === 'node') {
          onFocus(row.nodeId)
        }
      }}
      onMouseEnter={() => {
        if (row.kind === 'node') {
          layoutEditor.setHoveredNodeId(row.nodeId)
        }
      }}
    >
      <span
        className={styles.disclosure}
        onClick={(event) => {
          if (!row.hasChildren) {
            return
          }
          event.stopPropagation()
          onToggle(row.key)
        }}
      >
        {row.hasChildren ? (row.isExpanded ? '▼' : '▶') : ''}
      </span>

      {row.kind === 'page' ? (
        <>
          <span className={styles.pageLabel}>{row.label}</span>
          <span className={styles.rowText} />
          <span className={styles.pageMeta}>{nodeCountOnPage} boxes</span>
        </>
      ) : (
        <>
          <span
            className={styles.classSwatch}
            style={{
              background: `rgb(${NODE_CLASS_STYLES[row.className].borderColor.slice(0, 3).join(', ')})`,
            }}
          />
          <span className={styles.rowLabel}>{row.label}</span>
          <span className={styles.rowText}>{row.text ?? ''}</span>
          {isLowConfidence && <span className={styles.lowConfidenceDot} />}
        </>
      )}
    </button>
  )
}

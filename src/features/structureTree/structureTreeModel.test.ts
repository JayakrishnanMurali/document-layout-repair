import { describe, expect, it } from 'vitest'
import { LayoutDocumentBuilder } from '@/document/extraction/LayoutDocumentBuilder'
import { buildPageExtractionPayload } from '@/document/extraction/payloadBuilder'
import { NODE_FLAG_REMOVED, type LayoutDocument } from '@/document/layoutTypes'
import { generateSyntheticPageContent } from '@/document/synthetic/pageContentGenerator'
import {
  collectAncestorRowKeys,
  flattenStructureTree,
  getNodeRowKey,
  getPageRowKey,
} from './structureTreeModel'

const PAGE_COUNT = 4
const DOCUMENT_SEED = 0x1357

function buildDocument(): LayoutDocument {
  const builder = new LayoutDocumentBuilder(PAGE_COUNT)
  for (let pageIndex = 0; pageIndex < PAGE_COUNT; pageIndex += 1) {
    builder.ingestPage(
      buildPageExtractionPayload(
        generateSyntheticPageContent(pageIndex, DOCUMENT_SEED),
        DOCUMENT_SEED,
      ),
    )
  }
  return builder.getDocument()
}

const layoutDocument = buildDocument()

describe('flattenStructureTree', () => {
  it('shows one row per page when everything is collapsed', () => {
    const rows = flattenStructureTree(layoutDocument, new Set())

    expect(rows).toHaveLength(PAGE_COUNT)
    expect(rows.every((row) => row.kind === 'page')).toBe(true)
    expect(rows[0].label).toBe('Page 1')
  })

  it('returns nothing without a document', () => {
    expect(flattenStructureTree(null, new Set())).toEqual([])
  })

  it('adds a page’s root blocks when the page is expanded', () => {
    const rows = flattenStructureTree(layoutDocument, new Set([getPageRowKey(1)]))
    const rootNodeIds = layoutDocument.readingOrderByPage[1].nodeIds

    expect(rows).toHaveLength(PAGE_COUNT + rootNodeIds.length)
    const expandedPageRowIndex = rows.findIndex((row) => row.key === getPageRowKey(1))
    expect(rows[expandedPageRowIndex + 1].nodeId).toBe(rootNodeIds[0])
    expect(rows[expandedPageRowIndex + 1].depth).toBe(1)
  })

  it('follows reading order, so re-sequencing a page re-orders the tree', () => {
    const originalOrder = [...layoutDocument.readingOrderByPage[0].nodeIds]
    const reversedOrder = [...originalOrder].reverse()
    layoutDocument.readingOrderByPage[0].nodeIds = reversedOrder

    const rows = flattenStructureTree(layoutDocument, new Set([getPageRowKey(0)]))
    const nodeRowIds = rows.filter((row) => row.kind === 'node').map((row) => row.nodeId)
    expect(nodeRowIds).toEqual(reversedOrder)

    layoutDocument.readingOrderByPage[0].nodeIds = originalOrder
  })

  it('nests children under an expanded block', () => {
    const parentNodeId = layoutDocument.readingOrderByPage[0].nodeIds.find(
      (nodeId) => (layoutDocument.childIdsByNodeId[nodeId] ?? []).length > 0,
    )
    expect(parentNodeId).toBeDefined()

    const rows = flattenStructureTree(
      layoutDocument,
      new Set([getPageRowKey(0), getNodeRowKey(parentNodeId!)]),
    )
    const parentRowIndex = rows.findIndex((row) => row.key === getNodeRowKey(parentNodeId!))

    expect(rows[parentRowIndex].hasChildren).toBe(true)
    expect(rows[parentRowIndex].isExpanded).toBe(true)
    expect(rows[parentRowIndex + 1].depth).toBe(2)
    expect(layoutDocument.childIdsByNodeId[parentNodeId!]).toContain(rows[parentRowIndex + 1].nodeId)
  })

  it('omits nodes that have been removed by a merge', () => {
    const parentNodeId = layoutDocument.readingOrderByPage[2].nodeIds.find(
      (nodeId) => (layoutDocument.childIdsByNodeId[nodeId] ?? []).length > 1,
    )
    expect(parentNodeId).toBeDefined()
    const removedChildId = layoutDocument.childIdsByNodeId[parentNodeId!][0]

    const expanded = new Set([getPageRowKey(2), getNodeRowKey(parentNodeId!)])
    const rowsBefore = flattenStructureTree(layoutDocument, expanded)

    layoutDocument.geometry.flags[removedChildId] |= NODE_FLAG_REMOVED
    const rowsAfter = flattenStructureTree(layoutDocument, expanded)

    expect(rowsAfter).toHaveLength(rowsBefore.length - 1)
    expect(rowsAfter.some((row) => row.nodeId === removedChildId)).toBe(false)

    layoutDocument.geometry.flags[removedChildId] &= ~NODE_FLAG_REMOVED
  })
})

describe('collectAncestorRowKeys', () => {
  it('returns the page and every ancestor of a leaf', () => {
    const parentNodeId = layoutDocument.readingOrderByPage[1].nodeIds.find(
      (nodeId) => (layoutDocument.childIdsByNodeId[nodeId] ?? []).length > 0,
    )
    const childNodeId = layoutDocument.childIdsByNodeId[parentNodeId!][0]

    expect(collectAncestorRowKeys(layoutDocument, childNodeId)).toEqual([
      getPageRowKey(1),
      getNodeRowKey(parentNodeId!),
    ])
  })

  it('returns just the page for a root block', () => {
    const rootNodeId = layoutDocument.readingOrderByPage[3].nodeIds[0]
    expect(collectAncestorRowKeys(layoutDocument, rootNodeId)).toEqual([getPageRowKey(3)])
  })

  it('returns nothing for an unknown node', () => {
    expect(collectAncestorRowKeys(layoutDocument, -1)).toEqual([])
    expect(collectAncestorRowKeys(layoutDocument, 999_999)).toEqual([])
  })

  it('is exactly what has to be expanded for the node to appear', () => {
    const parentNodeId = layoutDocument.readingOrderByPage[1].nodeIds.find(
      (nodeId) => (layoutDocument.childIdsByNodeId[nodeId] ?? []).length > 0,
    )
    const childNodeId = layoutDocument.childIdsByNodeId[parentNodeId!][0]

    const rows = flattenStructureTree(
      layoutDocument,
      new Set(collectAncestorRowKeys(layoutDocument, childNodeId)),
    )
    expect(rows.some((row) => row.nodeId === childNodeId)).toBe(true)
  })
})

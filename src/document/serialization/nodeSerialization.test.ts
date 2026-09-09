import { describe, expect, it } from 'vitest'
import { LayoutDocumentBuilder } from '@/document/extraction/LayoutDocumentBuilder'
import { buildPageExtractionPayload } from '@/document/extraction/payloadBuilder'
import {
  NODE_FLAG_EDITED,
  NODE_FLAG_REMOVED,
  getLayoutNodeClassId,
  type LayoutDocument,
} from '@/document/layoutTypes'
import {
  PAGE_HEIGHT_IN_WORLD_UNITS,
  PAGE_WIDTH_IN_WORLD_UNITS,
  createDocumentPageLayout,
} from '@/document/pageLayout'
import { generateSyntheticPageContent } from '@/document/synthetic/pageContentGenerator'
import {
  serializeNodeAsMarkdown,
  serializeNodeSubtree,
  serializePage,
  serializePageAsMarkdown,
} from './nodeSerialization'

const PAGE_COUNT = 8
const DOCUMENT_SEED = 0x2468

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
const pageLayout = createDocumentPageLayout(PAGE_COUNT)

function findNodeOnPage(pageIndex: number, className: string): number {
  const classId = getLayoutNodeClassId(className)
  for (const range of layoutDocument.nodeRangesByPage[pageIndex]) {
    const lastNodeId = range.firstNodeId + range.nodeCount
    for (let nodeId = range.firstNodeId; nodeId < lastNodeId; nodeId += 1) {
      if (layoutDocument.geometry.classIds[nodeId] === classId) {
        return nodeId
      }
    }
  }
  return -1
}

describe('serializeNodeSubtree', () => {
  it('reports page-local bounds for every page, not world space', () => {
    for (let pageIndex = 0; pageIndex < PAGE_COUNT; pageIndex += 1) {
      const nodeId = layoutDocument.readingOrderByPage[pageIndex].nodeIds[0]
      const serialized = serializeNodeSubtree(layoutDocument, pageLayout, nodeId)

      expect(serialized).not.toBeNull()
      expect(serialized!.page).toBe(pageIndex + 1)
      expect(serialized!.bounds.x).toBeGreaterThanOrEqual(0)
      expect(serialized!.bounds.y).toBeGreaterThanOrEqual(0)
      expect(serialized!.bounds.x).toBeLessThanOrEqual(PAGE_WIDTH_IN_WORLD_UNITS)
      expect(serialized!.bounds.y).toBeLessThanOrEqual(PAGE_HEIGHT_IN_WORLD_UNITS)
    }
  })

  it('nests children and preserves their order', () => {
    const parentNodeId = layoutDocument.readingOrderByPage[0].nodeIds.find(
      (nodeId) => (layoutDocument.childIdsByNodeId[nodeId] ?? []).length > 1,
    )
    const serialized = serializeNodeSubtree(layoutDocument, pageLayout, parentNodeId!)

    expect(serialized!.children).toBeDefined()
    expect(serialized!.children!.map((child) => child.id)).toEqual(
      layoutDocument.childIdsByNodeId[parentNodeId!].map(
        (childId) => layoutDocument.sourceNodeIds[childId],
      ),
    )
  })

  it('reports the cell address of a table cell', () => {
    const tableNodeId = findNodeOnPage(0, 'table')
    expect(tableNodeId).toBeGreaterThanOrEqual(0)

    const serialized = serializeNodeSubtree(layoutDocument, pageLayout, tableNodeId)
    const firstCell = serialized!.children![0]

    expect(firstCell.class).toBe('tableCell')
    expect(firstCell.cell).toEqual({ row: 0, column: 0, rowSpan: 1, columnSpan: 1 })
  })

  it('flags a box the reviewer has edited', () => {
    const nodeId = layoutDocument.readingOrderByPage[1].nodeIds[0]
    expect(serializeNodeSubtree(layoutDocument, pageLayout, nodeId)!.edited).toBeUndefined()

    layoutDocument.geometry.flags[nodeId] |= NODE_FLAG_EDITED
    expect(serializeNodeSubtree(layoutDocument, pageLayout, nodeId)!.edited).toBe(true)
    layoutDocument.geometry.flags[nodeId] &= ~NODE_FLAG_EDITED
  })

  it('omits removed nodes entirely', () => {
    const nodeId = layoutDocument.readingOrderByPage[2].nodeIds[0]
    layoutDocument.geometry.flags[nodeId] |= NODE_FLAG_REMOVED

    expect(serializeNodeSubtree(layoutDocument, pageLayout, nodeId)).toBeNull()
    layoutDocument.geometry.flags[nodeId] &= ~NODE_FLAG_REMOVED
  })

  it('returns null for an out-of-range node', () => {
    expect(serializeNodeSubtree(layoutDocument, pageLayout, -1)).toBeNull()
    expect(serializeNodeSubtree(layoutDocument, pageLayout, 10_000_000)).toBeNull()
  })
})

describe('serializePage', () => {
  it('emits the page in reading order', () => {
    const serialized = serializePage(layoutDocument, pageLayout, 3)

    expect(serialized.page).toBe(4)
    expect(serialized.readingOrder.map((node) => node.id)).toEqual(
      layoutDocument.readingOrderByPage[3].nodeIds.map(
        (nodeId) => layoutDocument.sourceNodeIds[nodeId],
      ),
    )
  })
})

describe('Markdown serialization', () => {
  it('renders a title as a level-one heading', () => {
    const titleNodeId = findNodeOnPage(0, 'title')
    expect(serializeNodeAsMarkdown(layoutDocument, titleNodeId)).toMatch(/^# .+/)
  })

  it('renders a table with a header separator row', () => {
    const tableNodeId = findNodeOnPage(0, 'table')
    const markdown = serializeNodeAsMarkdown(layoutDocument, tableNodeId)
    const lines = markdown.split('\n')

    const mesh = layoutDocument.tableMeshesByPage[0].find(
      (candidate) => candidate.tableNodeId === tableNodeId,
    )
    expect(mesh).toBeDefined()
    expect(lines).toHaveLength(mesh!.rowEdges.length - 1 + mesh!.headerRowCount)
    expect(lines[mesh!.headerRowCount]).toMatch(/^\| ---/)
    expect(lines[0].split('|')).toHaveLength(mesh!.columnEdges.length + 1)
  })

  it('renders a key-value pair as a bolded list item', () => {
    let keyValueNodeId = -1
    for (let pageIndex = 0; pageIndex < PAGE_COUNT && keyValueNodeId < 0; pageIndex += 1) {
      keyValueNodeId = findNodeOnPage(pageIndex, 'keyValuePair')
    }
    expect(keyValueNodeId).toBeGreaterThanOrEqual(0)

    expect(serializeNodeAsMarkdown(layoutDocument, keyValueNodeId)).toMatch(/^- \*\*.+\*\*: /)
  })

  it('renders a whole page as blocks separated by blank lines', () => {
    const markdown = serializePageAsMarkdown(layoutDocument, 0)

    expect(markdown).toContain('# ')
    expect(markdown).toContain('\n\n')
    expect(markdown.split('\n\n').length).toBeGreaterThan(3)
  })

  it('escapes pipes so cell text cannot break the table', () => {
    const tableNodeId = findNodeOnPage(0, 'table')
    const mesh = layoutDocument.tableMeshesByPage[0].find(
      (candidate) => candidate.tableNodeId === tableNodeId,
    )
    const cellNodeId = mesh!.cells[1].nodeId
    const originalText = layoutDocument.texts[cellNodeId]
    layoutDocument.texts[cellNodeId] = 'a | b'

    const firstRow = serializeNodeAsMarkdown(layoutDocument, tableNodeId).split('\n')[0]
    expect(firstRow).toContain('a \\| b')
    // Only unescaped pipes are cell separators, which is the whole point of escaping.
    expect(firstRow.split(/(?<!\\)\|/)).toHaveLength(mesh!.columnEdges.length + 1)

    layoutDocument.texts[cellNodeId] = originalText
  })
})

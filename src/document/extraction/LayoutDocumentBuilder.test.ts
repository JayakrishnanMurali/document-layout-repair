import { describe, expect, it } from 'vitest'
import { createDocumentPageLayout, getPageBounds } from '@/document/pageLayout'
import {
  BLOCK_LEVEL_CLASSES,
  getLayoutNodeClassName,
  getPageNodeCount,
  getTableCellBounds,
  type LayoutDocument,
} from '@/document/layoutTypes'
import { generateSyntheticPageContent } from '@/document/synthetic/pageContentGenerator'
import { LayoutDocumentBuilder } from './LayoutDocumentBuilder'
import { buildPageExtractionPayload } from './payloadBuilder'

const STRESS_TEST_PAGE_COUNT = 100
const STRESS_TEST_DOCUMENT_SEED = 0x5eed01

function buildDocument(pageCount: number, documentSeed: number): LayoutDocument {
  const builder = new LayoutDocumentBuilder(pageCount)
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    builder.ingestPage(
      buildPageExtractionPayload(
        generateSyntheticPageContent(pageIndex, documentSeed),
        documentSeed,
      ),
    )
  }
  return builder.getDocument()
}

describe('stress test document', () => {
  const document = buildDocument(STRESS_TEST_PAGE_COUNT, STRESS_TEST_DOCUMENT_SEED)
  const stressPageLayout = createDocumentPageLayout(STRESS_TEST_PAGE_COUNT)

  it('reaches the 10,000 bounding box benchmark across 100 pages', () => {
    expect(document.pageCount).toBe(STRESS_TEST_PAGE_COUNT)
    expect(document.geometry.nodeCount).toBeGreaterThanOrEqual(10_000)
  })

  it('keeps every box inside the page that owns it', () => {
    const { geometry } = document

    for (let nodeId = 0; nodeId < geometry.nodeCount; nodeId += 1) {
      const pageBounds = getPageBounds(stressPageLayout, geometry.pageIndexes[nodeId])
      const offset = nodeId * 4
      const x = geometry.bounds[offset]
      const y = geometry.bounds[offset + 1]

      expect(x).toBeGreaterThanOrEqual(pageBounds.x - 0.5)
      expect(y).toBeGreaterThanOrEqual(pageBounds.y - 0.5)
      expect(x + geometry.bounds[offset + 2]).toBeLessThanOrEqual(
        pageBounds.x + pageBounds.width + 0.5,
      )
      expect(y + geometry.bounds[offset + 3]).toBeLessThanOrEqual(
        pageBounds.y + pageBounds.height + 0.5,
      )
    }
  })

  it('gives every page a contiguous, non-overlapping node range', () => {
    let expectedFirstNodeId = 0
    for (const ranges of document.nodeRangesByPage) {
      expect(ranges).toHaveLength(1)
      for (const range of ranges) {
        expect(range.firstNodeId).toBe(expectedFirstNodeId)
        expect(range.nodeCount).toBeGreaterThan(0)
        expectedFirstNodeId += range.nodeCount
      }
    }
    expect(expectedFirstNodeId).toBe(document.geometry.nodeCount)
  })

  it('links children to parents in both directions', () => {
    const { geometry } = document

    for (let nodeId = 0; nodeId < geometry.nodeCount; nodeId += 1) {
      const parentId = geometry.parentIds[nodeId]
      if (parentId < 0) {
        continue
      }
      expect(document.childIdsByNodeId[parentId]).toContain(nodeId)
      expect(geometry.pageIndexes[parentId]).toBe(geometry.pageIndexes[nodeId])
    }

    for (let parentId = 0; parentId < geometry.nodeCount; parentId += 1) {
      for (const childId of document.childIdsByNodeId[parentId]) {
        expect(geometry.parentIds[childId]).toBe(parentId)
      }
    }
  })

  it('sequences every block-level root exactly once in reading order', () => {
    for (let pageIndex = 0; pageIndex < document.pageCount; pageIndex += 1) {
      const rootNodeIds = document.rootNodeIdsByPage[pageIndex]
      const readingOrder = document.readingOrderByPage[pageIndex].nodeIds

      expect(new Set(readingOrder).size).toBe(readingOrder.length)
      expect([...readingOrder].sort((left, right) => left - right)).toEqual(
        [...rootNodeIds].sort((left, right) => left - right),
      )

      for (const nodeId of readingOrder) {
        const className = getLayoutNodeClassName(document.geometry.classIds[nodeId])
        expect(BLOCK_LEVEL_CLASSES.has(className)).toBe(true)
      }
    }
  })

  it('derives table cells that tile their mesh exactly', () => {
    const { geometry } = document
    let inspectedTableCount = 0

    for (const meshes of document.tableMeshesByPage) {
      for (const mesh of meshes) {
        inspectedTableCount += 1
        const rowCount = mesh.rowEdges.length - 1
        const columnCount = mesh.columnEdges.length - 1
        expect(mesh.cells.length).toBe(rowCount * columnCount)

        for (const cell of mesh.cells) {
          const meshBounds = getTableCellBounds(mesh, cell)
          const offset = cell.nodeId * 4
          expect(geometry.bounds[offset]).toBeCloseTo(meshBounds.x, 1)
          expect(geometry.bounds[offset + 1]).toBeCloseTo(meshBounds.y, 1)
          expect(geometry.bounds[offset + 2]).toBeCloseTo(meshBounds.width, 1)
          expect(geometry.bounds[offset + 3]).toBeCloseTo(meshBounds.height, 1)
        }
      }
    }

    expect(inspectedTableCount).toBeGreaterThan(10)
  })

  it('marks low-confidence boxes and keeps confidences in range', () => {
    const { geometry } = document
    let lowConfidenceCount = 0

    for (let nodeId = 0; nodeId < geometry.nodeCount; nodeId += 1) {
      expect(geometry.confidences[nodeId]).toBeGreaterThan(0)
      expect(geometry.confidences[nodeId]).toBeLessThanOrEqual(1)
      if ((geometry.flags[nodeId] & 0b100) !== 0) {
        lowConfidenceCount += 1
      }
    }

    expect(lowConfidenceCount).toBeGreaterThan(100)
    expect(lowConfidenceCount / geometry.nodeCount).toBeLessThan(0.2)
  })
})

describe('page ingestion', () => {
  it('is idempotent so a duplicated stream event cannot double-insert a page', () => {
    const builder = new LayoutDocumentBuilder(3)
    const payload = buildPageExtractionPayload(generateSyntheticPageContent(1, 42), 42)

    const first = builder.ingestPage(payload)
    const second = builder.ingestPage(payload)

    expect(second).toEqual(first)
    expect(builder.nodeCount).toBe(first.nodeCount)
    expect(builder.ingestedPageCount).toBe(1)
  })

  it('accepts pages out of order and keeps each page addressable', () => {
    const builder = new LayoutDocumentBuilder(4)
    for (const pageIndex of [3, 0, 2, 1]) {
      builder.ingestPage(
        buildPageExtractionPayload(generateSyntheticPageContent(pageIndex, 7), 7),
      )
    }

    const document = builder.getDocument()
    expect(builder.ingestedPageCount).toBe(4)

    for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
      expect(getPageNodeCount(document, pageIndex)).toBeGreaterThan(0)
      for (const range of document.nodeRangesByPage[pageIndex]) {
        const lastNodeId = range.firstNodeId + range.nodeCount
        for (let nodeId = range.firstNodeId; nodeId < lastNodeId; nodeId += 1) {
          expect(document.geometry.pageIndexes[nodeId]).toBe(pageIndex)
        }
      }
    }
  })
})

import { describe, expect, it } from 'vitest'
import { LayoutDocumentBuilder } from './LayoutDocumentBuilder'
import { applyDocumentAppend, createEmptyLayoutDocument } from './documentAppend'
import { buildPageExtractionPayload } from './payloadBuilder'
import { createStreamEventSequence } from './streamEventSource'
import { splitPagePayloadIntoChunks } from './streamEvents'
import {
  getLayoutNodeClassName,
  getPageNodeCount,
  type LayoutDocument,
} from '@/document/layoutTypes'
import { generateSyntheticPageContent } from '@/document/synthetic/pageContentGenerator'

const PAGE_COUNT = 12
const DOCUMENT_SEED = 0x57ea
const CHUNKS_PER_PAGE = 3

function buildBatchDocument(): LayoutDocument {
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

/** Runs the shuffled stream through the worker-side builder, as the worker does. */
function buildStreamedDocument(): { worker: LayoutDocument; mainThread: LayoutDocument } {
  const events = createStreamEventSequence(PAGE_COUNT, DOCUMENT_SEED, CHUNKS_PER_PAGE)
  const builder = new LayoutDocumentBuilder(PAGE_COUNT)
  const workerDocument = builder.getDocument()
  const mainThreadDocument = createEmptyLayoutDocument(PAGE_COUNT)
  const chunksSeenByPage = new Map<number, number>()

  for (const event of events) {
    if (event.kind !== 'pageChunk') {
      continue
    }
    const chunksSeen = (chunksSeenByPage.get(event.pageIndex) ?? 0) + 1
    chunksSeenByPage.set(event.pageIndex, chunksSeen)

    const range = builder.ingestPageChunk(event.payload, chunksSeen >= event.chunkCount)
    applyDocumentAppend(mainThreadDocument, builder.createAppendPatch(range))
  }

  return { worker: workerDocument, mainThread: mainThreadDocument }
}

function describePage(layoutDocument: LayoutDocument, pageIndex: number): string {
  const readingOrder = layoutDocument.readingOrderByPage[pageIndex].nodeIds
    .map((nodeId) => layoutDocument.sourceNodeIds[nodeId])
    .join(',')
  const classes = layoutDocument.readingOrderByPage[pageIndex].nodeIds
    .map((nodeId) => getLayoutNodeClassName(layoutDocument.geometry.classIds[nodeId]))
    .join(',')
  return `${readingOrder}|${classes}`
}

describe('splitPagePayloadIntoChunks', () => {
  const payload = buildPageExtractionPayload(
    generateSyntheticPageContent(0, DOCUMENT_SEED),
    DOCUMENT_SEED,
  )

  it('keeps every box, exactly once', () => {
    const chunks = splitPagePayloadIntoChunks(payload, CHUNKS_PER_PAGE)
    const boxIds = chunks.flatMap((chunk) => chunk.boxes.map((box) => box.id))

    expect(new Set(boxIds).size).toBe(boxIds.length)
    expect(boxIds.sort()).toEqual(payload.boxes.map((box) => box.id).sort())
  })

  /** A chunk that referred to a parent in another chunk could not be applied on arrival. */
  it('keeps every block whole, so no chunk depends on another', () => {
    for (const chunk of splitPagePayloadIntoChunks(payload, CHUNKS_PER_PAGE)) {
      const idsInChunk = new Set(chunk.boxes.map((box) => box.id))
      for (const box of chunk.boxes) {
        if (box.parentId !== null) {
          expect(idsInChunk.has(box.parentId)).toBe(true)
        }
      }
    }
  })

  it('repeats the page reading order in every chunk', () => {
    for (const chunk of splitPagePayloadIntoChunks(payload, CHUNKS_PER_PAGE)) {
      expect(chunk.readingOrder).toEqual(payload.readingOrder)
    }
  })

  it('keeps a table and its cells together', () => {
    const chunks = splitPagePayloadIntoChunks(payload, CHUNKS_PER_PAGE)
    for (const chunk of chunks) {
      for (const table of chunk.tables) {
        expect(chunk.boxes.some((box) => box.id === table.id)).toBe(true)
      }
    }
    expect(chunks.flatMap((chunk) => chunk.tables).length).toBe(payload.tables.length)
  })

  it('never produces more chunks than there are blocks', () => {
    expect(splitPagePayloadIntoChunks(payload, 10_000).length).toBeLessThanOrEqual(
      payload.readingOrder.length,
    )
    expect(splitPagePayloadIntoChunks(payload, 1)).toHaveLength(1)
  })
})

describe('createStreamEventSequence', () => {
  const events = createStreamEventSequence(PAGE_COUNT, DOCUMENT_SEED, CHUNKS_PER_PAGE)

  it('frames the document with a start and a completion event', () => {
    expect(events[0].kind).toBe('documentStarted')
    expect(events[events.length - 1].kind).toBe('documentCompleted')
  })

  it('delivers chunks out of order and interleaved across pages', () => {
    const pageSequence = events
      .filter((event) => event.kind === 'pageChunk')
      .map((event) => (event.kind === 'pageChunk' ? event.pageIndex : -1))

    // Pages are not delivered in order...
    expect(pageSequence).not.toEqual([...pageSequence].sort((left, right) => left - right))
    // ...and a page's chunks are not delivered back to back.
    const firstPageIndexes = pageSequence.reduce<number[]>((positions, pageIndex, position) => {
      if (pageIndex === pageSequence[0]) {
        positions.push(position)
      }
      return positions
    }, [])
    expect(firstPageIndexes[firstPageIndexes.length - 1] - firstPageIndexes[0]).toBeGreaterThan(1)
  })

  it('is deterministic for a seed', () => {
    const repeated = createStreamEventSequence(PAGE_COUNT, DOCUMENT_SEED, CHUNKS_PER_PAGE)
    expect(JSON.stringify(repeated)).toBe(JSON.stringify(events))
  })
})

describe('streamed reconciliation', () => {
  const batch = buildBatchDocument()
  const streamed = buildStreamedDocument()

  it('reconstructs the same node count as a batch load', () => {
    expect(streamed.worker.geometry.nodeCount).toBe(batch.geometry.nodeCount)
    expect(streamed.mainThread.geometry.nodeCount).toBe(batch.geometry.nodeCount)
  })

  it('gives every page the same number of boxes as a batch load', () => {
    for (let pageIndex = 0; pageIndex < PAGE_COUNT; pageIndex += 1) {
      expect(getPageNodeCount(streamed.worker, pageIndex)).toBe(
        getPageNodeCount(batch, pageIndex),
      )
      expect(getPageNodeCount(streamed.mainThread, pageIndex)).toBe(
        getPageNodeCount(batch, pageIndex),
      )
    }
  })

  /** The point of repeating the reading order in every chunk. */
  it('recovers the model’s reading order despite out-of-order arrival', () => {
    for (let pageIndex = 0; pageIndex < PAGE_COUNT; pageIndex += 1) {
      expect(describePage(streamed.worker, pageIndex)).toBe(describePage(batch, pageIndex))
      expect(describePage(streamed.mainThread, pageIndex)).toBe(describePage(batch, pageIndex))
    }
  })

  it('splits each page across several spans, one per chunk', () => {
    for (let pageIndex = 0; pageIndex < PAGE_COUNT; pageIndex += 1) {
      expect(streamed.worker.nodeRangesByPage[pageIndex].length).toBeGreaterThan(1)
      expect(batch.nodeRangesByPage[pageIndex]).toHaveLength(1)
    }
  })

  it('reproduces every table mesh', () => {
    for (let pageIndex = 0; pageIndex < PAGE_COUNT; pageIndex += 1) {
      const batchMeshes = batch.tableMeshesByPage[pageIndex]
      const streamedMeshes = streamed.mainThread.tableMeshesByPage[pageIndex]
      expect(streamedMeshes).toHaveLength(batchMeshes.length)

      batchMeshes.forEach((batchMesh, meshIndex) => {
        const streamedMesh = streamedMeshes[meshIndex]
        expect(streamedMesh.columnEdges).toEqual(batchMesh.columnEdges)
        expect(streamedMesh.rowEdges).toEqual(batchMesh.rowEdges)
        expect(streamedMesh.cells).toHaveLength(batchMesh.cells.length)
      })
    }
  })

  it('links every child to its parent on the main thread', () => {
    const { geometry, childIdsByNodeId } = streamed.mainThread
    for (let nodeId = 0; nodeId < geometry.nodeCount; nodeId += 1) {
      const parentId = geometry.parentIds[nodeId]
      if (parentId >= 0) {
        expect(childIdsByNodeId[parentId]).toContain(nodeId)
      }
    }
  })

  it('carries text and source ids across the thread boundary', () => {
    for (let nodeId = 0; nodeId < batch.geometry.nodeCount; nodeId += 1) {
      expect(streamed.mainThread.sourceNodeIds[nodeId]).toBe(
        streamed.worker.sourceNodeIds[nodeId],
      )
      expect(streamed.mainThread.texts[nodeId]).toBe(streamed.worker.texts[nodeId])
    }
  })
})

describe('applyDocumentAppend', () => {
  it('keeps the document object identity, so selection and history survive a chunk', () => {
    const document = createEmptyLayoutDocument(2)
    const geometryBefore = document.geometry
    const builder = new LayoutDocumentBuilder(2)
    const range = builder.ingestPage(
      buildPageExtractionPayload(generateSyntheticPageContent(0, DOCUMENT_SEED), DOCUMENT_SEED),
    )

    const returnedRange = applyDocumentAppend(document, builder.createAppendPatch(range))

    expect(document.geometry).toBe(geometryBefore)
    expect(returnedRange).toEqual({ pageIndex: 0, firstNodeId: 0, nodeCount: range.nodeCount })
    expect(document.geometry.nodeCount).toBe(range.nodeCount)
  })

  it('grows the buffers as chunks arrive', () => {
    const document = createEmptyLayoutDocument(4)
    const builder = new LayoutDocumentBuilder(4)

    for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
      const range = builder.ingestPage(
        buildPageExtractionPayload(
          generateSyntheticPageContent(pageIndex, DOCUMENT_SEED),
          DOCUMENT_SEED,
        ),
      )
      applyDocumentAppend(document, builder.createAppendPatch(range))
    }

    expect(document.geometry.nodeCount).toBe(builder.nodeCount)
    expect(document.geometry.classIds.length).toBeGreaterThanOrEqual(builder.nodeCount)
  })
})

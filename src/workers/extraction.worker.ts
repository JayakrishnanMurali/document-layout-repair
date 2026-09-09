import type { Rect } from '@/canvas/geometry'
import { LayoutDocumentBuilder } from '@/document/extraction/LayoutDocumentBuilder'
import { buildPageExtractionPayload } from '@/document/extraction/payloadBuilder'
import { ensureLayoutGeometryCapacity } from '@/document/geometryBuffers'
import { readNodeBounds, writeNodeBounds, type LayoutDocument } from '@/document/layoutTypes'
import { generateSyntheticPageContent } from '@/document/synthetic/pageContentGenerator'
import { LayoutSpatialIndex } from '@/spatial/LayoutSpatialIndex'
import {
  collectDocumentTransferables,
  type ExtractionTimings,
  type ExtractionWorkerRequest,
  type ExtractionWorkerResponse,
} from './extractionProtocol'
import { getTypedWorkerScope } from './typedWorkerScope'

/**
 * Owns extraction state off the main thread: payload parsing, normalization into dense
 * buffers, and the spatial index that answers hit-tests.
 *
 * The main thread receives a copy of the geometry for rendering, but this worker remains
 * the authority for hit-testing, so every edit is replayed here to keep the index and
 * the rendered geometry in agreement.
 */

const workerScope = getTypedWorkerScope<ExtractionWorkerRequest, ExtractionWorkerResponse>()

/** Pages processed between progress posts, so a 100-page load streams into the UI. */
const PAGES_PER_PROGRESS_CHUNK = 4

let documentBuilder: LayoutDocumentBuilder | null = null
let spatialIndex: LayoutSpatialIndex | null = null
let layoutDocument: LayoutDocument | null = null

const previousBoundsScratch: Rect = { x: 0, y: 0, width: 0, height: 0 }

function post(message: ExtractionWorkerResponse, transfer: Transferable[] = []): void {
  workerScope.postMessage(message, transfer)
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

function reset(): void {
  documentBuilder = null
  spatialIndex = null
  layoutDocument = null
}

async function loadDocument(
  requestId: number,
  pageCount: number,
  documentSeed: number,
): Promise<void> {
  const startedAt = performance.now()
  const timings: ExtractionTimings = {
    generateMilliseconds: 0,
    parseMilliseconds: 0,
    indexMilliseconds: 0,
    totalMilliseconds: 0,
  }

  documentBuilder = new LayoutDocumentBuilder(pageCount)
  spatialIndex = new LayoutSpatialIndex(pageCount)
  layoutDocument = documentBuilder.getDocument()

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const generateStartedAt = performance.now()
    const payload = buildPageExtractionPayload(
      generateSyntheticPageContent(pageIndex, documentSeed),
      documentSeed,
    )
    timings.generateMilliseconds += performance.now() - generateStartedAt

    const parseStartedAt = performance.now()
    const ingested = documentBuilder.ingestPage(payload)
    timings.parseMilliseconds += performance.now() - parseStartedAt

    const indexStartedAt = performance.now()
    spatialIndex.insertPageRange(layoutDocument, ingested)
    timings.indexMilliseconds += performance.now() - indexStartedAt

    if ((pageIndex + 1) % PAGES_PER_PROGRESS_CHUNK === 0) {
      post({
        kind: 'loadProgress',
        requestId,
        ingestedPageCount: documentBuilder.ingestedPageCount,
        pageCount,
        nodeCount: documentBuilder.nodeCount,
      })
      await yieldToEventLoop()
    }
  }

  timings.totalMilliseconds = performance.now() - startedAt

  const snapshot: LayoutDocument = {
    ...documentBuilder.getDocument(),
    geometry: documentBuilder.createGeometrySnapshot(),
  }

  post(
    { kind: 'documentReady', requestId, document: snapshot, timings },
    collectDocumentTransferables(snapshot),
  )
}

function handleHitTest(requestId: number, worldX: number, worldY: number): void {
  if (!spatialIndex || !layoutDocument) {
    post({ kind: 'workerFailed', requestId, reason: 'No document is loaded' })
    return
  }

  const startedAt = performance.now()
  const outcome = spatialIndex.hitTest(layoutDocument, worldX, worldY)

  post({
    kind: 'hitTestResult',
    requestId,
    nodeId: outcome.nodeId,
    candidateNodeIds: outcome.candidateNodeIds,
    queryMilliseconds: performance.now() - startedAt,
  })
}

function handleBoundsUpdate(
  requestId: number,
  nodeIds: Int32Array,
  nextBounds: Float32Array,
): void {
  if (!spatialIndex || !layoutDocument) {
    post({ kind: 'workerFailed', requestId, reason: 'No document is loaded' })
    return
  }

  const startedAt = performance.now()

  for (let entryIndex = 0; entryIndex < nodeIds.length; entryIndex += 1) {
    const nodeId = nodeIds[entryIndex]
    const boundsOffset = entryIndex * 4
    // A node id past the end is one the main thread just created — splitting a table
    // cell adds a cell to every row — so it is inserted rather than moved.
    const isNewNode = nodeId >= layoutDocument.geometry.nodeCount

    if (isNewNode) {
      ensureLayoutGeometryCapacity(layoutDocument.geometry, nodeId + 1)
      layoutDocument.geometry.nodeCount = nodeId + 1
    } else {
      readNodeBounds(layoutDocument.geometry, nodeId, previousBoundsScratch)
    }

    writeNodeBounds(layoutDocument.geometry, nodeId, {
      x: nextBounds[boundsOffset],
      y: nextBounds[boundsOffset + 1],
      width: nextBounds[boundsOffset + 2],
      height: nextBounds[boundsOffset + 3],
    })

    if (isNewNode) {
      spatialIndex.insertNode(layoutDocument, nodeId)
    } else {
      spatialIndex.updateNode(layoutDocument, nodeId, previousBoundsScratch)
    }
  }

  post({ kind: 'boundsUpdated', requestId, reindexMilliseconds: performance.now() - startedAt })
}

workerScope.onmessage = (event: MessageEvent<ExtractionWorkerRequest>) => {
  const message = event.data

  switch (message.kind) {
    case 'loadDocument':
      void loadDocument(message.requestId, message.pageCount, message.documentSeed)
      break

    case 'ingestPage': {
      if (!documentBuilder || !spatialIndex || !layoutDocument) {
        post({ kind: 'workerFailed', requestId: message.requestId, reason: 'No document is loaded' })
        break
      }
      const ingested = documentBuilder.ingestPage(message.payload)
      spatialIndex.insertPageRange(layoutDocument, ingested)
      post({
        kind: 'pageIngested',
        requestId: message.requestId,
        ingestedPageCount: documentBuilder.ingestedPageCount,
        pageCount: layoutDocument.pageCount,
        nodeCount: documentBuilder.nodeCount,
      })
      break
    }

    case 'hitTest':
      handleHitTest(message.requestId, message.worldX, message.worldY)
      break

    case 'updateNodeBounds':
      handleBoundsUpdate(message.requestId, message.nodeIds, message.nextBounds)
      break

    case 'reset':
      reset()
      break
  }
}

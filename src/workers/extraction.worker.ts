import type { Rect } from '@/canvas/geometry'
import {
  collectAppendPatchTransferables,
  type DocumentAppendPatch,
} from '@/document/extraction/documentAppend'
import { LayoutDocumentBuilder } from '@/document/extraction/LayoutDocumentBuilder'
import { buildPageExtractionPayload } from '@/document/extraction/payloadBuilder'
import { createStreamEventSequence } from '@/document/extraction/streamEventSource'
import type { ExtractionStreamEvent } from '@/document/extraction/streamEvents'
import { ensureLayoutGeometryCapacity } from '@/document/geometryBuffers'
import { readNodeBounds, writeNodeBounds, type LayoutDocument } from '@/document/layoutTypes'
import { generateSyntheticPageContent } from '@/document/synthetic/pageContentGenerator'
import { LayoutSpatialIndex } from '@/spatial/LayoutSpatialIndex'
import {
  collectDocumentTransferables,
  type ExtractionStreamSource,
  type ExtractionStreamStatistics,
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

type ActiveStream = {
  requestId: number
  source: ExtractionStreamSource
  statistics: ExtractionStreamStatistics
  /** Chunks for pages the document has not been sized for yet. */
  pendingChunks: ExtractionStreamEvent[]
  chunksSeenByPage: Map<number, number>
  close: () => void
}

let activeStream: ActiveStream | null = null

function post(message: ExtractionWorkerResponse, transfer: Transferable[] = []): void {
  workerScope.postMessage(message, transfer)
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

function reset(): void {
  stopStream()
  documentBuilder = null
  spatialIndex = null
  layoutDocument = null
}

function stopStream(): void {
  activeStream?.close()
  activeStream = null
}

function createStreamStatistics(): ExtractionStreamStatistics {
  return {
    eventCount: 0,
    ingestedPageCount: 0,
    nodeCount: 0,
    lastEventMilliseconds: 0,
    worstEventMilliseconds: 0,
  }
}

/**
 * Ingests one stream event.
 *
 * Chunks arrive out of order and interleaved, so anything that turns up before its
 * document has been sized waits in a buffer and is replayed once `documentStarted`
 * lands — a stream is not obliged to deliver its header first.
 */
function handleStreamEvent(stream: ActiveStream, event: ExtractionStreamEvent): void {
  const startedAt = performance.now()
  stream.statistics.eventCount += 1

  switch (event.kind) {
    case 'documentStarted': {
      documentBuilder = new LayoutDocumentBuilder(event.pageCount)
      spatialIndex = new LayoutSpatialIndex(event.pageCount)
      layoutDocument = documentBuilder.getDocument()

      post({
        kind: 'streamStarted',
        requestId: stream.requestId,
        source: stream.source,
        pageCount: event.pageCount,
        documentSeed: event.documentSeed,
      })

      const buffered = stream.pendingChunks
      stream.pendingChunks = []
      for (const pendingEvent of buffered) {
        handleStreamEvent(stream, pendingEvent)
      }
      break
    }

    case 'pageChunk': {
      if (!documentBuilder || !spatialIndex || !layoutDocument) {
        stream.pendingChunks.push(event)
        return
      }

      const chunksSeen = (stream.chunksSeenByPage.get(event.pageIndex) ?? 0) + 1
      stream.chunksSeenByPage.set(event.pageIndex, chunksSeen)

      const range = documentBuilder.ingestPageChunk(
        event.payload,
        chunksSeen >= event.chunkCount,
      )
      spatialIndex.insertPageRange(layoutDocument, range)

      const patch: DocumentAppendPatch = documentBuilder.createAppendPatch(range)
      stream.statistics.ingestedPageCount = documentBuilder.ingestedPageCount
      stream.statistics.nodeCount = documentBuilder.nodeCount
      recordEventDuration(stream, startedAt)

      post(
        {
          kind: 'nodesAppended',
          requestId: stream.requestId,
          patch,
          statistics: { ...stream.statistics },
        },
        collectAppendPatchTransferables(patch),
      )
      return
    }

    case 'documentCompleted': {
      recordEventDuration(stream, startedAt)
      post({
        kind: 'streamCompleted',
        requestId: stream.requestId,
        statistics: { ...stream.statistics },
      })
      stopStream()
      return
    }
  }

  recordEventDuration(stream, startedAt)
}

function recordEventDuration(stream: ActiveStream, startedAt: number): void {
  const elapsed = performance.now() - startedAt
  stream.statistics.lastEventMilliseconds = elapsed
  stream.statistics.worstEventMilliseconds = Math.max(
    stream.statistics.worstEventMilliseconds,
    elapsed,
  )
}

function startStream(
  request: Extract<ExtractionWorkerRequest, { kind: 'startStream' }>,
): void {
  reset()

  const stream: ActiveStream = {
    requestId: request.requestId,
    source: request.source,
    statistics: createStreamStatistics(),
    pendingChunks: [],
    chunksSeenByPage: new Map(),
    close: () => undefined,
  }
  activeStream = stream

  if (request.source === 'sse') {
    const eventSource = new EventSource(request.streamUrl)
    stream.close = () => eventSource.close()

    eventSource.onmessage = (messageEvent: MessageEvent<string>) => {
      if (activeStream !== stream) {
        return
      }
      handleStreamEvent(stream, JSON.parse(messageEvent.data) as ExtractionStreamEvent)
    }
    eventSource.onerror = () => {
      if (activeStream !== stream) {
        return
      }
      // The endpoint closes the connection when the document is done, which EventSource
      // reports as an error; only a failure before the first event is worth surfacing.
      if (stream.statistics.eventCount === 0) {
        post({
          kind: 'streamFailed',
          requestId: stream.requestId,
          reason: `Could not reach ${request.streamUrl}`,
        })
      }
      stopStream()
    }
    return
  }

  const events = createStreamEventSequence(
    request.pageCount,
    request.documentSeed,
    request.chunksPerPage,
  )
  let eventIndex = 0
  const timer = setInterval(() => {
    if (activeStream !== stream || eventIndex >= events.length) {
      stopStream()
      return
    }
    handleStreamEvent(stream, events[eventIndex])
    eventIndex += 1
  }, Math.max(1, request.intervalMilliseconds))

  stream.close = () => clearInterval(timer)
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

function handleGeometryPatch(
  requestId: number,
  nodeIds: Int32Array,
  nextBounds: Float32Array,
  nextFlags: Uint8Array,
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

    layoutDocument.geometry.flags[nodeId] = nextFlags[entryIndex]

    if (isNewNode) {
      spatialIndex.insertNode(layoutDocument, nodeId)
    } else {
      spatialIndex.updateNode(layoutDocument, nodeId, previousBoundsScratch)
    }
  }

  post({ kind: 'geometryPatched', requestId, reindexMilliseconds: performance.now() - startedAt })
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

    case 'patchNodeGeometry':
      handleGeometryPatch(
        message.requestId,
        message.nodeIds,
        message.nextBounds,
        message.nextFlags,
      )
      break

    case 'startStream':
      startStream(message)
      break

    case 'stopStream':
      stopStream()
      break

    case 'reset':
      reset()
      break
  }
}

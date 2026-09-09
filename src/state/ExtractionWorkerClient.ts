import type { DocumentAppendPatch } from '@/document/extraction/documentAppend'
import type { PageExtractionPayload } from '@/document/extraction/extractionPayload'
import type { LayoutDocument, LayoutNodeId } from '@/document/layoutTypes'
import type {
  ExtractionStreamSource,
  ExtractionStreamStatistics,
  ExtractionTimings,
  ExtractionWorkerRequest,
  ExtractionWorkerResponse,
} from '@/workers/extractionProtocol'

export type DocumentLoadProgress = {
  ingestedPageCount: number
  pageCount: number
  nodeCount: number
}

export type DocumentLoadResult = {
  document: LayoutDocument
  timings: ExtractionTimings
}

export type HitTestResult = {
  requestId: number
  nodeId: LayoutNodeId
  candidateNodeIds: LayoutNodeId[]
  queryMilliseconds: number
}

export type StreamStartOptions = {
  source: ExtractionStreamSource
  streamUrl: string
  pageCount: number
  documentSeed: number
  chunksPerPage: number
  intervalMilliseconds: number
}

/**
 * A live stream is a subscription, not a request/response — so it reports through
 * callbacks rather than a promise.
 */
export type StreamSubscriber = {
  onStarted: (info: {
    source: ExtractionStreamSource
    pageCount: number
    documentSeed: number
  }) => void
  onNodesAppended: (
    patch: DocumentAppendPatch,
    statistics: ExtractionStreamStatistics,
  ) => void
  onCompleted: (statistics: ExtractionStreamStatistics) => void
  onFailed: (failure: { reason: string; ingestedPageCount: number }) => void
}

type PendingRequest = {
  resolve: (value: never) => void
  reject: (reason: Error) => void
}

/**
 * Main-thread handle on the extraction worker.
 *
 * Every request carries an id so responses can be correlated without the worker having
 * to preserve ordering — hover hit-tests in particular are fire-and-forget, and the
 * caller decides whether a late answer is still relevant.
 */
export class ExtractionWorkerClient {
  private readonly worker: Worker
  private readonly pendingRequests = new Map<number, PendingRequest>()
  private nextRequestId = 1
  private onLoadProgress: ((progress: DocumentLoadProgress) => void) | null = null
  private streamSubscriber: StreamSubscriber | null = null
  private activeStreamRequestId = 0
  private isDisposed = false

  constructor() {
    this.worker = new Worker(new URL('../workers/extraction.worker.ts', import.meta.url), {
      type: 'module',
      name: 'extraction',
    })
    this.worker.onmessage = this.handleWorkerMessage
  }

  loadDocument(
    pageCount: number,
    documentSeed: number,
    onProgress?: (progress: DocumentLoadProgress) => void,
  ): Promise<DocumentLoadResult> {
    this.onLoadProgress = onProgress ?? null
    return this.sendRequest<DocumentLoadResult>((requestId) => ({
      kind: 'loadDocument',
      requestId,
      pageCount,
      documentSeed,
    }))
  }

  ingestPage(payload: PageExtractionPayload): Promise<DocumentLoadProgress> {
    return this.sendRequest<DocumentLoadProgress>((requestId) => ({
      kind: 'ingestPage',
      requestId,
      payload,
    }))
  }

  hitTest(worldX: number, worldY: number): Promise<HitTestResult> {
    return this.sendRequest<HitTestResult>((requestId) => ({
      kind: 'hitTest',
      requestId,
      worldX,
      worldY,
    }))
  }

  /**
   * Replays a committed geometry edit into the worker's index. The buffers are copied
   * before transfer so callers can keep reusing their own scratch arrays.
   */
  patchNodeGeometry(
    nodeIds: Int32Array,
    nextBounds: Float32Array,
    nextFlags: Uint8Array,
  ): Promise<number> {
    const nodeIdsCopy = nodeIds.slice()
    const boundsCopy = nextBounds.slice()
    const flagsCopy = nextFlags.slice()

    return this.sendRequest<number>(
      (requestId) => ({
        kind: 'patchNodeGeometry',
        requestId,
        nodeIds: nodeIdsCopy,
        nextBounds: boundsCopy,
        nextFlags: flagsCopy,
      }),
      [nodeIdsCopy.buffer, boundsCopy.buffer, flagsCopy.buffer],
    )
  }

  startStream(options: StreamStartOptions, subscriber: StreamSubscriber): void {
    this.streamSubscriber = subscriber
    this.activeStreamRequestId = this.nextRequestId++
    this.worker.postMessage({
      kind: 'startStream',
      requestId: this.activeStreamRequestId,
      ...options,
    } satisfies ExtractionWorkerRequest)
  }

  stopStream(): void {
    if (this.activeStreamRequestId === 0) {
      return
    }
    this.worker.postMessage({
      kind: 'stopStream',
      requestId: this.activeStreamRequestId,
    } satisfies ExtractionWorkerRequest)
    this.streamSubscriber = null
    this.activeStreamRequestId = 0
  }

  reset(): void {
    this.streamSubscriber = null
    this.activeStreamRequestId = 0
    this.worker.postMessage({ kind: 'reset' } satisfies ExtractionWorkerRequest)
  }

  dispose(): void {
    this.isDisposed = true
    this.worker.onmessage = null
    this.worker.terminate()
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error('Extraction worker was disposed'))
    }
    this.pendingRequests.clear()
    this.onLoadProgress = null
    this.streamSubscriber = null
  }

  private sendRequest<ResultType>(
    createMessage: (requestId: number) => ExtractionWorkerRequest,
    transfer: Transferable[] = [],
  ): Promise<ResultType> {
    if (this.isDisposed) {
      return Promise.reject(new Error('Extraction worker was disposed'))
    }

    const requestId = this.nextRequestId++
    const message = createMessage(requestId)

    return new Promise<ResultType>((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        resolve: resolve as PendingRequest['resolve'],
        reject,
      })
      this.worker.postMessage(message, transfer)
    })
  }

  private settle(requestId: number, value: unknown): void {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) {
      return
    }
    this.pendingRequests.delete(requestId)
    pending.resolve(value as never)
  }

  private readonly handleWorkerMessage = (
    event: MessageEvent<ExtractionWorkerResponse>,
  ): void => {
    const message = event.data

    switch (message.kind) {
      // Progress on an in-flight load: reported, but the load promise stays pending
      // until `documentReady`.
      case 'loadProgress':
        this.onLoadProgress?.({
          ingestedPageCount: message.ingestedPageCount,
          pageCount: message.pageCount,
          nodeCount: message.nodeCount,
        })
        break

      case 'pageIngested':
        this.settle(message.requestId, {
          ingestedPageCount: message.ingestedPageCount,
          pageCount: message.pageCount,
          nodeCount: message.nodeCount,
        } satisfies DocumentLoadProgress)
        break

      case 'documentReady':
        this.onLoadProgress = null
        this.settle(message.requestId, {
          document: message.document,
          timings: message.timings,
        } satisfies DocumentLoadResult)
        break

      case 'hitTestResult':
        this.settle(message.requestId, {
          requestId: message.requestId,
          nodeId: message.nodeId,
          candidateNodeIds: message.candidateNodeIds,
          queryMilliseconds: message.queryMilliseconds,
        } satisfies HitTestResult)
        break

      case 'geometryPatched':
        this.settle(message.requestId, message.reindexMilliseconds)
        break

      case 'streamStarted':
        if (message.requestId === this.activeStreamRequestId) {
          this.streamSubscriber?.onStarted({
            source: message.source,
            pageCount: message.pageCount,
            documentSeed: message.documentSeed,
          })
        }
        break

      case 'nodesAppended':
        if (message.requestId === this.activeStreamRequestId) {
          this.streamSubscriber?.onNodesAppended(message.patch, message.statistics)
        }
        break

      // The stream is retired before the callback runs, because a subscriber is allowed
      // to start another one from inside it — falling back to the in-worker generator
      // when the endpoint is unreachable does exactly that, and clearing the id
      // afterwards would wipe the stream it had just opened.
      case 'streamCompleted':
        if (message.requestId === this.activeStreamRequestId) {
          const subscriber = this.streamSubscriber
          this.activeStreamRequestId = 0
          subscriber?.onCompleted(message.statistics)
        }
        break

      case 'streamFailed':
        if (message.requestId === this.activeStreamRequestId) {
          const subscriber = this.streamSubscriber
          this.activeStreamRequestId = 0
          subscriber?.onFailed({
            reason: message.reason,
            ingestedPageCount: message.ingestedPageCount,
          })
        }
        break

      case 'workerFailed': {
        const pending = this.pendingRequests.get(message.requestId)
        this.pendingRequests.delete(message.requestId)
        pending?.reject(new Error(message.reason))
        break
      }
    }
  }
}

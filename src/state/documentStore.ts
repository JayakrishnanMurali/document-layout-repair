import { create } from 'zustand'
import {
  applyDocumentAppend,
  createEmptyLayoutDocument,
} from '@/document/extraction/documentAppend'
import { NO_LAYOUT_NODE_ID, type LayoutDocument, type LayoutNodeId } from '@/document/layoutTypes'
import type {
  ExtractionStreamSource,
  ExtractionStreamStatistics,
  ExtractionTimings,
} from '@/workers/extractionProtocol'
import { layoutEditor } from './editorStore'
import {
  buildExtractionStreamUrl,
  disposeExtractionWorker,
  getExtractionWorkerClient,
} from './extractionWorker'
import type { DocumentPreset } from './workspaceStore'

export type DocumentLoadStatus = 'idle' | 'loading' | 'ready' | 'failed'

export type StreamStatus = 'idle' | 'connecting' | 'streaming' | 'completed' | 'failed'

/** Bounded log of arrivals, newest first, for the stream panel. */
export type StreamLogEntry = {
  eventIndex: number
  pageIndex: number
  nodeCount: number
  workerMilliseconds: number
}

const MAXIMUM_STREAM_LOG_ENTRIES = 40

export type DocumentStoreState = {
  status: DocumentLoadStatus
  failureReason: string | null
  document: LayoutDocument | null
  pageCount: number
  nodeCount: number
  ingestedPageCount: number
  timings: ExtractionTimings | null
  lastHitTestMilliseconds: number
  /** Number of hit tests performed; a query can legitimately measure 0 ms. */
  hitTestCount: number

  streamStatus: StreamStatus
  streamSource: ExtractionStreamSource | null
  streamStatistics: ExtractionStreamStatistics | null
  streamLog: StreamLogEntry[]
  streamFailureReason: string | null
  /** Increments per stream run, so per-run measurements know when to start over. */
  streamRunId: number
  /** `performance.now()` when the current run began, for windowing measurements. */
  streamStartedAtMilliseconds: number

  loadPreset: (preset: DocumentPreset) => Promise<void>
  stopStream: () => void
  hitTestAtWorldPoint: (worldX: number, worldY: number) => Promise<LayoutNodeId>
  disposeWorker: () => void
}

/**
 * Tracks the loaded extraction document and how long the worker took to produce it.
 *
 * The document is a plain value in the store: React reads counts and text from it, while
 * the canvas engine reads the geometry buffers imperatively through `getState()` so a
 * frame never depends on a re-render.
 */
export const useDocumentStore = create<DocumentStoreState>((set, get) => ({
  status: 'idle',
  failureReason: null,
  document: null,
  pageCount: 0,
  nodeCount: 0,
  ingestedPageCount: 0,
  timings: null,
  lastHitTestMilliseconds: 0,
  hitTestCount: 0,
  streamStatus: 'idle',
  streamSource: null,
  streamStatistics: null,
  streamLog: [],
  streamFailureReason: null,
  streamRunId: 0,
  streamStartedAtMilliseconds: 0,

  loadPreset: async (preset) => {
    getExtractionWorkerClient().stopStream()
    layoutEditor.setDocument(null)
    set({
      status: 'loading',
      failureReason: null,
      document: null,
      pageCount: preset.pageCount,
      nodeCount: 0,
      ingestedPageCount: 0,
      timings: null,
      streamStatus: preset.deliveryMode === 'stream' ? 'connecting' : 'idle',
      streamSource: null,
      streamStatistics: null,
      streamLog: [],
      streamFailureReason: null,
      streamRunId: get().streamRunId + 1,
      streamStartedAtMilliseconds: performance.now(),
    })

    if (preset.deliveryMode === 'stream') {
      beginStream(preset, 'sse', set, get)
      return
    }

    try {
      const { document, timings } = await getExtractionWorkerClient().loadDocument(
        preset.pageCount,
        preset.documentSeed,
        (progress) =>
          set({
            ingestedPageCount: progress.ingestedPageCount,
            nodeCount: progress.nodeCount,
          }),
      )

      set({
        status: 'ready',
        document,
        pageCount: document.pageCount,
        nodeCount: document.geometry.nodeCount,
        ingestedPageCount: document.pageCount,
        timings,
      })
      layoutEditor.setDocument(document)
    } catch (error) {
      set({
        status: 'failed',
        failureReason: error instanceof Error ? error.message : 'Unknown failure',
      })
    }
  },

  hitTestAtWorldPoint: async (worldX, worldY) => {
    if (get().status !== 'ready') {
      return NO_LAYOUT_NODE_ID
    }

    const result = await getExtractionWorkerClient().hitTest(worldX, worldY)
    set({
      lastHitTestMilliseconds: result.queryMilliseconds,
      hitTestCount: get().hitTestCount + 1,
    })
    return result.nodeId
  },

  stopStream: () => {
    getExtractionWorkerClient().stopStream()
    set({ streamStatus: 'completed' })
  },

  disposeWorker: () => {
    disposeExtractionWorker()
  },
}))

type StoreSetter = (
  partial:
    | Partial<DocumentStoreState>
    | ((state: DocumentStoreState) => Partial<DocumentStoreState>),
) => void

/**
 * Opens the live stream and applies each arrival to the document already on screen.
 *
 * If the mock endpoint is unreachable — a static deployment with no server behind it —
 * the same sequence is generated inside the worker instead, so the workspace behaves
 * identically either way.
 */
function beginStream(
  preset: DocumentPreset,
  source: ExtractionStreamSource,
  set: StoreSetter,
  get: () => DocumentStoreState,
): void {
  const streamingDocument = createEmptyLayoutDocument(preset.pageCount)
  layoutEditor.setDocument(streamingDocument)

  set({
    status: 'ready',
    document: streamingDocument,
    pageCount: preset.pageCount,
    nodeCount: 0,
    ingestedPageCount: 0,
    streamStatus: 'connecting',
    streamSource: source,
  })

  getExtractionWorkerClient().startStream(
    {
      source,
      streamUrl: buildExtractionStreamUrl({
        pageCount: preset.pageCount,
        documentSeed: preset.documentSeed,
        chunksPerPage: preset.chunksPerPage,
        intervalMilliseconds: preset.intervalMilliseconds,
      }),
      pageCount: preset.pageCount,
      documentSeed: preset.documentSeed,
      chunksPerPage: preset.chunksPerPage,
      intervalMilliseconds: preset.intervalMilliseconds,
    },
    {
      onStarted: (info) => set({ streamStatus: 'streaming', streamSource: info.source }),

      onNodesAppended: (patch, statistics) => {
        applyDocumentAppend(streamingDocument, patch)
        layoutEditor.notifyDocumentAppended()

        set((state) => ({
          // An event already in flight when the reviewer disconnected must not put the
          // panel back into the streaming state.
          streamStatus: state.streamStatus === 'completed' ? 'completed' : 'streaming',
          streamStatistics: statistics,
          nodeCount: statistics.nodeCount,
          ingestedPageCount: statistics.ingestedPageCount,
          streamLog: [
            {
              eventIndex: statistics.eventCount,
              pageIndex: patch.pageIndex,
              nodeCount: patch.nodeCount,
              workerMilliseconds: statistics.lastEventMilliseconds,
            },
            ...state.streamLog,
          ].slice(0, MAXIMUM_STREAM_LOG_ENTRIES),
        }))
      },

      onCompleted: (statistics) =>
        set({ streamStatus: 'completed', streamStatistics: statistics }),

      onFailed: (failure) => {
        // Falling back restarts the document from empty, which would discard both the
        // pages already delivered and any edits made to them — so it is only for a
        // stream that never started: a deployment with no endpoint behind it.
        if (source === 'sse' && failure.ingestedPageCount === 0) {
          beginStream(preset, 'simulated', set, get)
          return
        }
        set({ streamStatus: 'failed', streamFailureReason: failure.reason })
      },
    },
  )
}

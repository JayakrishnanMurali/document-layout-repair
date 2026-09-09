import type { DocumentAppendPatch } from '@/document/extraction/documentAppend'
import type { PageExtractionPayload } from '@/document/extraction/extractionPayload'
import type { LayoutDocument, LayoutNodeId } from '@/document/layoutTypes'

export type ExtractionTimings = {
  generateMilliseconds: number
  parseMilliseconds: number
  indexMilliseconds: number
  totalMilliseconds: number
}

export type ExtractionWorkerRequest =
  | { kind: 'loadDocument'; requestId: number; pageCount: number; documentSeed: number }
  | { kind: 'ingestPage'; requestId: number; payload: PageExtractionPayload }
  | { kind: 'hitTest'; requestId: number; worldX: number; worldY: number }
  /**
   * A committed geometry edit, replayed so the worker's spatial index keeps agreeing with
   * what is on screen. Flags travel with the bounds because hiding a cell — merging a
   * table — has to stop it answering hit-tests.
   */
  | {
      kind: 'patchNodeGeometry'
      requestId: number
      nodeIds: Int32Array
      /** `x, y, width, height` per node id, in the same order. */
      nextBounds: Float32Array
      nextFlags: Uint8Array
    }
  /**
   * Opens the live extraction stream inside the worker.
   *
   * The worker owns the connection so the payload bytes never reach the main thread: they
   * are parsed, reconciled and indexed here, and only the resulting dense buffers cross
   * the boundary.
   */
  | {
      kind: 'startStream'
      requestId: number
      source: ExtractionStreamSource
      streamUrl: string
      pageCount: number
      documentSeed: number
      chunksPerPage: number
      intervalMilliseconds: number
    }
  | { kind: 'stopStream'; requestId: number }
  | { kind: 'reset' }

export type ExtractionStreamSource = 'sse' | 'simulated'

export type ExtractionStreamStatistics = {
  eventCount: number
  ingestedPageCount: number
  nodeCount: number
  /** Time the worker spent parsing and indexing the last event. */
  lastEventMilliseconds: number
  worstEventMilliseconds: number
}

export type ExtractionWorkerResponse =
  | {
      kind: 'loadProgress'
      requestId: number
      ingestedPageCount: number
      pageCount: number
      nodeCount: number
    }
  | {
      kind: 'documentReady'
      requestId: number
      document: LayoutDocument
      timings: ExtractionTimings
    }
  | {
      kind: 'pageIngested'
      requestId: number
      ingestedPageCount: number
      pageCount: number
      nodeCount: number
    }
  | {
      kind: 'hitTestResult'
      requestId: number
      nodeId: LayoutNodeId
      candidateNodeIds: LayoutNodeId[]
      queryMilliseconds: number
    }
  | { kind: 'geometryPatched'; requestId: number; reindexMilliseconds: number }
  | {
      kind: 'streamStarted'
      requestId: number
      source: ExtractionStreamSource
      pageCount: number
      documentSeed: number
    }
  | {
      kind: 'nodesAppended'
      requestId: number
      patch: DocumentAppendPatch
      statistics: ExtractionStreamStatistics
    }
  | { kind: 'streamCompleted'; requestId: number; statistics: ExtractionStreamStatistics }
  | { kind: 'streamFailed'; requestId: number; reason: string }
  | { kind: 'workerFailed'; requestId: number; reason: string }

/** Transfer list for a `documentReady` response: the geometry buffers move, not copy. */
export function collectDocumentTransferables(document: LayoutDocument): Transferable[] {
  return [
    document.geometry.bounds.buffer,
    document.geometry.classIds.buffer,
    document.geometry.pageIndexes.buffer,
    document.geometry.parentIds.buffer,
    document.geometry.confidences.buffer,
    document.geometry.flags.buffer,
  ]
}

import type { LayoutDocument, LayoutNodeId } from '@/document/layoutTypes'
import type { PageExtractionPayload } from '@/document/extraction/extractionPayload'

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
  | {
      kind: 'updateNodeBounds'
      requestId: number
      nodeIds: Int32Array
      /** `x, y, width, height` per node id, in the same order. */
      nextBounds: Float32Array
    }
  | { kind: 'reset' }

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
  | { kind: 'boundsUpdated'; requestId: number; reindexMilliseconds: number }
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

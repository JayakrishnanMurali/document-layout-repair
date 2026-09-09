import type { LayoutDocument, LayoutNodeId } from '@/document/layoutTypes'
import { ExtractionWorkerClient } from './ExtractionWorkerClient'

let extractionWorkerClient: ExtractionWorkerClient | null = null

/** One worker for the app's lifetime; loading another document reuses it. */
export function getExtractionWorkerClient(): ExtractionWorkerClient {
  extractionWorkerClient ??= new ExtractionWorkerClient()
  return extractionWorkerClient
}

export function disposeExtractionWorker(): void {
  extractionWorkerClient?.dispose()
  extractionWorkerClient = null
}

/**
 * Replays committed geometry into the worker so its spatial index keeps agreeing with
 * what is on screen. Called on transaction boundaries rather than per pointer move: the
 * index only answers clicks, and there are none in the middle of a drag.
 */
export function replayGeometryIntoIndex(
  nodeIds: readonly LayoutNodeId[],
  layoutDocument: LayoutDocument,
): void {
  if (nodeIds.length === 0) {
    return
  }

  const nodeIdBuffer = new Int32Array(nodeIds.length)
  const boundsBuffer = new Float32Array(nodeIds.length * 4)
  const flagsBuffer = new Uint8Array(nodeIds.length)

  nodeIds.forEach((nodeId, index) => {
    nodeIdBuffer[index] = nodeId
    flagsBuffer[index] = layoutDocument.geometry.flags[nodeId]
    const sourceOffset = nodeId * 4
    const targetOffset = index * 4
    boundsBuffer[targetOffset] = layoutDocument.geometry.bounds[sourceOffset]
    boundsBuffer[targetOffset + 1] = layoutDocument.geometry.bounds[sourceOffset + 1]
    boundsBuffer[targetOffset + 2] = layoutDocument.geometry.bounds[sourceOffset + 2]
    boundsBuffer[targetOffset + 3] = layoutDocument.geometry.bounds[sourceOffset + 3]
  })

  void getExtractionWorkerClient()
    .patchNodeGeometry(nodeIdBuffer, boundsBuffer, flagsBuffer)
    .catch((error: unknown) => {
      console.warn('Could not replay geometry into the spatial index:', error)
    })
}

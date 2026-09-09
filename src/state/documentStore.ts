import { create } from 'zustand'
import { NO_LAYOUT_NODE_ID, type LayoutDocument, type LayoutNodeId } from '@/document/layoutTypes'
import type { ExtractionTimings } from '@/workers/extractionProtocol'
import { ExtractionWorkerClient } from './ExtractionWorkerClient'
import type { DocumentPreset } from './workspaceStore'

export type DocumentLoadStatus = 'idle' | 'loading' | 'ready' | 'failed'

export type DocumentStoreState = {
  status: DocumentLoadStatus
  failureReason: string | null
  document: LayoutDocument | null
  pageCount: number
  nodeCount: number
  ingestedPageCount: number
  timings: ExtractionTimings | null
  lastHitTestMilliseconds: number
  selectedNodeId: LayoutNodeId
  hoveredNodeId: LayoutNodeId

  loadPreset: (preset: DocumentPreset) => Promise<void>
  selectNodeAtWorldPoint: (worldX: number, worldY: number) => Promise<LayoutNodeId>
  setSelectedNodeId: (nodeId: LayoutNodeId) => void
  setHoveredNodeId: (nodeId: LayoutNodeId) => void
  disposeWorker: () => void
}

let extractionWorkerClient: ExtractionWorkerClient | null = null

/** One worker for the app's lifetime; loading a new document reuses it. */
function getExtractionWorkerClient(): ExtractionWorkerClient {
  extractionWorkerClient ??= new ExtractionWorkerClient()
  return extractionWorkerClient
}

/**
 * Tracks the loaded extraction document and the reviewer's current selection.
 *
 * The document itself is a plain value in the store: React components read counts and
 * ids from it, while the canvas engine reads the geometry buffers imperatively through
 * `getState()` so a frame never depends on a re-render.
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
  selectedNodeId: NO_LAYOUT_NODE_ID,
  hoveredNodeId: NO_LAYOUT_NODE_ID,

  loadPreset: async (preset) => {
    set({
      status: 'loading',
      failureReason: null,
      document: null,
      pageCount: preset.pageCount,
      nodeCount: 0,
      ingestedPageCount: 0,
      timings: null,
      selectedNodeId: NO_LAYOUT_NODE_ID,
      hoveredNodeId: NO_LAYOUT_NODE_ID,
    })

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
    } catch (error) {
      set({
        status: 'failed',
        failureReason: error instanceof Error ? error.message : 'Unknown failure',
      })
    }
  },

  selectNodeAtWorldPoint: async (worldX, worldY) => {
    if (get().status !== 'ready') {
      return NO_LAYOUT_NODE_ID
    }

    const result = await getExtractionWorkerClient().hitTest(worldX, worldY)
    set({ selectedNodeId: result.nodeId, lastHitTestMilliseconds: result.queryMilliseconds })
    return result.nodeId
  },

  setSelectedNodeId: (nodeId) => set({ selectedNodeId: nodeId }),

  setHoveredNodeId: (nodeId) => {
    if (get().hoveredNodeId !== nodeId) {
      set({ hoveredNodeId: nodeId })
    }
  },

  disposeWorker: () => {
    extractionWorkerClient?.dispose()
    extractionWorkerClient = null
  },
}))

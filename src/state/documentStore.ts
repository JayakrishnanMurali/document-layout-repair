import { create } from 'zustand'
import { NO_LAYOUT_NODE_ID, type LayoutDocument, type LayoutNodeId } from '@/document/layoutTypes'
import type { ExtractionTimings } from '@/workers/extractionProtocol'
import { layoutEditor } from './editorStore'
import { disposeExtractionWorker, getExtractionWorkerClient } from './extractionWorker'
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
  /** Number of hit tests performed; a query can legitimately measure 0 ms. */
  hitTestCount: number

  loadPreset: (preset: DocumentPreset) => Promise<void>
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

  loadPreset: async (preset) => {
    layoutEditor.setDocument(null)
    set({
      status: 'loading',
      failureReason: null,
      document: null,
      pageCount: preset.pageCount,
      nodeCount: 0,
      ingestedPageCount: 0,
      timings: null,
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

  disposeWorker: () => {
    disposeExtractionWorker()
  },
}))

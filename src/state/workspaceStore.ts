import { create } from 'zustand'

export type DocumentPresetId = 'sample' | 'stressTest' | 'liveStream'

/**
 * How a preset's extraction reaches the workspace: in one batch, or streamed page by page
 * as an upstream model finishes them.
 */
export type DocumentDeliveryMode = 'batch' | 'stream'

export type DocumentPreset = {
  id: DocumentPresetId
  label: string
  description: string
  pageCount: number
  documentSeed: number
  deliveryMode: DocumentDeliveryMode
  /** Stream only: events per page, and the gap between events. */
  chunksPerPage: number
  intervalMilliseconds: number
}

export const DOCUMENT_PRESETS: Record<DocumentPresetId, DocumentPreset> = {
  sample: {
    id: 'sample',
    label: 'Sample document',
    description: '6 pages',
    pageCount: 6,
    documentSeed: 0x1a2b3c,
    deliveryMode: 'batch',
    chunksPerPage: 1,
    intervalMilliseconds: 0,
  },
  stressTest: {
    id: 'stressTest',
    label: 'Stress test document',
    description: '100 pages',
    pageCount: 100,
    documentSeed: 0x5eed01,
    deliveryMode: 'batch',
    chunksPerPage: 1,
    intervalMilliseconds: 0,
  },
  liveStream: {
    id: 'liveStream',
    label: 'Live extraction',
    description: '40 pages, streamed',
    pageCount: 40,
    documentSeed: 0x57ea,
    deliveryMode: 'stream',
    chunksPerPage: 3,
    intervalMilliseconds: 35,
  },
}

export const WORKSPACE_TOOLS = ['select', 'readingOrder', 'tableMesh'] as const

export type WorkspaceToolId = (typeof WORKSPACE_TOOLS)[number]

export const WORKSPACE_TOOL_LABELS: Record<WorkspaceToolId, string> = {
  select: 'Select & edit',
  readingOrder: 'Reading order',
  tableMesh: 'Table mesh',
}

export type OverlayRendererPreference = 'webgl2' | 'canvas2d'

export type WorkspaceState = {
  activePresetId: DocumentPresetId
  /** Structural tools take over the pointer, so only one can be active at a time. */
  activeToolId: WorkspaceToolId
  /**
   * Viewport culling is on in normal use. Turning it off submits every box in the
   * document each frame, which is how the renderer's instance throughput is measured
   * rather than asserted.
   */
  isViewportCullingEnabled: boolean
  /**
   * Which overlay renderer to use.
   *
   * The 2D path is a genuine fallback for contexts without WebGL2, and switchable because
   * it is also the honest way to show what the instanced path buys: on the 2D renderer the
   * cost is per box, so culling is decisive, while on WebGL2 it barely registers.
   */
  overlayRendererPreference: OverlayRendererPreference
  loadPreset: (presetId: DocumentPresetId) => void
  setActiveTool: (toolId: WorkspaceToolId) => void
  setViewportCullingEnabled: (isEnabled: boolean) => void
  setOverlayRendererPreference: (preference: OverlayRendererPreference) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  activePresetId: 'sample',
  activeToolId: 'select',
  isViewportCullingEnabled: true,
  overlayRendererPreference: 'webgl2',
  loadPreset: (presetId) => set({ activePresetId: presetId }),
  setActiveTool: (toolId) => set({ activeToolId: toolId }),
  setViewportCullingEnabled: (isEnabled) => set({ isViewportCullingEnabled: isEnabled }),
  setOverlayRendererPreference: (preference) =>
    set({ overlayRendererPreference: preference }),
}))

export function useActiveDocumentPreset(): DocumentPreset {
  return DOCUMENT_PRESETS[useWorkspaceStore((state) => state.activePresetId)]
}

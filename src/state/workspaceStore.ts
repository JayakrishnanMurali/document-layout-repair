import { create } from 'zustand'

export type DocumentPresetId = 'sample' | 'stressTest'

export type DocumentPreset = {
  id: DocumentPresetId
  label: string
  description: string
  pageCount: number
  documentSeed: number
}

export const DOCUMENT_PRESETS: Record<DocumentPresetId, DocumentPreset> = {
  sample: {
    id: 'sample',
    label: 'Sample document',
    description: '6 pages',
    pageCount: 6,
    documentSeed: 0x1a2b3c,
  },
  stressTest: {
    id: 'stressTest',
    label: 'Stress test document',
    description: '100 pages',
    pageCount: 100,
    documentSeed: 0x5eed01,
  },
}

export const WORKSPACE_TOOLS = ['select', 'readingOrder', 'tableMesh'] as const

export type WorkspaceToolId = (typeof WORKSPACE_TOOLS)[number]

export const WORKSPACE_TOOL_LABELS: Record<WorkspaceToolId, string> = {
  select: 'Select & edit',
  readingOrder: 'Reading order',
  tableMesh: 'Table mesh',
}

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
  loadPreset: (presetId: DocumentPresetId) => void
  setActiveTool: (toolId: WorkspaceToolId) => void
  setViewportCullingEnabled: (isEnabled: boolean) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  activePresetId: 'sample',
  activeToolId: 'select',
  isViewportCullingEnabled: true,
  loadPreset: (presetId) => set({ activePresetId: presetId }),
  setActiveTool: (toolId) => set({ activeToolId: toolId }),
  setViewportCullingEnabled: (isEnabled) => set({ isViewportCullingEnabled: isEnabled }),
}))

export function useActiveDocumentPreset(): DocumentPreset {
  return DOCUMENT_PRESETS[useWorkspaceStore((state) => state.activePresetId)]
}

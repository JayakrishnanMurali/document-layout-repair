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

export type WorkspaceState = {
  activePresetId: DocumentPresetId
  loadPreset: (presetId: DocumentPresetId) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  activePresetId: 'sample',
  loadPreset: (presetId) => set({ activePresetId: presetId }),
}))

export function useActiveDocumentPreset(): DocumentPreset {
  return DOCUMENT_PRESETS[useWorkspaceStore((state) => state.activePresetId)]
}

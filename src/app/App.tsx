import { useEffect } from 'react'
import { CanvasViewport } from '@/features/viewport/CanvasViewport'
import { InspectorPanel } from '@/features/inspector/InspectorPanel'
import { StructureTreePanel } from '@/features/structureTree/StructureTreePanel'
import { WorkspaceStatusBar } from '@/features/workspace/WorkspaceStatusBar'
import { useDocumentStore } from '@/state/documentStore'
import { layoutEditor, useEditorStore } from '@/state/editorStore'
import {
  DOCUMENT_PRESETS,
  useActiveDocumentPreset,
  useWorkspaceStore,
  type DocumentPresetId,
} from '@/state/workspaceStore'
import styles from './App.module.css'

const PRESET_ORDER: DocumentPresetId[] = ['sample', 'stressTest']

export function App() {
  const activePreset = useActiveDocumentPreset()
  const loadPreset = useWorkspaceStore((state) => state.loadPreset)
  const loadDocumentPreset = useDocumentStore((state) => state.loadPreset)
  const isViewportCullingEnabled = useWorkspaceStore((state) => state.isViewportCullingEnabled)
  const setViewportCullingEnabled = useWorkspaceStore((state) => state.setViewportCullingEnabled)
  const canUndo = useEditorStore((state) => state.canUndo)
  const canRedo = useEditorStore((state) => state.canRedo)
  const nextUndoLabel = useEditorStore((state) => state.nextUndoLabel)
  const nextRedoLabel = useEditorStore((state) => state.nextRedoLabel)

  useEffect(() => {
    void loadDocumentPreset(activePreset)
  }, [activePreset, loadDocumentPreset])

  return (
    <div className={styles.workspace}>
      <header className={styles.toolbar}>
        <span className={styles.productName}>Layout Repair</span>

        <div className={styles.segmentedControl} role="group" aria-label="Benchmark dataset">
          {PRESET_ORDER.map((presetId) => {
            const preset = DOCUMENT_PRESETS[presetId]
            const isActive = presetId === activePreset.id
            return (
              <button
                key={presetId}
                type="button"
                className={isActive ? styles.segmentActive : styles.segment}
                aria-pressed={isActive}
                onClick={() => loadPreset(presetId)}
              >
                {preset.label}
                <span className={styles.segmentDetail}>{preset.description}</span>
              </button>
            )
          })}
        </div>

        <div className={styles.historyControls}>
          <button
            type="button"
            className={styles.toggle}
            disabled={!canUndo}
            title={nextUndoLabel ? `Undo ${nextUndoLabel}` : 'Nothing to undo'}
            onClick={() => layoutEditor.undo()}
          >
            Undo
          </button>
          <button
            type="button"
            className={styles.toggle}
            disabled={!canRedo}
            title={nextRedoLabel ? `Redo ${nextRedoLabel}` : 'Nothing to redo'}
            onClick={() => layoutEditor.redo()}
          >
            Redo
          </button>
        </div>

        <button
          type="button"
          className={isViewportCullingEnabled ? styles.toggle : styles.toggleActive}
          aria-pressed={!isViewportCullingEnabled}
          title="Submit every box in the document each frame instead of only the visible ones"
          onClick={() => setViewportCullingEnabled(!isViewportCullingEnabled)}
        >
          {isViewportCullingEnabled ? 'Culling on' : 'Culling off'}
        </button>
      </header>

      <div className={styles.body}>
        <main className={styles.viewportRegion}>
          <CanvasViewport
            pageCount={activePreset.pageCount}
            documentSeed={activePreset.documentSeed}
          />
        </main>
        <aside className={styles.sidePanel}>
          <StructureTreePanel />
          <InspectorPanel />
        </aside>
      </div>

      <WorkspaceStatusBar />
    </div>
  )
}

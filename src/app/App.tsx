import { CanvasViewport } from '@/features/viewport/CanvasViewport'
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
      </header>

      <div className={styles.body}>
        <main className={styles.viewportRegion}>
          <CanvasViewport
            pageCount={activePreset.pageCount}
            documentSeed={activePreset.documentSeed}
          />
        </main>
        <aside className={styles.sidePanel}>
          <div className={styles.placeholder}>Structure tree</div>
        </aside>
      </div>

      <footer className={styles.statusBar}>
        <span>{activePreset.pageCount} pages</span>
        <span>drag to pan · wheel to zoom · 0 fit document · 1 actual size</span>
      </footer>
    </div>
  )
}

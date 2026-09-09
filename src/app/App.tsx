import styles from './App.module.css'

export function App() {
  return (
    <div className={styles.workspace}>
      <header className={styles.toolbar}>
        <span className={styles.productName}>Layout Repair</span>
      </header>

      <div className={styles.body}>
        <main className={styles.viewportRegion}>
          <div className={styles.placeholder}>Canvas viewport</div>
        </main>
        <aside className={styles.sidePanel}>
          <div className={styles.placeholder}>Structure tree</div>
        </aside>
      </div>

      <footer className={styles.statusBar}>
        <span>ready</span>
      </footer>
    </div>
  )
}

import { useEffect, useState } from 'react'

export type LongTaskSummary = {
  /** Tasks that blocked the main thread for longer than the browser's 50ms threshold. */
  longTaskCount: number
  worstLongTaskMilliseconds: number
  /** False when the browser does not report long tasks at all. */
  isSupported: boolean
}

const IS_LONG_TASK_OBSERVER_SUPPORTED =
  typeof PerformanceObserver !== 'undefined' &&
  (PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false)

/**
 * Watches the main thread for long tasks that started after `sinceMilliseconds`,
 * resetting whenever `runId` changes.
 *
 * The brief's ingestion budget is about the main thread staying responsive while payloads
 * arrive, so the workspace measures that directly rather than asserting it: the stream
 * panel shows the count live, and it should stay at zero while pages stream in, because
 * the parsing and indexing happen in a worker.
 */
export function useMainThreadLongTasks(runId: number, sinceMilliseconds: number): LongTaskSummary {
  const [summary, setSummary] = useState({
    runId,
    longTaskCount: 0,
    worstLongTaskMilliseconds: 0,
  })

  // Long tasks are only meaningful for the run in front of you. Adjusting state during
  // render is the sanctioned way to react to a changed input without an extra pass.
  if (summary.runId !== runId) {
    setSummary({ runId, longTaskCount: 0, worstLongTaskMilliseconds: 0 })
  }

  useEffect(() => {
    if (!IS_LONG_TASK_OBSERVER_SUPPORTED) {
      return
    }

    const observer = new PerformanceObserver((entryList) => {
      let addedCount = 0
      let worstDuration = 0
      for (const entry of entryList.getEntries()) {
        // `buffered` replays tasks from before the observer attached — page load, module
        // evaluation, the first render — which say nothing about ingestion.
        if (entry.startTime < sinceMilliseconds) {
          continue
        }
        addedCount += 1
        worstDuration = Math.max(worstDuration, entry.duration)
      }
      if (addedCount === 0) {
        return
      }

      setSummary((previous) => ({
        runId: previous.runId,
        longTaskCount: previous.longTaskCount + addedCount,
        worstLongTaskMilliseconds: Math.max(previous.worstLongTaskMilliseconds, worstDuration),
      }))
    })

    observer.observe({ type: 'longtask', buffered: true })
    return () => observer.disconnect()
  }, [sinceMilliseconds])

  return {
    longTaskCount: summary.longTaskCount,
    worstLongTaskMilliseconds: summary.worstLongTaskMilliseconds,
    isSupported: IS_LONG_TASK_OBSERVER_SUPPORTED,
  }
}

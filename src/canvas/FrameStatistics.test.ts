import { describe, expect, it } from 'vitest'
import { FrameStatistics } from './FrameStatistics'

/** Records `count` frames at a fixed interval, starting at `startTimestamp`. */
function recordSteadyFrames(
  statistics: FrameStatistics,
  count: number,
  intervalMilliseconds: number,
  startTimestamp = 1000,
  durationMilliseconds = 0.2,
): number {
  let timestamp = startTimestamp
  for (let frame = 0; frame < count; frame += 1) {
    statistics.recordFrame(durationMilliseconds, timestamp)
    timestamp += intervalMilliseconds
  }
  return timestamp - intervalMilliseconds
}

describe('FrameStatistics', () => {
  it('reports nothing before any frame has been rendered', () => {
    const snapshot = new FrameStatistics().snapshot(5_000)

    expect(snapshot.framesPerSecond).toBe(0)
    expect(snapshot.isIdle).toBe(true)
    expect(snapshot.renderedFrameCount).toBe(0)
  })

  it('derives the rate from the interval between frames', () => {
    const statistics = new FrameStatistics()
    const lastTimestamp = recordSteadyFrames(statistics, 40, 1000 / 60)

    expect(statistics.snapshot(lastTimestamp).framesPerSecond).toBe(60)
  })

  it('reports 30 for frames arriving every 33ms', () => {
    const statistics = new FrameStatistics()
    const lastTimestamp = recordSteadyFrames(statistics, 40, 1000 / 30)

    expect(statistics.snapshot(lastTimestamp).framesPerSecond).toBe(30)
  })

  /**
   * The behaviour this exists for: counting frames in a trailing wall-clock second makes
   * the rate decay as the window drains once interaction stops, which reads as a
   * collapsing frame rate when nothing has slowed down.
   */
  it('holds the rate steady after rendering stops, and marks itself idle', () => {
    const statistics = new FrameStatistics()
    const lastTimestamp = recordSteadyFrames(statistics, 60, 1000 / 60)

    expect(statistics.snapshot(lastTimestamp).isIdle).toBe(false)

    for (const secondsIdle of [1.5, 5, 30]) {
      const snapshot = statistics.snapshot(lastTimestamp + secondsIdle * 1000)
      expect(snapshot.framesPerSecond).toBe(60)
      expect(snapshot.isIdle).toBe(true)
    }
  })

  it('ignores an idle gap rather than averaging it into the rate', () => {
    const statistics = new FrameStatistics()
    recordSteadyFrames(statistics, 30, 1000 / 60, 1000)
    // A long pause, then a fresh burst at the same rate.
    const lastTimestamp = recordSteadyFrames(statistics, 30, 1000 / 60, 40_000)

    expect(statistics.snapshot(lastTimestamp).framesPerSecond).toBe(60)
  })

  it('reports the worst frame, and leaves a lone outlier out of the 95th percentile', () => {
    const statistics = new FrameStatistics()
    let timestamp = 1000
    for (let frame = 0; frame < 20; frame += 1) {
      statistics.recordFrame(frame === 19 ? 9 : 1, timestamp)
      timestamp += 1000 / 60
    }

    const snapshot = statistics.snapshot(timestamp)
    expect(snapshot.worstFrameMilliseconds).toBe(9)
    expect(snapshot.lastFrameMilliseconds).toBe(9)
    // One slow frame in twenty is the 5% tail, which is exactly what p95 excludes.
    expect(snapshot.ninetyFifthPercentileFrameMilliseconds).toBe(1)
  })

  it('includes an outlier in the 95th percentile once it is more than 5% of frames', () => {
    const statistics = new FrameStatistics()
    let timestamp = 1000
    for (let frame = 0; frame < 20; frame += 1) {
      statistics.recordFrame(frame >= 18 ? 9 : 1, timestamp)
      timestamp += 1000 / 60
    }

    expect(statistics.snapshot(timestamp).ninetyFifthPercentileFrameMilliseconds).toBe(9)
  })

  it('keeps counting frames beyond the ring buffer without growing it', () => {
    const statistics = new FrameStatistics()
    const lastTimestamp = recordSteadyFrames(statistics, 5_000, 1000 / 60)
    const snapshot = statistics.snapshot(lastTimestamp)

    expect(snapshot.renderedFrameCount).toBe(5_000)
    expect(snapshot.framesPerSecond).toBe(60)
  })

  it('starts over after a reset', () => {
    const statistics = new FrameStatistics()
    const lastTimestamp = recordSteadyFrames(statistics, 30, 1000 / 60)
    statistics.reset()

    const snapshot = statistics.snapshot(lastTimestamp)
    expect(snapshot.framesPerSecond).toBe(0)
    expect(snapshot.renderedFrameCount).toBe(0)
    expect(snapshot.isIdle).toBe(true)
  })
})

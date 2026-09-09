const FRAME_SAMPLE_CAPACITY = 180
/** Frames the rate and the percentile are computed over. */
const RECENT_FRAME_WINDOW = 60
/**
 * Gaps longer than this are not treated as slow frames.
 *
 * Rendering is dirty-flag driven, so the interval between two rendered frames can be
 * arbitrarily long — a second of stillness, then one frame when a page tile arrives. Such
 * a gap says nothing about how fast frames are produced during interaction, so it is
 * excluded from the rate rather than averaged into it.
 */
const MAXIMUM_CONTINUOUS_FRAME_GAP_MILLISECONDS = 250
/** No frame for this long means the workspace is idle, not slow. */
const IDLE_THRESHOLD_MILLISECONDS = 1000

export type FrameStatisticsSnapshot = {
  /**
   * Frames per second while frames are being produced, derived from the intervals between
   * recent frames rather than by counting frames in a trailing wall-clock second.
   *
   * Counting over a trailing window makes the number decay as it drains when interaction
   * stops, which reads as a collapsing frame rate when nothing has slowed down at all.
   * Interval-based, it simply holds the rate of the last burst of work.
   */
  framesPerSecond: number
  /** True when nothing has been redrawn recently; the other figures then describe the last burst. */
  isIdle: boolean
  lastFrameMilliseconds: number
  worstFrameMilliseconds: number
  ninetyFifthPercentileFrameMilliseconds: number
  renderedFrameCount: number
}

/**
 * Rolling frame timing over a fixed-size ring buffer, so measuring the frame rate never
 * allocates and never grows during a long pan.
 */
export class FrameStatistics {
  private readonly frameDurations = new Float32Array(FRAME_SAMPLE_CAPACITY)
  private readonly frameTimestamps = new Float64Array(FRAME_SAMPLE_CAPACITY)
  private readonly sortScratch = new Float32Array(RECENT_FRAME_WINDOW)

  private writeIndex = 0
  private sampleCount = 0
  private renderedFrameCount = 0
  private lastFrameMilliseconds = 0

  recordFrame(durationMilliseconds: number, timestampMilliseconds: number): void {
    this.frameDurations[this.writeIndex] = durationMilliseconds
    this.frameTimestamps[this.writeIndex] = timestampMilliseconds
    this.writeIndex = (this.writeIndex + 1) % FRAME_SAMPLE_CAPACITY
    this.sampleCount = Math.min(this.sampleCount + 1, FRAME_SAMPLE_CAPACITY)
    this.renderedFrameCount += 1
    this.lastFrameMilliseconds = durationMilliseconds
  }

  reset(): void {
    this.writeIndex = 0
    this.sampleCount = 0
    this.renderedFrameCount = 0
    this.lastFrameMilliseconds = 0
  }

  snapshot(nowMilliseconds: number): FrameStatisticsSnapshot {
    if (this.sampleCount === 0) {
      return {
        framesPerSecond: 0,
        isIdle: true,
        lastFrameMilliseconds: 0,
        worstFrameMilliseconds: 0,
        ninetyFifthPercentileFrameMilliseconds: 0,
        renderedFrameCount: 0,
      }
    }

    const recentCount = Math.min(this.sampleCount, RECENT_FRAME_WINDOW)
    let continuousGapTotal = 0
    let continuousGapCount = 0
    let worstFrameMilliseconds = 0

    // Walk backwards from the newest frame, which is where the interesting work is.
    for (let offset = 0; offset < recentCount; offset += 1) {
      const sampleIndex = this.sampleIndexFromNewest(offset)
      const duration = this.frameDurations[sampleIndex]
      worstFrameMilliseconds = Math.max(worstFrameMilliseconds, duration)
      this.sortScratch[offset] = duration

      if (offset + 1 < recentCount) {
        const previousIndex = this.sampleIndexFromNewest(offset + 1)
        const gap = this.frameTimestamps[sampleIndex] - this.frameTimestamps[previousIndex]
        if (gap > 0 && gap <= MAXIMUM_CONTINUOUS_FRAME_GAP_MILLISECONDS) {
          continuousGapTotal += gap
          continuousGapCount += 1
        }
      }
    }

    const sortedDurations = this.sortScratch.subarray(0, recentCount)
    sortedDurations.sort()
    const percentileIndex = Math.max(0, Math.ceil(recentCount * 0.95) - 1)

    const newestTimestamp = this.frameTimestamps[this.sampleIndexFromNewest(0)]

    return {
      framesPerSecond:
        continuousGapCount > 0
          ? Math.round(1000 / (continuousGapTotal / continuousGapCount))
          : 0,
      isIdle: nowMilliseconds - newestTimestamp > IDLE_THRESHOLD_MILLISECONDS,
      lastFrameMilliseconds: this.lastFrameMilliseconds,
      worstFrameMilliseconds,
      ninetyFifthPercentileFrameMilliseconds: sortedDurations[percentileIndex],
      renderedFrameCount: this.renderedFrameCount,
    }
  }

  private sampleIndexFromNewest(offset: number): number {
    return (this.writeIndex - 1 - offset + FRAME_SAMPLE_CAPACITY * 2) % FRAME_SAMPLE_CAPACITY
  }
}

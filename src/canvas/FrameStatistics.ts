const FRAME_SAMPLE_CAPACITY = 180

export type FrameStatisticsSnapshot = {
  framesPerSecond: number
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
  private readonly sortScratch = new Float32Array(FRAME_SAMPLE_CAPACITY)

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
    let framesInLastSecond = 0
    let worstFrameMilliseconds = 0

    for (let sampleIndex = 0; sampleIndex < this.sampleCount; sampleIndex += 1) {
      if (nowMilliseconds - this.frameTimestamps[sampleIndex] <= 1000) {
        framesInLastSecond += 1
        this.sortScratch[framesInLastSecond - 1] = this.frameDurations[sampleIndex]
        worstFrameMilliseconds = Math.max(worstFrameMilliseconds, this.frameDurations[sampleIndex])
      }
    }

    const sortedDurations = this.sortScratch.subarray(0, framesInLastSecond)
    sortedDurations.sort()
    const percentileIndex = Math.max(0, Math.ceil(framesInLastSecond * 0.95) - 1)

    return {
      framesPerSecond: framesInLastSecond,
      lastFrameMilliseconds: this.lastFrameMilliseconds,
      worstFrameMilliseconds,
      ninetyFifthPercentileFrameMilliseconds: framesInLastSecond > 0 ? sortedDurations[percentileIndex] : 0,
      renderedFrameCount: this.renderedFrameCount,
    }
  }
}

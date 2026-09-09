/**
 * Coalesces every render request in a frame into a single `requestAnimationFrame`
 * callback. Nothing renders unless something marked itself dirty, so an idle workspace
 * costs zero GPU work while an active drag still gets exactly one frame per vsync.
 */
export class RenderScheduler {
  private readonly renderFrame: (timestampMilliseconds: number) => void
  private animationFrameHandle = 0
  private isStopped = false

  constructor(renderFrame: (timestampMilliseconds: number) => void) {
    this.renderFrame = renderFrame
  }

  requestFrame(): void {
    if (this.isStopped || this.animationFrameHandle !== 0) {
      return
    }
    this.animationFrameHandle = requestAnimationFrame(this.handleAnimationFrame)
  }

  get hasPendingFrame(): boolean {
    return this.animationFrameHandle !== 0
  }

  stop(): void {
    this.isStopped = true
    if (this.animationFrameHandle !== 0) {
      cancelAnimationFrame(this.animationFrameHandle)
      this.animationFrameHandle = 0
    }
  }

  private readonly handleAnimationFrame = (timestampMilliseconds: number): void => {
    this.animationFrameHandle = 0
    if (this.isStopped) {
      return
    }
    this.renderFrame(timestampMilliseconds)
  }
}

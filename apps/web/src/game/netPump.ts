// Keeps an online client's net session ticking while its page draws no frames.
//
// The page steps the PlayFlow from requestAnimationFrame. Chrome stops rAF in a hidden, minimised or fully
// occluded window (two game windows on one machine: the one behind), and throttles its main-thread timers to
// 1 Hz. A peer that stops ticking stops sending inputs, and every other peer of the round stalls once it is
// maxPrediction (16) ticks ahead: measured over the real relay, a peer frozen for 10 s gave the focused
// peer 667 stalled frames (frozen screen, then a jump) instead of 0.
//
// A dedicated worker's timers are not throttled with the page, so a worker posts a beat every 16 ms; when
// no rAF frame ran for GAP_MS the beat steps the flow itself (no drawing, idle controls). Where a worker
// cannot start (a CSP without blob: workers), nothing changes.

const GAP_MS = 100
const BEAT_MS = 16
const MAX_STEP_S = 0.1

export class NetPump {
  private worker: Worker | null = null
  private url: string | null = null
  private lastFrameMs: number
  private lastStepMs: number
  private pumpedSinceFrame = false
  /** Beats that stepped the flow because no frame ran (shown on the net diagnostics line). */
  pumped = 0

  private readonly step: (dtS: number) => void
  private readonly now: () => number

  constructor(step: (dtS: number) => void, now: () => number = () => performance.now()) {
    this.step = step
    this.now = now
    this.lastFrameMs = this.lastStepMs = now()
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') return
    try {
      this.url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${BEAT_MS})`], { type: 'text/javascript' }))
      this.worker = new Worker(this.url)
      this.worker.onmessage = () => this.beat()
      this.worker.onerror = () => this.dispose()
    } catch {
      this.dispose()
    }
  }

  get running(): boolean {
    return this.worker !== null
  }

  /**
   * Called by the rAF frame before it steps the flow: returns the dt to step with. After pumped beats it is
   * only the time since the last pumped step, so the time the beats already stepped is not stepped twice.
   */
  frame(dtS: number): number {
    const t = this.now()
    let dt = dtS
    if (this.pumpedSinceFrame) dt = Math.max(0, Math.min(dtS, (t - this.lastStepMs) / 1000))
    this.pumpedSinceFrame = false
    this.lastFrameMs = this.lastStepMs = t
    return dt
  }

  private beat(): void {
    const t = this.now()
    if (t - this.lastFrameMs < GAP_MS) return
    const dt = Math.min(MAX_STEP_S, Math.max(0, (t - this.lastStepMs) / 1000))
    this.lastStepMs = t
    this.pumpedSinceFrame = true
    this.pumped++
    this.step(dt)
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
    if (this.url !== null) URL.revokeObjectURL(this.url)
    this.url = null
  }
}

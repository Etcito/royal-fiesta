// Frame pacing of the page loop and the FPS counter (Graphics settings: MAMA's frameRate and showFps).
// The loop runs on requestAnimationFrame, which fires at the display refresh (144 times a second on a 144 Hz screen).
// With a cap, a callback that comes before the next frame's due time is skipped: frames are paced off rAF timestamps
// only (never a timer), and the due time advances by the cap's interval, so a 144 Hz display averages 60 frames a
// second. The simulations step on their own fixed tick from the accumulated frame time, so the cap never changes them.

// Frame interval of the 60 fps cap, ms.
export const CAP60_MS = 1000 / 60
// A callback up to this early still renders: rAF timestamps jitter around the refresh (keep it under half of the
// shortest refresh interval in use, 4.2 ms at 240 Hz).
const EARLY_MS = 2

// Decides, per rAF timestamp, whether a frame renders; `interval()` is the cap's frame interval (0 = every callback).
export class FramePacer {
  private due = -Infinity
  private readonly interval: () => number

  constructor(interval: () => number) {
    this.interval = interval
  }

  shouldRender(now: number): boolean {
    const step = this.interval()
    if (!(step > 0)) {
      this.due = -Infinity
      return true
    }
    if (now < this.due - EARLY_MS) return false
    // A late frame keeps the schedule (the average stays at the cap). An early one pulls the schedule back by at most
    // half the tolerance, so a display slightly faster than the cap (60.05 Hz) never drifts out of it and drops a
    // frame. Far behind (a hidden tab, a long frame): restart from now instead of rendering a burst.
    const base = now - this.due > step ? now : now < this.due ? Math.max(now, this.due - EARLY_MS / 2) : this.due
    this.due = base + step
    return true
  }
}

// The frame interval of a frameRate option value: 'vmax' renders every display refresh, anything else is capped at 60.
export function frameInterval(frameRate: unknown): number {
  return frameRate === 'vmax' ? 0 : CAP60_MS
}

// A small frames-per-second counter in the top-right corner, over the game and its menus; updated twice a second
// from the rendered frames.
export class FpsCounter {
  private el: HTMLElement | null = null
  private frames = 0
  private since = 0
  private readonly parent: HTMLElement

  constructor(parent: HTMLElement) {
    this.parent = parent
  }

  setVisible(visible: boolean): void {
    if (visible === (this.el !== null)) return
    if (!visible) {
      this.el?.remove()
      this.el = null
      return
    }
    const el = this.parent.ownerDocument.createElement('div')
    el.id = 'fps'
    el.style.cssText = 'position:fixed;top:6px;right:8px;z-index:50;pointer-events:none;padding:2px 6px;border-radius:4px;'
      + 'font:600 12px/1.2 ui-monospace,monospace;color:#fff;background:rgba(0,0,0,0.45)'
    el.textContent = '-- fps'
    this.parent.appendChild(el)
    this.el = el
    this.frames = 0
    this.since = 0
  }

  // One rendered frame at `now` (ms).
  frame(now: number): void {
    if (this.el === null) return
    if (this.since === 0) this.since = now
    this.frames++
    const elapsed = now - this.since
    if (elapsed < 500) return
    this.el.textContent = `${Math.round(this.frames * 1000 / elapsed)} fps`
    this.frames = 0
    this.since = now
  }

  dispose(): void {
    this.setVisible(false)
  }
}

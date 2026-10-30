// Netcode line under the lobby diagnostics line, while an online round runs: what the rollback session does
// each second. Read it as: pred = ticks predicted past the last confirmed one, rb/s and max = rollbacks and
// the deepest one, stall/s = frames the session waited for a peer (should be 0), rtt = round trip to the
// peers through the relay, delay = input delay ticks, fps = drawn frames, bg/s = steps made while the page
// drew nothing (NetPump: the window was hidden or behind another one).

export interface NetDiagStats {
  tick: number; confirmedTick: number; delay: number; rtt: Record<number, number>
  rollbacks: number; maxRollback: number; stallFrames: number; desyncs: number
}

const EVERY_MS = 1000

export class NetDiag {
  private el: HTMLElement | null = null
  private t0 = -1
  private frames = 0
  private base = { rollbacks: 0, stallFrames: 0, pumped: 0 }
  private text = ''

  /** One drawn frame (or a pumped step: drawn = false) of an online round. */
  sample(s: NetDiagStats, pumped: number, nowMs: number, drawn = true): void {
    if (drawn) this.frames++
    if (this.t0 < 0) {
      this.reset(s, pumped, nowMs)
      return
    }
    const span = nowMs - this.t0
    if (span < EVERY_MS) return
    const per = 1000 / span
    let rtt = 0
    for (const k in s.rtt) rtt = Math.max(rtt, s.rtt[k])
    this.show(`net tick ${s.tick} pred ${s.tick - s.confirmedTick} rb/s ${((s.rollbacks - this.base.rollbacks) * per).toFixed(0)} max ${s.maxRollback}`
      + ` stall/s ${((s.stallFrames - this.base.stallFrames) * per).toFixed(0)} rtt ${rtt.toFixed(0)}ms delay ${s.delay}`
      + ` fps ${(this.frames * per).toFixed(0)} bg/s ${((pumped - this.base.pumped) * per).toFixed(0)}${s.desyncs > 0 ? ` desyncs ${s.desyncs}` : ''}`)
    this.reset(s, pumped, nowMs)
  }

  /** Hides the line (no round). */
  clear(): void {
    this.t0 = -1
    this.show('')
  }

  dispose(): void {
    this.el?.remove()
    this.el = null
  }

  private reset(s: NetDiagStats, pumped: number, nowMs: number): void {
    this.t0 = nowMs
    this.frames = 0
    this.base.rollbacks = s.rollbacks
    this.base.stallFrames = s.stallFrames
    this.base.pumped = pumped
  }

  private show(text: string): void {
    if (text === this.text) return
    this.text = text
    if (typeof document === 'undefined') return
    if (this.el === null && text !== '') {
      const el = document.createElement('div')
      el.id = 'net-diag'
      el.style.cssText = 'position:fixed;left:6px;bottom:20px;z-index:9999;font:10px/1.3 monospace;color:#fff;opacity:.55;'
        + 'background:rgba(0,0,0,.35);padding:1px 4px;border-radius:3px;pointer-events:none;max-width:96vw;white-space:pre-wrap'
      document.body.appendChild(el)
      this.el = el
    }
    if (this.el !== null) {
      this.el.textContent = text
      this.el.style.display = text === '' ? 'none' : ''
    }
  }
}

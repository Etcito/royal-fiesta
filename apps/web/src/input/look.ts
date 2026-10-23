// PointerLook: pointer lock on the stage canvas and accumulated mouse deltas. The element
// comes from a callback because a quality change rebuilds the canvas. movementX is passed on
// unchanged: dx > 0 (mouse right) turns the view right through the orbit camera's yawTurn.
export class PointerLook {
  enabled = true
  // performance.now() of the last unlock; the Esc that released the lock lands just after it.
  unlockedAtMs = -Infinity
  private error: string | null = null
  private dx = 0
  private dy = 0
  private readonly win: Window
  private readonly element: () => Element | null
  private readonly onMouseDown: (e: MouseEvent) => void
  private readonly onMouseMove: (e: MouseEvent) => void
  private readonly onLockChange: () => void

  constructor(win: Window, element: () => Element | null) {
    this.win = win
    this.element = element
    this.onMouseDown = e => {
      const el = this.element()
      if (!this.enabled || el === null || e.target !== el || this.locked) return
      this.request(el)
    }
    this.onMouseMove = e => {
      if (!this.locked) return
      this.dx += e.movementX
      this.dy += e.movementY
    }
    this.onLockChange = () => {
      if (this.locked) return
      this.unlockedAtMs = this.win.performance.now()
      this.dx = 0
      this.dy = 0
    }
    win.addEventListener('mousedown', this.onMouseDown)
    win.addEventListener('mousemove', this.onMouseMove)
    win.document.addEventListener('pointerlockchange', this.onLockChange)
  }

  get locked(): boolean {
    const el = this.element()
    return el !== null && this.win.document.pointerLockElement === el
  }

  get lastError(): string | null {
    return this.error
  }

  takeDelta(): { dx: number; dy: number } {
    const out = { dx: this.dx, dy: this.dy }
    this.dx = 0
    this.dy = 0
    return out
  }

  release(): void {
    if (this.locked) this.win.document.exitPointerLock()
  }

  dispose(): void {
    this.win.removeEventListener('mousedown', this.onMouseDown)
    this.win.removeEventListener('mousemove', this.onMouseMove)
    this.win.document.removeEventListener('pointerlockchange', this.onLockChange)
    this.dx = 0
    this.dy = 0
  }

  // Chrome returns a promise (rejects e.g. right after an Esc unlock); older engines return void.
  private request(el: Element): void {
    try {
      const p = el.requestPointerLock() as unknown
      if (p instanceof Promise) p.catch((err: unknown) => { this.error = message(err) })
    } catch (err) {
      this.error = message(err)
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

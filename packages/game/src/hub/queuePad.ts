export type QueuePadEvent = 'idle' | 'arming' | 'armed' | 'cancel'

export class QueuePad {
  private readonly dwell: number
  private count = 0
  private armed = false

  constructor(dwellFrames = 90) {
    this.dwell = dwellFrames
  }

  update(onPad: boolean): QueuePadEvent {
    if (!onPad) {
      const was = this.armed
      this.count = 0
      this.armed = false
      return was ? 'cancel' : 'idle'
    }
    if (this.armed) return 'idle'
    this.count++
    if (this.count >= this.dwell) {
      this.armed = true
      return 'armed'
    }
    return 'arming'
  }
}

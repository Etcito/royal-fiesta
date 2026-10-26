// Startup spans use the page clock, including nested upload and render work.
export interface LoadSpan { step: string; start: number; end: number; ms: number }
let current: RoundLoad | null = null
let observed = false
const ready = new WeakMap<object, { course: string; painted: boolean }>()
let notify: (label: string | null) => void = () => {}
let report: Record<string, number | string | readonly string[]> = {}
const sims = new WeakMap<object, RoundLoad>()
const frames = new Map<object, RoundLoad>()
const reports = new WeakMap<object, Record<string, number | string | readonly string[]>>()
export function attachRoundReport(port: object, target: Record<string, number | string | readonly string[]>): void { reports.set(port, target) }
export function observeRoundLoad(next: typeof notify, target: typeof report): () => void {
  notify = next
  report = target
  observed = true
  return () => {
    if (notify !== next) return
    notify = () => {}
    report = {}
    observed = false
  }
}
export class RoundLoad {
  readonly spans: LoadSpan[] = []
  finished = false
  readonly label: string
  private readonly now: () => number
  constructor(label: string, now = () => performance.now()) { this.label = label; this.now = now }
  measure<T>(step: string, work: () => T): T {
    const start = this.now()
    const previous = current
    current = this
    notify(step)
    try { return work() } finally {
      const end = this.now()
      this.spans.push({ step, start, end, ms: end - start })
      current = previous
    }
  }
  finish(target = report): void {
    if (this.finished) return
    this.finished = true
    const history = target.roundTimeline
    target.roundTimeline = [...(Array.isArray(history) ? history : []), ...this.spans.map(s => JSON.stringify({ round: this.label, ...s }))]
    console.info(`[round] ${this.label}`)
    console.table(this.spans)
    notify(null)
  }
}
export function startup<T extends object>(label: string, work: () => T): T {
  const trace = new RoundLoad(label)
  const sim = trace.measure('Simulation start', work)
  sims.set(sim, trace)
  return sim
}
export function courseFrame(sim: object, port: object, course: string, work: () => void): void {
  let trace = sims.get(sim)
  if (!trace || trace.finished) { trace = new RoundLoad(course); sims.set(sim, trace) }
  trace.measure(`Course instances: ${course}`, work)
  frames.set(port, trace)
}
export function roundStep<T>(step: string, work: () => T): T { return current ? current.measure(step, work) : work() }
export function renderFrame<T>(port: object, work: () => T): T {
  const trace = frames.get(port)
  if (!trace) return work()
  frames.delete(port)
  try { return trace.measure('RAA render / pipeline compilation', work) } finally {
    ready.delete(port)
    trace.finish(reports.get(port))
  }
}

export function simStep<T>(sim: object, step: string, work: () => T): T {
  const trace = sims.get(sim)
  return trace ? trace.measure(step, work) : work()
}

// Give the loading backing a paint before replacing the hub with course instances.
export function roundReady(port: object, course: string): boolean {
  if (!observed || typeof requestAnimationFrame === 'undefined') return true
  const state = ready.get(port)
  if (state?.course === course) return state.painted
  const next = { course, painted: false }
  ready.set(port, next)
  notify(`Preparing course: ${course}`)
  requestAnimationFrame(() => { next.painted = true })
  return false
}

// Keep diagnostics available before the App and its screen callbacks exist. A load can
// overlap another load (e.g. an abandoned round and the returning lobby), so retain all waits.
interface CheckProgress {
  sequence?: number
  phase?: string
  lastAwaitedStep?: string
  awaitingSteps?: string[]
  [key: string]: unknown
}
const pending: { step: string }[] = []
function page() {
  return typeof window === 'undefined' ? null
    : window as Window & { __nmcCheck?: CheckProgress; __nmcGpuProgress?: string }
}
export function checkPhase(phase: string): void {
  const target = page()
  if (target === null) return
  const check = target.__nmcCheck ??= {}
  check.sequence = (check.sequence ?? 0) + 1
  check.phase = phase
  check.awaitingSteps = pending.map(wait => wait.step)
  target.__nmcGpuProgress = `${phase} [step ${check.sequence}]; awaiting: ${check.awaitingSteps.join(' > ') || 'none'}; last await: ${check.lastAwaitedStep ?? 'none'}`
}
export async function checkAwait<T>(step: string, work: () => Promise<T>): Promise<T> {
  const target = page()
  if (target === null) return await work()
  const check = target.__nmcCheck ??= {}
  const wait = { step }
  pending.push(wait)
  check.lastAwaitedStep = step
  checkPhase(check.phase ?? 'startup')
  try { return await work() } finally {
    pending.splice(pending.indexOf(wait), 1)
    checkPhase(check.phase ?? 'startup')
  }
}

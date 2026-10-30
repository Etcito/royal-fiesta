// The content loading report: progress while a GameContent loads, its refusal in full when it fails. No DOM: the uaa
// host shows the reported fraction and label on the 'loading' screen.
import type { LoadProgress } from '@royal-fiesta/game/content'

export interface LoadingReport {
  progress?(fraction: number, label: string): void
  // A refusal stays on screen until close(): it is never hidden.
  fail?(message: string): void
  close?(): void
}

export function loadingFraction(p: LoadProgress): number {
  if (p.phase === 'done') return 1
  return p.total > 0 ? Math.min(1, Math.max(0, p.done / p.total)) : 0
}

// The whole boot as one rising fraction (the Wavedash shell's bar, R3): each phase restarts done/total, so each
// gets its band; the boot's later steps (renderer, first frames) fill 0.85..1.
const PHASE_BANDS: Record<LoadProgress['phase'], readonly [number, number]> = {
  courses: [0.05, 0.15], assets: [0.15, 0.3], meshing: [0.3, 0.75], upload: [0.75, 0.85], done: [0.85, 0.85],
}

export function bootFraction(p: LoadProgress): number {
  const [from, to] = PHASE_BANDS[p.phase]
  return from + (to - from) * loadingFraction(p)
}

// The first argument is the former DOM root, ignored; it stays only so the main.ts callers compile until they are
// rewired onto the uaa host.
export function mountLoading(_root: unknown, report: LoadingReport = {}): { update(p: LoadProgress): void; fail(message: string): void; close(): void } {
  return {
    update(p) {
      report.progress?.(loadingFraction(p), p.label)
    },
    fail(message) {
      report.fail?.(message)
    },
    close() {
      report.close?.()
    },
  }
}

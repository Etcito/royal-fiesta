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

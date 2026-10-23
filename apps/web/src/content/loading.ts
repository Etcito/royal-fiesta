// The content loading overlay: progress while a GameContent loads, its refusal in full when it fails.
import type { LoadProgress } from '@royal-fiesta/game/content'
import { mountLoadingView } from '../screens/loading.ts'

export function mountLoading(root: HTMLElement): { update(p: LoadProgress): void; fail(message: string): void; close(): void } {
  const view = mountLoadingView(root)
  return {
    update(p) {
      view.update(p)
    },
    // Stays on screen until close(): a refusal is never hidden.
    fail(message) {
      view.fail(message)
    },
    close() {
      view.close()
    },
  }
}

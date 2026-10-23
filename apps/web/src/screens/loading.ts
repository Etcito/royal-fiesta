// The loading screen's DOM view: a progress bar and label from the latest LoadProgress, and
// the refusal message shown in full when the load fails (1.7: pages show refusals here).
// It reads no input: navigation reaches it only through Nav state (packages/game/src/screens).
import type { LoadProgress } from '@royal-fiesta/game/content'
import type { Nav } from '@royal-fiesta/game/screens/nav'
import { progressLine } from '@royal-fiesta/game/screens/menuModel'

export interface LoadingView {
  update(p: LoadProgress | null): void
  fail(message: string): void
  close(): void
}

// Bar fill in [0, 1]. A total of 0 (nothing to count yet) shows empty, 'done' shows full; never NaN.
export function progressFraction(p: LoadProgress | null): number {
  if (p === null) return 0
  if (p.phase === 'done') return 1
  if (!(p.total > 0) || !Number.isFinite(p.done)) return 0
  return Math.min(1, Math.max(0, p.done / p.total))
}

const FONT = 'system-ui, sans-serif'

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, css: string, parent: HTMLElement): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag)
  e.style.cssText = css
  parent.append(e)
  return e
}

export function mountLoadingView(root: HTMLElement): LoadingView {
  const doc = root.ownerDocument
  const box = el(doc, 'div', 'position: absolute; inset: 0; display: flex; flex-direction: column;' +
    ` align-items: center; justify-content: center; gap: 18px; background: #1b0f2e; color: #fff; font: bold 22px ${FONT};` +
    ' z-index: 10; padding: 24px; box-sizing: border-box;', root)
  box.dataset.screen = 'loading'
  el(doc, 'div', 'font-size: 56px; color: #ff6b9e;', box).textContent = 'Royal Fiesta'
  const track = el(doc, 'div', 'width: min(640px, 80vw); height: 18px; border-radius: 9px;' +
    ' background: rgba(255, 255, 255, 0.15); overflow: hidden;', box)
  track.setAttribute('role', 'progressbar')
  track.setAttribute('aria-valuemin', '0')
  track.setAttribute('aria-valuemax', '100')
  const bar = el(doc, 'div', 'height: 100%; width: 0%; background: #ff6b9e; transition: width 120ms linear;', track)
  const label = el(doc, 'div', 'font-size: 20px; opacity: 0.9; text-align: center;', box)
  // The refusal is text (never HTML), wrapped and scrollable so nothing of it is cut.
  const error = el(doc, 'pre', 'display: none; margin: 0; max-width: min(960px, 90vw); max-height: 60vh; overflow: auto;' +
    ` white-space: pre-wrap; overflow-wrap: anywhere; font: 18px ${FONT}; color: #ff4b4b;` +
    ' background: rgba(8, 8, 16, 0.78); padding: 16px; border-radius: 8px;', box)
  error.setAttribute('role', 'alert')

  const view: LoadingView = {
    update(p) {
      const pct = Math.round(progressFraction(p) * 100)
      bar.style.width = `${pct}%`
      track.setAttribute('aria-valuenow', String(pct))
      label.textContent = progressLine(p)
      track.style.display = ''
      error.style.display = 'none'
    },
    fail(message) {
      track.style.display = 'none'
      label.textContent = 'Loading failed'
      error.textContent = message
      error.style.display = ''
    },
    close() {
      box.remove()
    },
  }
  view.update(null)
  return view
}

// Shows the view for the loading state and for a failed load; returns false once neither applies
// (content loaded, or another error), so the caller may close it.
export function showLoadingFromNav(view: LoadingView, nav: Readonly<Nav>): boolean {
  if (nav.screen === 'loading') {
    view.update(nav.progress)
    return true
  }
  if (nav.screen === 'error' && nav.loadNext !== null && nav.error !== null) {
    view.fail(nav.error)
    return true
  }
  return false
}

// The named, visible shading state of the SDF content: what is still preparing, which texture bakes are running,
// and the first reason a part could not keep its field material. The page never fails silently: a part that cannot
// reach its field shading is named here (docs/brick-gaps.md keeps the renderer gaps).
export type ShadingStatusMode = 'field' | 'vertex' | 'baked'

export interface ShadingStatusReport {
  pending: number
  failed: number
  vertex: number
  errors: readonly string[]
}

export interface ShadingStatusSource {
  report(): ShadingStatusReport
  bakesLeft(): number
  mode(): ShadingStatusMode
}

const ELEMENT_ID = 'sdf-shading-status'
const REFRESH_MS = 500

// A part demoted by the field-atlas budget is an expected automatic fallback, not a visible error.
function atlasDemotion(error: string): boolean {
  return /atlas budget/i.test(error) || /texture\.atlas_full/i.test(error)
}

/**
 * The reasons of a shading report that are real failures: every named reason except the automatic fallbacks (an atlas
 * demotion, a part drawn vertex because the mode is vertex) and a field refusal MAMA saved with the part (`refused`
 * names those parts: they draw their mesh normals by design). A program that does not check or a shader that fails stays.
 */
export function hardShadingFailures(report: { errors: readonly string[]; refused?: readonly string[] }): string[] {
  const refused = report.refused ?? []
  return report.errors.filter(error => !atlasDemotion(error) && !error.endsWith(': vertex mode') &&
    !refused.some(key => error.startsWith(`${key}: `)))
}

/** The status line for a shading report and the texture bakes still running, or null when there is nothing to say. */
export function shadingStatusText(report: ShadingStatusReport, bakesLeft: number, mode: ShadingStatusMode = 'field'): string | null {
  if (report.pending > 0) return `SDF shading: preparing ${report.pending} parts`
  if (bakesLeft > 0) return `Baking textures (${bakesLeft} left)`
  const errors = report.errors.filter(error => !atlasDemotion(error))
  const failing = report.failed > 0 || (mode === 'field' && errors.length > 0)
  if (!failing) return null
  const parts = report.failed > 0 ? report.failed : errors.length
  const first = errors[0] ?? report.errors[0] ?? 'unknown error'
  return `SDF shading: ${parts} parts on vertex colours - ${first}`
}

/**
 * Mounts the fixed-position #sdf-shading-status role=status element, refreshed every 500 ms; it is hidden while the
 * formatter returns null. Returns the unmount function that stops the refresh and removes the element.
 */
export function mountShadingStatus(source: ShadingStatusSource): () => void {
  if (typeof document === 'undefined') return () => {}
  const previous = document.getElementById(ELEMENT_ID)
  previous?.remove()
  const element = document.createElement('div')
  element.id = ELEMENT_ID
  element.setAttribute('role', 'status')
  element.style.cssText = 'position: fixed; left: 12px; bottom: 12px; z-index: 30; max-width: 60ch; padding: 6px 10px; ' +
    'border-radius: 6px; background: rgba(0, 0, 0, 0.62); color: #fff; font: 12px/1.35 system-ui, sans-serif; ' +
    'pointer-events: none; white-space: pre-wrap'
  element.hidden = true
  document.body.append(element)
  const refresh = (): void => {
    const text = shadingStatusText(source.report(), source.bakesLeft(), source.mode())
    if (text === null) {
      element.textContent = ''
      element.hidden = true
      return
    }
    element.hidden = false
    element.textContent = text
  }
  refresh()
  const timer = setInterval(refresh, REFRESH_MS)
  return () => {
    clearInterval(timer)
    element.remove()
  }
}

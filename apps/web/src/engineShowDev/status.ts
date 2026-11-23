import type { ScriptReloadStatus } from './reload.ts'

/** The signal the status panel records once per update whose applies count grew. */
export const SCRIPT_APPLIED_SIGNAL = 'script-applied'

const LINE_LIMIT = 120
const DIAGNOSTIC_LIMIT = 5
const MODULE_KEY_LENGTH = 8
const PANEL_OFFSET = 584
const PANEL_TOP = 24
const PANEL_WIDTH = 560
const PANEL_PADDING = 44
const LINE_HEIGHT = 34
const TEXT_INSET = 20
const TEXT_TOP = 58

/** The canvas surface drawScriptStatus needs; a CanvasRenderingContext2D satisfies it. */
export interface ScriptStatusCanvas {
  font: string
  fillStyle: string
  fillRect(x: number, y: number, w: number, h: number): void
  fillText(text: string, x: number, y: number): void
}

/**
 * Handoff: `scriptStatusLines(status: ScriptReloadStatus, faults: number): string[]` and
 * `drawScriptStatus(context: ScriptStatusCanvas, lines: readonly string[], width: number): void`, exported by
 * apps/web/src/engineShowDev/status.ts, are called by 'Saved-script capture scenario: rejected edit kept, saved edit
 * applied in the current round' to compose the status panel onto its capture. That scenario passes the last
 * ScriptReloadStatus and the summed faults; today scriptStatusLines returns the panel lines in order, each cut to
 * 120 characters, and drawScriptStatus paints them top right on a canvas of the given width.
 */
export function scriptStatusLines(status: ScriptReloadStatus, faults: number): string[] {
  const lines = [
    `script: ${status.state}`,
    `generation ${status.generation} revision ${status.appliedRevision}`,
    `module ${status.moduleKey.slice(0, MODULE_KEY_LENGTH)}`,
    `faults ${faults}`,
  ]
  if (status.error !== null) lines.push(`error: ${status.error}`)
  for (const diagnostic of status.diagnostics.slice(0, DIAGNOSTIC_LIMIT)) lines.push(diagnostic)
  return lines.map(line => line.slice(0, LINE_LIMIT))
}

/** Paints a translucent panel at the top right of the canvas, then one white text line per entry. */
export function drawScriptStatus(context: ScriptStatusCanvas, lines: readonly string[], width: number): void {
  const left = width - PANEL_OFFSET
  context.font = '28px monospace'
  context.fillStyle = 'rgba(0,0,0,0.6)'
  context.fillRect(left, PANEL_TOP, PANEL_WIDTH, PANEL_PADDING + lines.length * LINE_HEIGHT)
  context.fillStyle = '#ffffff'
  lines.forEach((line, index) => context.fillText(line, left + TEXT_INSET, TEXT_TOP + index * LINE_HEIGHT))
}

/** Creates the DOM panel <pre id='script-status'> under root and returns its updater and recorded signals. */
export function createScriptStatus(root: HTMLElement): {
  update(status: ScriptReloadStatus, faults: number): void
  lines(): readonly string[]
  signals(): readonly string[]
  dispose(): void
} {
  const element = root.ownerDocument.createElement('pre')
  element.id = 'script-status'
  root.appendChild(element)
  let current: readonly string[] = []
  let applies = 0
  const recorded: string[] = []
  return {
    update(status, faults) {
      current = scriptStatusLines(status, faults)
      element.dataset.state = status.state
      element.textContent = current.join('\n')
      if (status.applies > applies) recorded.push(SCRIPT_APPLIED_SIGNAL)
      applies = status.applies
    },
    lines: () => current,
    signals: () => [...recorded],
    dispose() {
      element.remove()
    },
  }
}

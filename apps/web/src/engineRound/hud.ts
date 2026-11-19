import { CharMode } from '@royal-fiesta/sim/character/constants'
import type { RoundFacts } from './run.ts'

const MODE_NAMES = new Map<number, string>(Object.entries(CharMode).map(([name, value]) => [value, name]))

/**
 * Handoff: Engine round page: load, scene view, render bridge, composite and live mode calls
 * hudLines and drawRoundHud to composite the facts of a stepped round onto the #shot capture today.
 * The five HUD lines of E7, read from the round facts and the course name.
 */
export function hudLines(facts: RoundFacts, courseName: string): string[] {
  const mode = MODE_NAMES.get(facts.local.mode) ?? `mode ${facts.local.mode}`
  return [
    `${courseName} (${facts.kind})`,
    `tick ${facts.tick}  phase ${facts.phase}`,
    `alive ${facts.alive}  qualified ${facts.qualified}  eliminated ${facts.eliminated}`,
    `you: ${mode}`,
    `scripts: faults ${facts.faults}`,
  ]
}

/** Draws a readable band at the top left; width and height bound the band. */
export function drawRoundHud(ctx: CanvasRenderingContext2D, lines: readonly string[], width: number, height: number): void {
  ctx.font = 'bold 28px sans-serif'
  let widest = 0
  for (const line of lines) widest = Math.max(widest, ctx.measureText(line).width)
  const bandWidth = Math.min(widest + 48, width - 24)
  const bandHeight = Math.min(36 * lines.length + 32, height - 24)
  ctx.fillStyle = 'rgba(20, 16, 40, 0.72)'
  ctx.fillRect(24, 24, bandWidth, bandHeight)
  ctx.fillStyle = '#ffffff'
  ctx.textBaseline = 'top'
  lines.forEach((line, k) => ctx.fillText(line, 48, 40 + 36 * k))
}

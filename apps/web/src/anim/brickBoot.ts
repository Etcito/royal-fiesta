import { loadAnimBrick } from '@royal-fiesta/game/anim/brick'
import type { GameCaptureInput } from '../game/ops.ts'

// Visual boot only: nothing is placed in simulation state or player inputs.
const ready = loadAnimBrick()
// Surface failure even when no page op is called; awaiting ready still rejects the op.
void ready.catch(error => console.error('[animBrick] loading failed', error))
const DET_CASES = [[0, 0], [1, 60], [305419896, 600]] as const

type Capture = {
  json: { captures: { nonEmpty: boolean }[]; [key: string]: unknown }
  files: { name: string; blob: Blob }[]
}

function register(): void {
  const gpu = window.nmcGpu as NonNullable<Window['nmcGpu']> & {
    ops: { gameCapture(input: GameCaptureInput): Promise<Capture>; animBrick?: typeof animBrick }
  }
  if (typeof gpu?.ops.gameCapture !== 'function') throw new Error('animBrick requires the game page operations')

  // Use the existing game renderer and capture validation, preserving PNGs and nonEmpty records.
  async function animBrick(input: GameCaptureInput) {
    const brick = await ready
    const brickInfo = brick.brickInfo()
    const records = DET_CASES.map(([seed, ticks]) => brick.selftest('det-selftest', seed, ticks))
    const capture = await gpu.ops.gameCapture(input)
    return {
      ...capture,
      json: {
        ...capture.json, brickInfo, records,
        nonEmpty: capture.json.captures.length > 0 && capture.json.captures.every(c => c.nonEmpty),
      },
    }
  }
  gpu.ops.animBrick = animBrick
}

// Existing entry modules install their operations synchronously. Wait until all HTML modules
// have evaluated so their registration cannot replace this additive operation.
if (document.readyState !== 'complete') document.addEventListener('DOMContentLoaded', register, { once: true })
else register()

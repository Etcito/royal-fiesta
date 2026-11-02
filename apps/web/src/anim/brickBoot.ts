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

type GameOps = { gameCapture?(input: GameCaptureInput): Promise<Capture>; animBrick?: typeof animBrick }

// Refuses only when animBrick runs: at DOMContentLoaded the game's ops may still be loading
// (game/entry.ts imports main.ts dynamically), and a boot-time throw stops every other check op.
async function animBrick(input: GameCaptureInput) {
  const ops = window.nmcGpu?.ops as GameOps | undefined
  if (typeof ops?.gameCapture !== 'function') throw new Error('animBrick requires the game page operations')
  const brick = await ready
  const brickInfo = brick.brickInfo()
  const records = DET_CASES.map(([seed, ticks]) => brick.selftest('det-selftest', seed, ticks))
  const capture = await ops.gameCapture(input)
  return {
    ...capture,
    json: {
      ...capture.json, brickInfo, records,
      nonEmpty: capture.json.captures.length > 0 && capture.json.captures.every(c => c.nonEmpty),
    },
  }
}

function register(): void {
  const current = window.nmcGpu as { ops?: object } | undefined
  window.nmcGpu = { ...current, ops: Object.assign(current?.ops ?? {}, { animBrick }) } as unknown as NonNullable<Window['nmcGpu']>
}

// Existing entry modules install their operations synchronously. Wait until all HTML modules
// have evaluated so their registration cannot replace this additive operation.
if (document.readyState !== 'complete') document.addEventListener('DOMContentLoaded', register, { once: true })
else register()

import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { decodeInput, neutralInput } from '../input.ts'
import type { PlayerInput } from '../input.ts'
import { refuse } from '../refusal.ts'
import type { MatchLog } from './log.ts'
import { createMatchSim } from './matchSim.ts'
import type { MatchSim } from './matchSim.ts'
import type { MatchSetup } from './setup.ts'

export interface OfflineOptions {
  forcedRollback?: { every: number; back: number; fresh: boolean }
  maxTicks?: number
  humanCodes?: (tick: number, p: number) => number
}

export interface OfflineResult { log: MatchLog; finalHash: number; ticks: number; rollbacks: number }

const DEFAULT_MAX_TICKS = 108000

function positiveInt(v: number, path: string): void {
  if (!Number.isInteger(v) || v < 1) refuse('match', path, `got ${v}; pass an integer >= 1`)
}

export function runMatchOffline(R: RapierModule, setup: MatchSetup, opts: OfflineOptions = {}): OfflineResult {
  const maxTicks = opts.maxTicks ?? DEFAULT_MAX_TICKS
  positiveInt(maxTicks, 'runMatchOffline(opts.maxTicks)')
  const fr = opts.forcedRollback
  if (fr !== undefined) {
    positiveInt(fr.every, 'runMatchOffline(opts.forcedRollback.every)')
    positiveInt(fr.back, 'runMatchOffline(opts.forcedRollback.back)')
  }
  const humanCodes = opts.humanCodes
  const n = setup.playerCount
  // Reused every tick; inputs are a pure function of (tick, player), so a resim refills them.
  const inputs: PlayerInput[] = []
  for (let p = 0; p < n; p++) inputs.push(neutralInput())
  const fill = (tick: number): void => {
    for (let p = 0; p < n; p++) {
      const inp = inputs[p]
      if (setup.humans[p] && humanCodes !== undefined) {
        decodeInput(humanCodes(tick, p), inp)
      } else {
        inp.moveX = 0
        inp.moveZ = 0
        inp.jump = false
        inp.dive = false
        inp.grab = false
      }
    }
  }

  // ring[t % depth] holds the state before tick t runs; depth back+1 keeps t-back..t intact.
  const depth = fr === undefined ? 0 : fr.back + 1
  const ring: Uint8Array[] = new Array(depth)
  let sim: MatchSim = createMatchSim(R, setup)
  let rollbacks = 0
  try {
    while (!sim.done) {
      const t = sim.tick
      if (t >= maxTicks) refuse('match', 'runMatchOffline', `match did not finish in ${maxTicks} ticks; raise maxTicks or check the courses and bots`)
      if (fr !== undefined) ring[t % depth] = sim.world.takeSnapshotBytes()
      fill(t)
      sim.step(inputs)
      const now = t + 1
      if (fr === undefined || now % fr.every !== 0 || now < fr.back) continue
      const from = now - fr.back
      const bytes = ring[from % depth]
      if (fr.fresh) {
        const next = createMatchSim(R, setup)
        sim.free()
        sim = next
      }
      sim.world.restoreSnapshotBytes(bytes)
      sim.beginResim()
      for (let k = from; k < now; k++) {
        fill(k)
        sim.step(inputs)
      }
      sim.endResim()
      rollbacks++
    }
    const log = sim.log()
    return { log, finalHash: parseInt(log.finalHash, 16) >>> 0, ticks: sim.tick, rollbacks }
  } finally {
    sim.free()
  }
}

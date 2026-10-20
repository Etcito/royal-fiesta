// World-determinism smoke: two flat-floor worlds stay bit-identical, and restore + rerun matches.
// Used by `npm run smoke` and the project smoke `smoke:world-determinism`.
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { createFlatFloorWorld, flatFloorScript } from '@royal-fiesta/sim/scenarios/flatFloor'
import type { FiestaWorld } from '@royal-fiesta/sim/world'

const PLAYERS = 8
const SEED = 7
const TICKS = 600
const HASH_EVERY = 60
const SNAP_TICK = 300
const RESTORE_TICK = 400

function hex8(v: number): string {
  return (v >>> 0).toString(16).padStart(8, '0')
}

function stepTo(world: FiestaWorld<number>, inputs: number[], toTick: number): void {
  while (world.tick < toTick) {
    const tick = world.tick
    for (let p = 0; p < inputs.length; p++) inputs[p] = flatFloorScript(SEED, p, tick)
    world.step(inputs)
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function run(R: RapierModule, worlds: FiestaWorld<number>[]): string {
  const newWorld = (): FiestaWorld<number> => {
    const w = createFlatFloorWorld(R, { players: PLAYERS, seed: SEED })
    worlds.push(w)
    return w
  }
  const inputs = new Array<number>(PLAYERS).fill(0)

  const a = newWorld()
  const b = newWorld()
  for (let t = HASH_EVERY; t <= TICKS; t += HASH_EVERY) {
    stepTo(a, inputs, t)
    stepTo(b, inputs, t)
    if (a.stateHash() !== b.stateHash()) throw new Error(`hash mismatch at tick ${t}`)
  }
  const finalBytes = a.takeSnapshotBytes()
  if (!bytesEqual(finalBytes, b.takeSnapshotBytes())) throw new Error('final bytes differ')
  const finalHash = a.stateHash()

  const c = newWorld()
  stepTo(c, inputs, SNAP_TICK)
  const snap = c.takeSnapshotBytes()
  stepTo(c, inputs, RESTORE_TICK)
  const before = c.stateHash()
  c.restoreSnapshotBytes(snap)
  stepTo(c, inputs, RESTORE_TICK)
  const after = c.stateHash()
  if (before !== after) throw new Error(`restore hash ${hex8(before)} != ${hex8(after)}`)

  return `smoke: OK ticks=${TICKS} hash=${hex8(finalHash)} bytes=${finalBytes.length}`
}

const worlds: FiestaWorld<number>[] = []
let code = 0
try {
  const R = await initRapier()
  console.log(run(R, worlds))
} catch (e) {
  console.log(`smoke: FAIL ${e instanceof Error ? e.message : String(e)}`)
  code = 1
} finally {
  for (let i = 0; i < worlds.length; i++) worlds[i].free()
}
process.exit(code)

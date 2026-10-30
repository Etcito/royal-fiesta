import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fixtureResolver } from '@royal-fiesta/game/assets'
import { NullRenderPort } from '@royal-fiesta/game/render/nullPort'
import type { CharState } from '@royal-fiesta/sim/character/system'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import type { RemoteView } from '@royal-fiesta/game/hub/remotes'
import { HUB_STEP_S, HubView } from '../src/play/hubView.ts'

const ROOT = new URL('../../../', import.meta.url)
const resolver = fixtureResolver(async rel => readFileSync(new URL(rel, ROOT), 'utf8'))
const bean = (await resolver.resolve('bean')).asset
const plaza = { obstacles: [], mechanisms: undefined } as unknown as ResolvedCourse
const SPEED = 8

async function hubView(): Promise<HubView> {
  const port = new NullRenderPort()
  await port.init({ canvas: null, width: 64, height: 36, viewports: [{ x: 0, y: 0, width: 64, height: 36 }] })
  return new HubView(port, 0, () => bean, bean, plaza)
}

function walker(tick: number): CharState {
  const z = SPEED * tick * HUB_STEP_S
  return {
    pos: { x: 0, y: 0, z }, vel: { x: 0, y: 0, z: SPEED }, facing: { x: 0, z: 1 },
    mode: 0, grounded: true, groundObstacle: -1, knockbacks: 0, teleportTick: 0,
  }
}

// One window draws the walking bean as its own (local) at `hz`; another draws the same bean as a remote at
// 60 Hz. Returns the local stride at every tick a frame drew, and the remote stride after `seconds`.
async function walk(hz: number, seconds: number): Promise<{ ownStride: Map<number, number>; remote: number; covered: number }> {
  const own = await hubView()
  const other = await hubView()
  const ownStride = new Map<number, number>()
  let t = 0
  let acc = 0
  let tick = 0
  let lastOwn = 0
  let lastOther = 0
  let nextOwn = 0
  let nextOther = 0
  let first = -1
  let lastZ = 0
  const end = seconds * 1000
  while (t < end) {
    t += 0.25
    acc += 0.25
    while (acc >= HUB_STEP_S * 1000) { acc -= HUB_STEP_S * 1000; tick++ }
    if (t >= nextOwn) {
      nextOwn += 1000 / hz
      own.update(walker(tick), 0, [], tick, (t - lastOwn) / 1000)
      lastOwn = t
      ownStride.set(tick, (own as unknown as { localStride: number }).localStride)
    }
    if (t >= nextOther) {
      nextOther += 1000 / 60
      // The remote buffer's interpolated position (300 ms late), continuous in time.
      const z = Math.max(0, SPEED * (t - 300) / 1000)
      const r: RemoteView = { seat: 1, name: 'b', colour: 1, pos: { x: 0, y: 0, z }, yaw: 0, mode: 0, emote: 0, queued: false, inMatch: false, stale: false, spectator: false }
      other.update(walker(0), 0, [r], tick, (t - lastOther) / 1000)
      lastOther = t
      if (first < 0) first = z
      lastZ = z
    }
  }
  const remote = (other as unknown as { slots: Map<number, { stride: number }> }).slots.get(1)!.stride
  return { ownStride, remote, covered: lastZ - first }
}

test('hub walk phase: the own bean strides per hub tick, the same at 60, 75 and 144 Hz; a remote strides by metres covered', async () => {
  const runs = await Promise.all([60, 75, 144].map(hz => walk(hz, 3)))
  for (const run of runs) {
    for (const [tick, stride] of run.ownStride) {
      // Metres walked by that tick (the first drawn frame starts the count), whatever the display rate.
      const first = Math.min(...run.ownStride.keys())
      assert.ok(Math.abs(stride - SPEED * (tick - first) * HUB_STEP_S) < 1e-9, `stride ${stride} at tick ${tick}`)
    }
    assert.ok(Math.abs(run.remote - run.covered) < 1e-9, `remote stride ${run.remote} = metres covered ${run.covered}`)
  }
  // The same tick drawn by two displays has the same phase.
  const [a, , c] = runs
  let shared = 0
  for (const [tick, stride] of c.ownStride) {
    const other = a.ownStride.get(tick)
    if (other === undefined) continue
    shared++
    assert.ok(Math.abs(other - stride) < 1e-9)
  }
  assert.ok(shared > 100)
})

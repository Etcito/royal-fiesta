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

test('the lobby registers a skin and advances walking and emote bone poses on hub ticks', async () => {
  const { document: doc } = JSON.parse(readFileSync(new URL('assets/common/penguin.body.asset.json', ROOT), 'utf8'))
  const penguin = doc.nodes.penguin
  const port = new NullRenderPort()
  await port.init({ canvas: null, width: 64, height: 36, viewports: [{ x: 0, y: 0, width: 64, height: 36 }] })
  const view = new HubView(port, 0, () => bean, bean, plaza, { skinned: {
    assetId: 'penguin.skin', skin: { rig: penguin.rig, clips: penguin.clips, parts: [{ name: 'body', skin: { joints: new Uint16Array(4), weights: new Float32Array([1, 0, 0, 0]) } }] },
    graph: readFileSync(new URL('assets/common/penguin.animgraph.json', ROOT), 'utf8'),
  } })
  try {
    await view.animationReady()
    const idle = walker(0)
    idle.vel = { x: 0, y: 0, z: 0 }
    view.update(idle, 0, [], 0, HUB_STEP_S)
    const rest = new Float32Array(port.poseOf(0)!)
    for (let tick = 1; tick < 30; tick++) view.update(walker(tick), 0, [], tick, HUB_STEP_S)
    const walking = new Float32Array(port.poseOf(0)!)
    assert.notDeepEqual(walking, rest)
    for (let tick = 30; tick < 60; tick++) view.update(idle, 0, [], tick, HUB_STEP_S, 1)
    assert.notDeepEqual(port.poseOf(0), walking)
    const held = new Float32Array(port.poseOf(0)!)
    view.update(idle, 0, [], 59, 0, 1)
    assert.deepEqual(port.poseOf(0), held, 'drawing a paused tick does not advance its graph')
    view.update(idle, 1, [], 59, 0, 1)
    assert.deepEqual(port.poseOf(1), held, 'recolouring preserves the current animated pose')
    for (let tick = 0; tick < 15; tick++) view.update(walker(tick), 1, [], tick, HUB_STEP_S)
    assert.notDeepEqual(port.poseOf(1), held, 'returning to a new hub clock keeps animation advancing')
  } finally { view.dispose() }
  assert.equal(port.render().instances, 0)
})

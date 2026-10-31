import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { CHAR, CharMode, CarryKind } from '@royal-fiesta/sim/character/constants'
import { ACTION_LAYER, actionPose } from '../src/anim/actionPoses.ts'
import { WALK_LAYER, walkBones } from '../src/anim/walkCycle.ts'
import { POSE_LAYERS } from '../src/anim/layers.ts'
import { AnimDriver } from '../src/anim/driver.ts'
import type { CharObservation } from '../src/anim/params.ts'

const asset = JSON.parse(readFileSync(new URL('../../../assets/common/penguin.body.asset.json', import.meta.url), 'utf8'))
const node = asset.document.nodes.penguin
const rig = node.rig
const names = rig.bones.map((b: { name: string }) => b.name)
const bones = walkBones(names)
const rest = () => new Float32Array(rig.bones.flatMap((b: { rest: { t: number[]; r: number[]; s: number[] } }) =>
  [...b.rest.t, ...b.rest.r, ...b.rest.s]))
const obs = (mode: number, carry = 0, strokeTimer = 0): CharObservation =>
  ({ mode, carry, strokeTimer, vel: { x: 0, y: 0, z: 3 }, grounded: true, surface: 'normal', emote: 0 })
const pose = (mode: number, carry = 0, timer = 0) => {
  const out = new Float32Array(names.length * 4)
  actionPose(mode, carry, timer, out, bones)
  return out
}

test('action registration, distinct poses and snapshot stroke phases', () => {
  assert.deepEqual(POSE_LAYERS, [WALK_LAYER, ACTION_LAYER])
  const poses = [pose(CharMode.slide), ...[0.25, 0.5, 0.75].map(u =>
    pose(CharMode.slide, 0, (1-u)*CHAR.slide.strokeCooldownTicks)),
  pose(CharMode.swim, 0, CHAR.swim.strokeCooldownTicks/2), pose(CharMode.grabbing), pose(CharMode.ground, CarryKind.object)]
  for (let i = 0; i < poses.length; i++) {
    assert(poses[i].every(Number.isFinite))
    for (let j = 0; j < i; j++) assert.notDeepEqual(poses[i], poses[j])
    for (let q = 0; q < poses[i].length; q += 4) assert(Math.abs(Math.hypot(...poses[i].slice(q,q+4))-1) < 1e-6)
  }
  assert.deepEqual(pose(CharMode.grabbing, 0, 7), pose(CharMode.grabbing, 0, 0))
  assert.deepEqual(pose(CharMode.slide, 0, 0), pose(CharMode.slide, 0, CHAR.slide.strokeCooldownTicks))
})

test('walk mutes grounded swim and carry over six ticks and returns to ordinary locomotion', () => {
  for (const action of [obs(CharMode.swim), obs(CharMode.ground, CarryKind.object), obs(CharMode.slide), obs(CharMode.grabbing)]) {
    const walk = WALK_LAYER.create(names), layer = ACTION_LAYER.create(names)
    const ground = obs(CharMode.ground)
    for (let i = 0; i < 6; i++) walk.observe(ground)
    const walking = rest(); walk.apply(walking, ground)
    assert.notDeepEqual(walking, rest())
    for (let i = 0; i < 6; i++) { walk.observe(action); layer.observe(action) }
    const muted = rest(); walk.apply(muted, action)
    assert.deepEqual(muted, rest())
    const posed = rest(); layer.apply(posed, action)
    assert.notDeepEqual(posed, walking)
    for (let i = 0; i < 6; i++) { walk.observe(ground); layer.observe(ground) }
    const cleared = rest(); layer.apply(cleared, ground)
    assert.deepEqual(cleared, rest())
    walk.apply(cleared, ground); assert.notDeepEqual(cleared, rest())
  }
})

test('action weight reaches the target on six observations, apply is read-only, reset clears it', () => {
  const layer = ACTION_LAYER.create(names), snapshot = Object.freeze(obs(CharMode.grabbing))
  const target = pose(CharMode.grabbing)
  let previous = rest()
  for (let tick = 1; tick <= 6; tick++) {
    layer.observe(snapshot)
    const local = rest(); layer.apply(local, snapshot)
    assert.notDeepEqual(local, previous)
    const again = rest(); layer.apply(again, snapshot); assert.deepEqual(again, local)
    previous = local
  }
  for (const bone of Object.values(bones)) {
    for (let i = 0; i < 4; i++) assert(Math.abs(previous[bone*10+3+i] - target[bone*4+i]) < 1e-6)
  }
  layer.reset()
  const cleared = rest(); layer.apply(cleared, snapshot); assert.deepEqual(cleared, rest())
})

test('real driver action poses per sim tick are identical at 60, 144 and 175 Hz', async () => {
  const graph = readFileSync(new URL('../../../assets/common/penguin.animgraph.json', import.meta.url), 'utf8')
  const { bindings, smooth, ...preset } = rig
  const rigJson = JSON.stringify(preset)
  const sequence = Array.from({ length: 90 }, (_, tick) => ({ id: 1,
    ...obs(tick < 25 ? CharMode.slide : tick < 50 ? CharMode.swim : tick < 65 ? CharMode.grabbing : CharMode.ground,
      tick >= 65 && tick < 80 ? CarryKind.object : 0,
      tick < 25 ? Math.max(0, CHAR.slide.strokeCooldownTicks-tick) : Math.max(0, CHAR.swim.strokeCooldownTicks-(tick-25))) }))
  const run = async (hz: number) => {
    const driver = await AnimDriver.load(graph, rigJson, node.clips.map((c: unknown) => JSON.stringify(c)), { ik: false })
    const result: Float32Array[] = []
    try {
      let next = 0
      for (let frame = 0; next < sequence.length; frame++) {
        const tick = Math.min(sequence.length-1, Math.floor(frame*60/hz))
        while (next <= tick) {
          const snapshot = sequence[next], before = structuredClone(snapshot)
          driver.observeTick(next, [snapshot])
          result.push(driver.pose(1)!.skin.slice())
          assert.deepEqual(snapshot, before)
          next++
        }
        const before = driver.pose(1)!.skin.slice()
        driver.observeTick(tick, [sequence[tick]])
        assert.deepEqual(driver.pose(1)!.skin, before)
      }
    } finally { driver.dispose() }
    return result
  }
  const reference = await run(60)
  assert.deepEqual(await run(144), reference)
  assert.deepEqual(await run(175), reference)
})

test('CPU action sheet renders seven labelled panels at 1500 by 600', async () => {
  const { actionSheet } = await import('../../../tools/actionSheet.ts')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { default: sharp } = await import('sharp')
  const dir = await mkdtemp(join(tmpdir(), 'action-sheet-'))
  try {
    const file = join(dir, 'sheet.png')
    assert.deepEqual(await actionSheet(file), { width: 1500, height: 600 })
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    assert.equal(info.width, 1500); assert.equal(info.height, 600)
    for (let panel = 0; panel < 7; panel++) {
      const x = (panel % 4)*375, y = Math.floor(panel/4)*300
      for (let view = 0; view < 2; view++) {
        let silhouette = false
        for (let py = y+60; py < y+260 && !silhouette; py++) {
          for (let px = x+view*187+5; px < x+view*187+182; px++) {
            if (data[(py*info.width+px)*4] !== data[0]) { silhouette = true; break }
          }
        }
        assert(silhouette, `panel ${panel}, view ${view}`)
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

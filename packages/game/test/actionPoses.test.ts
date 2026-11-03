import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { CHAR, CharMode, CarryKind, SLIDE_STROKE, strokeStartTick, strokeTotalTicks } from '@royal-fiesta/sim/character/constants'
import { ACTION_LAYER, actionPose, strokeShape, strokeShapeAt } from '../src/anim/actionPoses.ts'
import { WALK_LAYER, walkBones } from '../src/anim/walkCycle.ts'
import { POSE_LAYERS } from '../src/anim/layers.ts'
import { AnimDriver } from '../src/anim/driver.ts'
import { pedallingSpeed } from '../src/anim/params.ts'
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
// The sim's slide strokeTimer at animation phase u: it counts down from strokeTotalTicks at the press.
const slideTimer = (u: number) => strokeTotalTicks(SLIDE_STROKE) - u*SLIDE_STROKE.animTicks
const pose = (mode: number, carry = 0, timer = 0) => {
  const out = new Float32Array(names.length * 4)
  actionPose(mode, carry, timer, out, bones)
  return out
}

test('action registration, distinct poses and snapshot stroke phases', () => {
  assert.deepEqual(POSE_LAYERS, [WALK_LAYER, ACTION_LAYER])
  const poses = [pose(CharMode.slide), ...[0.25, 0.5, 0.75].map(u =>
    pose(CharMode.slide, 0, slideTimer(u))),
  pose(CharMode.swim, 0, CHAR.swim.strokeCooldownTicks/2), pose(CharMode.grabbing), pose(CharMode.ground, CarryKind.object)]
  for (let i = 0; i < poses.length; i++) {
    assert(poses[i].every(Number.isFinite))
    for (let j = 0; j < i; j++) assert.notDeepEqual(poses[i], poses[j])
    for (let q = 0; q < poses[i].length; q += 4) assert(Math.abs(Math.hypot(...poses[i].slice(q,q+4))-1) < 1e-6)
  }
  assert.deepEqual(pose(CharMode.grabbing, 0, 7), pose(CharMode.grabbing, 0, 0))
  const glide = pose(CharMode.slide, 0, 0), done = pose(CharMode.slide, 0, slideTimer(1))
  glide.forEach((v, i) => assert(Math.abs(v - done[i]) < 1e-6))
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
    for (let i = 0; i < 12; i++) { walk.observe(ground); layer.observe(ground) }
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
      tick < 25 ? Math.max(0, strokeTotalTicks(SLIDE_STROKE)-tick) : Math.max(0, CHAR.swim.strokeCooldownTicks-(tick-25))) }))
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

test('ice pedalling advances feet faster than ground travel, dry walking keeps its speed', () => {
  const dry = obs(CharMode.ground)
  const ice = { ...dry, surface: 'ice' }
  assert.equal(pedallingSpeed(dry), 3)
  assert.ok(pedallingSpeed(ice) > 3)
  const walk = WALK_LAYER.create(names)
  walk.observe(ice)
  assert.equal(walk.state.speed, pedallingSpeed(ice))
})


test('breaststroke has a forward catch, a sweep back from the push start and a held glide', () => {
  const s = SLIDE_STROKE.startFrac
  const shape = (phase: number) => strokeShape(CharMode.slide, slideTimer(phase))
  assert.equal(shape(0).reach, 0)
  assert.equal(shape(0.8*s).reach, 1)
  assert.equal(shape(s).reach, 1)
  assert.equal(shape(s).power, 0)
  assert(shape(s + 0.4*(1-s)).power > 0.99)
  assert.equal(shape(s + 0.8*(1-s)).reach, 0)
  // The sim's observed phase and push start drive the shape (a tuned sim stays in sync).
  assert.deepEqual(strokeShape(CharMode.slide, 1, 0.3, 0.25), strokeShapeAt(0.3, 0.25))
  const glide = pose(CharMode.slide)
  for (const phase of [s + 0.8*(1-s), 0.95, 1]) {
    const p = pose(CharMode.slide, 0, slideTimer(phase))
    p.forEach((v,i) => assert(Math.abs(v-glide[i]) < 1e-6))
  }
  // Transform the flipper's outward axis: catch is forward (+Y), glide trails (-Y).
  for (const [phase, sign] of [[0,-1],[s,1]] as const) {
    const p=pose(CharMode.slide,0,slideTimer(phase))
    const q=bones.flipperL*4, [x,y,z,w]=p.slice(q,q+4)
    assert(sign*2*(x*y+z*w) > 0.8)
    assert(Math.abs(p[bones.flipperL*4+2]+p[bones.flipperR*4+2])<1e-6)
  }
})

test('belly contact, impact, surge and gradual stand are presentation only', () => {
  const layer=ACTION_LAYER.create(names)
  const apply=() => { const local=rest();layer.apply(local,obs(CharMode.slide));return local }
  for(let i=0;i<6;i++)layer.observe(obs(CharMode.dive))
  layer.observe(obs(CharMode.slide));const impact=apply()
  for(let i=0;i<12;i++)layer.observe(obs(CharMode.slide))
  const glide=apply(), r=bones.root*10
  assert(Math.abs(glide[r+1]+0.42)<1e-6)
  assert(impact[r+9]<glide[r+9])
  layer.observe(obs(CharMode.slide,0,slideTimer(0.7)))
  const surge=apply();assert(surge[r+8]>glide[r+8]+0.1)
  for(let i=0;i<6;i++)layer.observe(obs(CharMode.ground))
  const rising=apply();assert(rising[r+1]>glide[r+1]);assert(rising[r+1]<0)
  for(let i=0;i<6;i++)layer.observe(obs(CharMode.ground))
  assert.deepEqual(apply(),rest())
})

test('opposite slide turns bank in opposite directions and reset drops history', () => {
  const run=(sign:number)=>{
    const layer=ACTION_LAYER.create(names)
    for(let i=0;i<8;i++)layer.observe(obs(CharMode.slide))
    for(let i=1;i<=6;i++)layer.observe({...obs(CharMode.slide),vel:{x:sign*Math.sin(i*0.06)*5,y:0,z:Math.cos(i*0.06)*5}})
    const local=rest();layer.apply(local,obs(CharMode.slide));return local
  }
  const left=run(-1),right=run(1),r=bones.root*10
  assert(left[r+4]*right[r+4]<0)
  assert(Math.abs(left[r+4]+right[r+4])<1e-6)
})

// Flipper outward axis (+X) in the upright rig, angle in the sweep plane (degrees).
const flipperDeg = (timer: number) => {
  const p = pose(CharMode.slide, 0, timer), q = bones.flipperL*4, [x, y, z, w] = p.slice(q, q+4)
  return Math.atan2(2*(x*y+z*w), 1-2*(y*y+z*z))*180/Math.PI
}

test('each belly stroke is one wide flipper sweep, forward until the push starts, back after', () => {
  // The sim's slide strokeTimer per tick after a press: strokeTotalTicks, then one less per tick.
  const total = strokeTotalTicks(SLIDE_STROKE), start = strokeStartTick(SLIDE_STROKE)
  const glide = flipperDeg(0)
  const angles = Array.from({ length: total }, (_, e) => flipperDeg(total - e))
  const peak = Math.max(...angles)
  assert(peak - glide > 120, `stroke amplitude ${peak - glide} deg`)
  // Forward catch before the push, at its widest when the push starts, then swept back.
  assert(Math.abs(angles[start] - peak) < 1e-3, `at push start ${angles[start]} vs peak ${peak}`)
  for (let e = 1; e <= start; e++) assert(angles[e] >= angles[e-1] - 1e-6, `catch tick ${e}`)
  for (let e = start + 1; e < SLIDE_STROKE.animTicks; e++) assert(angles[e] <= angles[e-1] + 1e-6, `sweep tick ${e}`)
  assert(angles[start + 6] < peak - 30, 'the sweep back is under way while the push runs')
  // Glide again once the animation is over, while the push may still run.
  for (let e = SLIDE_STROKE.animTicks; e < total; e++) assert(Math.abs(angles[e] - glide) < 1e-3)
})

test('a belly stroke never lifts the body: root height and pitch stay those of the glide', () => {
  const layer = ACTION_LAYER.create(names), r = bones.root*10
  const apply = (timer: number) => { const local = rest(); layer.apply(local, obs(CharMode.slide, 0, timer)); return local }
  for (let i = 0; i < 12; i++) layer.observe(obs(CharMode.slide))
  const glide = apply(0)
  for (let e = 0; e < strokeTotalTicks(SLIDE_STROKE); e++) {
    const timer = strokeTotalTicks(SLIDE_STROKE) - e
    layer.observe(obs(CharMode.slide, 0, timer))
    const local = apply(timer)
    assert(Math.abs(local[r+1] - glide[r+1]) < 1e-6, `tick ${e}: root height ${local[r+1]} vs ${glide[r+1]}`)
    for (let i = 3; i < 7; i++) assert(Math.abs(local[r+i] - glide[r+i]) < 1e-6, `tick ${e}: root rotation`)
  }
})

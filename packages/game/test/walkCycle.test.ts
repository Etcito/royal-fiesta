import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import {
  applyWalkPose, newWalkState, restPose, stepWalk, walkBones, walkPose, WALK,
  type WalkPose, type WalkState,
} from '../src/anim/walkCycle.ts'

const read = (name: string) => readFileSync(new URL(`../../../assets/common/${name}`, import.meta.url), 'utf8')
const rig = JSON.parse(read('penguin.body.asset.json')).document.nodes.penguin.rig
const bones: { name: string; parent: string | null; rest: { t: number[]; r: number[]; s: number[] } }[] = rig.bones
const names = bones.map(b => b.name)
const restLocals = (): Float32Array => {
  const out = new Float32Array(names.length * 10)
  bones.forEach((b, i) => out.set([...b.rest.t, ...b.rest.r, ...b.rest.s], i * 10))
  return out
}
const stateAt = (phase: number, speed: number, ticks = 0): WalkState =>
  Object.assign(newWalkState(), { phase, speed, ticks })

const velocity = (t: number): { x: number; y: number; z: number } => {
  if (t < 20) return { x: 0, y: 0, z: 2.6 }
  if (t < 40) return { x: 1.2, y: 0, z: 0 }
  if (t < 55) return { x: 3, y: 0, z: 3 }
  return { x: 0, y: 0, z: 0.1 }
}
const groundedAt = (t: number): boolean => t < 30 || (t >= 50 && t < 60)

// (a) The same velocity sequence, sampled at different frame rates, gives the same pose per tick.
test('poses are a pure function of the tick state however frames sample it', () => {
  const dense: WalkPose[] = []
  const denseState = newWalkState()
  for (let t = 0; t < 90; t++) {
    stepWalk(denseState, velocity(t), groundedAt(t))
    dense.push(walkPose(denseState))
  }
  for (const every of [2, 3]) {
    const sparseState = newWalkState(), sampled = new Map<number, WalkPose>()
    for (let t = 0; t < 90; t++) {
      stepWalk(sparseState, velocity(t), groundedAt(t))
      if (t % every === 0) sampled.set(t, walkPose(sparseState))
    }
    for (const [t, pose] of sampled) {
      for (const key of Object.keys(pose) as (keyof WalkPose)[]) assert.equal(pose[key], dense[t][key], `tick ${t} every ${every}: ${key}`)
    }
  }
})

// (b) Flippers swing opposite to the legs at the walk speed.
test('flipper swing opposes the leg swing at phases 0.25 and 0.75', () => {
  for (const phase of [0.25, 0.75]) {
    const p = walkPose(stateAt(phase, WALK.walkSpeed, 10))
    assert.equal(Math.sign(p.flipperL), -Math.sign(p.legL), `left at ${phase}`)
    assert.equal(Math.sign(p.flipperR), -Math.sign(p.legR), `right at ${phase}`)
  }
})

// (c) restPose/idle flippers hang below their shoulders after FK (not the horizontal T rest pose).
function fkY(local: Float32Array): Map<string, number> {
  const y = new Map<string, number>()
  const q = new Map<string, number[]>()
  const rotate = (r: number[], v: number[]) => [
    (1 - 2 * (r[1] * r[1] + r[2] * r[2])) * v[0] + 2 * (r[0] * r[1] - r[2] * r[3]) * v[1] + 2 * (r[0] * r[2] + r[1] * r[3]) * v[2],
    2 * (r[0] * r[1] + r[2] * r[3]) * v[0] + (1 - 2 * (r[0] * r[0] + r[2] * r[2])) * v[1] + 2 * (r[1] * r[2] - r[0] * r[3]) * v[2],
    2 * (r[0] * r[2] - r[1] * r[3]) * v[0] + 2 * (r[1] * r[2] + r[0] * r[3]) * v[1] + (1 - 2 * (r[0] * r[0] + r[1] * r[1])) * v[2],
  ]
  const mul = (a: number[], b: number[]) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]
  for (const [i, b] of bones.entries()) {
    const o = i * 10, t = [local[o], local[o + 1], local[o + 2]], r = [local[o + 3], local[o + 4], local[o + 5], local[o + 6]]
    if (b.parent === null) { y.set(b.name, t[1]); q.set(b.name, r); continue }
    const p = b.parent, py = y.get(p)!, pq = q.get(p)!
    const w = rotate(pq, t)
    y.set(b.name, py + w[1])
    q.set(b.name, mul(pq, r))
  }
  return y
}
test('rest and idle poses keep the flipper tips below the shoulders', () => {
  const mapped = walkBones(names)
  for (const pose of [restPose(), walkPose(newWalkState()), walkPose(stateAt(0, 0, 37))]) {
    const local = restLocals()
    applyWalkPose(local, mapped, pose)
    const y = fkY(local)
    assert(y.get('lower.l')! < y.get('upper.l')! - 0.2, `lower.l ${y.get('lower.l')} upper.l ${y.get('upper.l')}`)
    assert(y.get('lower.r')! < y.get('upper.r')! - 0.2, `lower.r ${y.get('lower.r')} upper.r ${y.get('upper.r')}`)
  }
})

// (d) One +1 at each 0 crossing and one -1 at each 0.5 crossing, while grounded and moving.
test('footDown fires twice per stride and never below idleBelow', () => {
  const s = stateAt(0.9, 0, 0), events: number[] = []
  for (let t = 0; t < 60; t++) {
    stepWalk(s, { x: 0, y: 0, z: WALK.walkSpeed }, true)
    const f = walkPose(s).footDown
    if (f !== 0) events.push(f)
  }
  assert.deepEqual(events, [1, -1, 1, -1, 1, -1, 1])

  const slow = stateAt(0.9, 0, 0)
  for (let t = 0; t < 100; t++) {
    stepWalk(slow, { x: 0, y: 0, z: WALK.idleBelow * 0.5 }, true)
    assert.equal(walkPose(slow).footDown, 0)
  }
})

// (e) A rig missing a walk bone is refused with the anim area message.
test('walkBones refuses a missing bone', () => {
  const without = names.filter(n => n !== 'head')
  assert.throws(() => walkBones(without), (e: unknown) =>
    e instanceof RefusalError && /\[anim\] walkBones: bone 'head' missing;/.test(e.message))
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CharMode } from '@royal-fiesta/sim/character/constants'
import { AnimDriver, type CharacterPose } from '../src/anim/driver.ts'
import { loadAnimBrick } from '../src/anim/brick.ts'
import { VisualIk, toPoseFrame, type CharacterTransform, type IkTargets, type VisualPose } from '../src/anim/ik.ts'

const read = (name: string) => readFileSync(new URL(`../../../assets/common/${name}`, import.meta.url), 'utf8')
const node = JSON.parse(read('penguin.body.asset.json')).document.nodes.penguin
const { bindings, smooth, ...preset } = node.rig
const rigJson = JSON.stringify(preset), graphJson = read('penguin.animgraph.json')
const clipsJson = node.clips.map((clip: unknown) => JSON.stringify(clip))
const bones: string[] = preset.bones.map((b: { name: string }) => b.name)
const xf: CharacterTransform = Object.freeze({ pos: Object.freeze({ x: 2, y: 1, z: -3 }), facing: Object.freeze({ x: 1, z: 0 }) })

// The scene's placement (sceneView): world = pos + rotate([0, sin(yaw/2), 0, cos(yaw/2)], local).
function toWorld(v: readonly number[], t: CharacterTransform, direction = false) {
  const half = Math.atan2(t.facing.x, t.facing.z) / 2, qy = Math.sin(half), qw = Math.cos(half)
  const c = [qy * v[2], 0, -qy * v[0]], cc = [qy * c[2], 0, -qy * c[0]]
  const r = [v[0] + 2 * qw * c[0] + 2 * cc[0], v[1], v[2] + 2 * qw * c[2] + 2 * cc[2]]
  return direction ? { x: r[0], y: r[1], z: r[2] } : { x: t.pos.x + r[0], y: t.pos.y + r[1], z: t.pos.z + r[2] }
}
const at = (pose: { model: ArrayLike<number> }, bone: string) => {
  const o = bones.indexOf(bone) * 16 + 12
  return [pose.model[o], pose.model[o + 1], pose.model[o + 2]]
}
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const near = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 2e-4) => {
  assert.equal(a.length, b.length)
  for (let i = 0; i < a.length; i++) assert(Math.abs(a[i] - b[i]) <= eps, `index ${i}: ${a[i]} vs ${b[i]}`)
}
const boneModel = (pose: { model: Float32Array }, bone: string) => pose.model.subarray(bones.indexOf(bone) * 16, bones.indexOf(bone) * 16 + 16)
const finiteOut = (out: VisualPose) => {
  for (const a of [out.local, out.model, out.skin]) assert(a.length > 0 && a.every(Number.isFinite))
}

// A fresh graph pose for character 1, stepped once in the given mode.
async function graphPose(mode: number = CharMode.ground): Promise<CharacterPose> {
  const driver = await AnimDriver.load(graphJson, rigJson, clipsJson)
  try {
    driver.observeTick(1, [{ id: 1, mode, emote: 0, grounded: mode === CharMode.ground, vel: { x: 1, y: 0, z: 2 } }])
    return driver.pose(1)!
  } finally { driver.dispose() }
}

test('targets convert into the pose frame with the scene character transform', () => {
  for (const facing of [{ x: 0, z: 1 }, { x: 1, z: 0 }, { x: -0.6, z: -0.8 }, { x: 0, z: 0 }]) {
    const t = { pos: { x: -4, y: 2.5, z: 7 }, facing }
    for (const v of [[0, 0, 1], [0.3, -0.95, 0.15], [-2, 1, 0.5]]) {
      near(toPoseFrame(toWorld(v, t), t), v, 1e-9)
      near(toPoseFrame(toWorld(v, t, true), t, true), v, 1e-9)
    }
  }
  // Facing +X: the pose's forward (+Z) is world +X from the character's position.
  near(toPoseFrame({ x: 3, y: 1, z: -3 }, xf), [0, 0, 1], 1e-9)
})

test('the rig keeps its twelve bones and supplies the chains used', async () => {
  assert.deepEqual(bones, ['root', 'upper.l', 'lower.l', 'tip.l', 'upper.r', 'lower.r', 'tip.r',
    'upperLeg.l', 'foot.l', 'upperLeg.r', 'foot.r', 'head'])
  const api = await loadAnimBrick()
  assert.throws(() => VisualIk.create(api, JSON.stringify({ ...preset, ikChains: [] })), /flipperL/)
})

test('each correction activates only with its target; inactive ones leave the graph pose', async () => {
  const ik = VisualIk.create(await loadAnimBrick(), rigJson)
  try {
    const source = await graphPose(CharMode.grabbing)
    const none = ik.evaluate(source, xf, { mode: CharMode.grabbing, ground: null, grab: null, look: null })
    assert.deepEqual(none.active, { feet: false, hands: false, look: false })
    near(none.model, source.model); near(none.skin, source.skin); finiteOut(none)

    const look = ik.evaluate(source, xf, { mode: CharMode.ground, look: toWorld([2, 0.5, 1], xf) })
    assert.deepEqual(look.active, { feet: false, hands: false, look: true }); finiteOut(look)
    assert(dist(Array.from(boneModel(look, 'head')), Array.from(boneModel(source, 'head'))) > 1e-2)
    for (const bone of bones) if (bone !== 'head') near(boneModel(look, bone), boneModel(source, bone))

    const grab = toWorld([0, 0.35, 0.9], xf), target = [0, 0.35, 0.9]
    for (const targets of [{ mode: CharMode.ground, grab }, { mode: CharMode.grabbing, grab: { x: NaN, y: 0, z: 0 } }]) {
      const out = ik.evaluate(source, xf, targets)
      assert.equal(out.active.hands, false); near(out.model, source.model)
    }
    const hands = ik.evaluate(source, xf, { mode: CharMode.grabbing, grab })
    assert.deepEqual(hands.active, { feet: false, hands: true, look: false }); finiteOut(hands)
    for (const tip of ['tip.l', 'tip.r']) assert(dist(at(hands, tip), target) < dist(at(source, tip), target) - 0.05, tip)
    for (const bone of ['head', 'upperLeg.l', 'foot.r']) near(boneModel(hands, bone), boneModel(source, bone))

    const point = toWorld([0, -0.95, 0], xf), slope = toWorld([0.3, 1, 0], xf, true)
    for (const normal of [toWorld([0, -1, 0], xf, true), { x: 0, y: Infinity, z: 0 }]) {
      const out = ik.evaluate(source, xf, { mode: CharMode.ground, ground: { point, normal } })
      assert.equal(out.active.feet, false); near(out.model, source.model)
    }
    const feet = ik.evaluate(source, xf, { mode: CharMode.ground, ground: { point, normal: slope } })
    assert.deepEqual(feet.active, { feet: true, hands: false, look: false }); finiteOut(feet)
    // The ground descends toward +X: the left foot (+X) lowers, and both soles turn toward the normal.
    assert(at(feet, 'foot.l')[1] < at(source, 'foot.l')[1] - 1e-3)
    const n = [0.3, 1, 0].map(v => v / Math.hypot(0.3, 1)), up = (pose: { model: Float32Array }, bone: string) => {
      const m = boneModel(pose, bone), l = Math.hypot(m[4], m[5], m[6])
      return (m[4] * n[0] + m[5] * n[1] + m[6] * n[2]) / l
    }
    for (const foot of ['foot.l', 'foot.r']) assert(up(feet, foot) > up(source, foot) + 0.02, foot)
    for (const bone of ['root', 'head', 'tip.l']) near(boneModel(feet, bone), boneModel(source, bone))
  } finally { ik.dispose() }
})

test('evaluation never mutates the sim targets or the source pose, and never accumulates', async () => {
  const ik = VisualIk.create(await loadAnimBrick(), rigJson)
  try {
    const source = await graphPose(CharMode.grabbing)
    const saved = { model: source.model.slice(), skin: source.skin.slice() }
    const targets: IkTargets = Object.freeze({
      mode: CharMode.grabbing,
      ground: Object.freeze({ point: Object.freeze(toWorld([0, -0.95, 0], xf)), normal: Object.freeze(toWorld([-0.2, 1, 0.1], xf, true)) }),
      grab: Object.freeze(toWorld([0.1, 0.4, 0.8], xf)),
      look: Object.freeze(toWorld([-1, 0.8, 2], xf)),
    })
    const before = structuredClone(targets)
    const first = ik.evaluate(source, xf, targets)
    assert.deepEqual(first.active, { feet: true, hands: true, look: true }); finiteOut(first)
    assert.notStrictEqual(first.model, source.model); assert.notStrictEqual(first.skin, source.skin)
    for (let i = 0; i < 3; i++) {
      const again = ik.evaluate(source, xf, targets)
      assert.deepEqual(again.local, first.local); assert.deepEqual(again.skin, first.skin)
    }
    assert.deepEqual(source.model, saved.model); assert.deepEqual(source.skin, saved.skin)
    assert.deepEqual(targets, before)
    assert.deepEqual(xf, { pos: { x: 2, y: 1, z: -3 }, facing: { x: 1, z: 0 } })
    // A fresh graph pose evaluated after corrections comes back uncorrected without targets.
    const fresh = await graphPose(CharMode.grabbing)
    near(ik.evaluate(fresh, xf, { mode: CharMode.grabbing }).skin, fresh.skin)
    assert.deepEqual(ik.evaluate(fresh, xf, targets).skin, first.skin)
  } finally { ik.dispose() }
})

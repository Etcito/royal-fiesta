// Acceptance check for the climbUp task: the clip loads and samples on the game animation runtime from a hanging-compatible
// start (== hang tick 0 == grab end) through the recovery pose (== idle tick 0), flippers/hips/feet all move, no root motion, prior data intact.
// usage (repo root): node --experimental-strip-types proofs/m19/climb-up-check.mjs <original-asset.json>   (original = git show HEAD:assets/common/penguin.body.asset.json)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadRaaAnim } from '@etcito/raa-anim'
import { parseGameAsset } from '../../packages/game/src/gameAsset.ts'

const asset = JSON.parse(readFileSync('assets/common/penguin.body.asset.json', 'utf8'))
await parseGameAsset(asset, 'assets/common/penguin.body.asset.json')
const prior = JSON.parse(readFileSync(process.argv[2], 'utf8')).document.nodes.penguin
const node = asset.document.nodes.penguin
assert.deepEqual(node.rig, prior.rig)
assert.deepEqual(node.clips.slice(0, prior.clips.length), prior.clips)
assert.deepEqual(node.clips.map((c) => c.name), [...prior.clips.map((c) => c.name), 'climbUp'])
const def = node.clips.at(-1)
assert.equal(def.lengthTicks, 72); assert.equal(def.loop, false); assert.equal(def.rootMotion, 'none')
assert.deepEqual(def.events, [])
const bones = new Set(node.rig.bones.map((b) => b.name))
assert(def.tracks.every((t) => bones.has(t.bone) && ['translation', 'rotation', 'scale'].includes(t.channel) && t.keys.every((k) => k.interp === 'BEZIER')))
const { bindings, smooth, ...preset } = node.rig
const names = preset.bones.map((b) => b.name), at = (n) => names.indexOf(n) * 10
const api = await loadRaaAnim(), rig = api.loadRig(JSON.stringify(preset))
const clips = new Map()
try {
  const load = (name) => { const c = api.loadClip(rig, JSON.stringify(node.clips.find((x) => x.name === name))); clips.set(name, c); return (t) => api.sampleClip(c, t) }
  const climb = load('climbUp'), hang = load('hang'), idle = load('idle')
  for (let t = 0; t <= def.lengthTicks * 2; t++) {
    const p = climb(t)
    assert.equal(p.skin.length, 12 * 16); assert(p.skin.every(Number.isFinite)); assert(p.local.every(Number.isFinite))
    assert(p.rootDelta.every((n) => n === 0), 'world displacement stays with the simulation')
  }
  const local = (t) => Array.from(climb(t).local)
  const diff = (a, b, from = 0, to = a.length) => Math.max(...a.slice(from, to).map((v, i) => Math.abs(v - b[from + i])))
  const bone = (a, b, n) => diff(a, b, at(n), at(n) + 10)
  const start = local(0), mid = local(34), top = local(46), end = local(def.lengthTicks)
  assert(diff(start, Array.from(hang(0).local)) < 1e-4, 'start == hang tick 0')
  assert(diff(Array.from(climb(0).skin), Array.from(hang(0).skin)) < 1e-4, 'start skin == hang skin')
  assert(diff(end, Array.from(idle(0).local)) < 1e-4, 'recovery == idle tick 0')
  assert.deepEqual(local(def.lengthTicks), local(def.lengthTicks + 20), 'clamps on the recovery pose')
  const move = (bonesOf, a, b) => Math.max(...bonesOf.map((n) => bone(a, b, n)))
  const flippers = ['upper.l', 'lower.l', 'upper.r', 'lower.r'], hips = ['root'], feet = ['upperLeg.l', 'upperLeg.r', 'foot.l', 'foot.r']
  const reach = { flippers: move(flippers, start, mid), hips: move(hips, start, top), feet: move(feet, start, mid) }
  assert(reach.flippers > 0.3 && reach.hips > 0.1 && reach.feet > 0.2, JSON.stringify(reach))
  let rootMax = 0, step = 0
  for (let t = 0; t <= def.lengthTicks; t++) {
    const l = local(t); rootMax = Math.max(rootMax, Math.abs(l[1]), Math.abs(l[0]), Math.abs(l[2]))
    if (t) step = Math.max(step, diff(l, local(t - 1)))
  }
  assert(rootMax < 0.2, `root translation is a pose offset, not displacement (${rootMax})`)
  assert(step < 0.08, `pose changes smoothly tick to tick (${step})`)
  console.log(JSON.stringify({ ok: true, startVsHangDiff: diff(start, Array.from(hang(0).local)), endVsIdleDiff: diff(end, Array.from(idle(0).local)), reach, rootTranslationMax: rootMax, maxTickStep: step, keys: def.tracks.reduce((n, t) => n + t.keys.length, 0) }))
} finally { for (const c of clips.values()) c.free?.(); rig.free() }

// Acceptance check for task 5617: grab and hang load/sample on the existing rig, differ visibly, and prior data is intact.
// usage (repo root): node --experimental-strip-types proofs/m19/grab-hang-check.mjs <original-asset.json>   (original = git show HEAD:assets/common/penguin.body.asset.json)
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
assert.deepEqual(node.clips.map((c) => c.name), [...prior.clips.map((c) => c.name), 'grab', 'hang'])
const { bindings, smooth, ...preset } = node.rig
const api = await loadRaaAnim(), rig = api.loadRig(JSON.stringify(preset))
const idx = (n) => preset.bones.findIndex((b) => b.name === n) * 10
const sample = new Map(), defs = new Map(node.clips.map((c) => [c.name, c]))
try {
  for (const name of ['grab', 'hang']) {
    const def = defs.get(name), clip = api.loadClip(rig, JSON.stringify(def))
    try {
      for (let t = 0; t <= def.lengthTicks * 2; t++) {
        const p = api.sampleClip(clip, t)
        assert.equal(p.skin.length, 12 * 16); assert(p.skin.every(Number.isFinite)); assert(p.rootDelta.every((n) => n === 0))
      }
      sample.set(name, (t) => api.sampleClip(clip, t).local.slice())
      sample.get(name).skin = (t) => api.sampleClip(clip, t).skin.slice()
    } finally { /* clip freed at end */ }
    const lens = { grab: [24, false], hang: [48, true] }[name]
    assert.equal(def.lengthTicks, lens[0]); assert.equal(def.loop, lens[1]); assert.equal(def.rootMotion, 'none')
  }
  const grab = sample.get('grab'), hang = sample.get('hang')
  const upperL = idx('upper.l') + 3, upperR = idx('upper.r') + 3
  const diff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])))
  // grab reaches: both flippers move far from rest (identity-ish at tick 0) by the end of the reach
  for (const s of [upperL, upperR]) {
    const a = grab(0).slice(s, s + 4), b = grab(14).slice(s, s + 4)
    assert(diff(a, b) > 0.3, `flipper ${s} must reach (${a} -> ${b})`)
  }
  assert(diff(grab(0), grab(14)) > 0.3, 'grab must move the body')
  // grab ends where hang starts, hang loop seam is continuous, hang is sustained (small motion), grab differs from sustained hang
  assert(diff(grab(24), hang(0)) < 1e-4, 'grab end == hang start')
  assert.deepEqual(hang(0), hang(48)); assert.deepEqual(hang.skin(0), hang.skin(48))
  const hangRange = Math.max(...[12, 24, 36].map((t) => diff(hang(0), hang(t))))
  assert(hangRange < 0.2, `hang must stay a sustained pose (range ${hangRange})`)
  const grabVsHang = Math.max(diff(grab(0), hang(0)), diff(grab(6), hang(0)), diff(grab(14), hang(0)))
  assert(grabVsHang > 0.3, 'grab must differ visibly from sustained hang')
  const wholeMotion = diff(grab(6), hang(0))
  console.log(JSON.stringify({ ok: true, grabReach: diff(grab(0), grab(14)), hangSway: hangRange, grabVsHangMax: grabVsHang, crouchVsHang: wholeMotion, graspEndVsHangStart: diff(grab(24), hang(0)) }))
} finally { rig.free() }

// Asset acceptance on the game's pinned WASM runtime. Usage: node --experimental-strip-types
// proofs/m19/cheer-laugh-check.mjs <inherited-asset.json> [--clip=emote.cheer|emote.laugh]
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadRaaAnim } from '@etcito/raa-anim'
import { parseGameAsset } from '../../packages/game/src/gameAsset.ts'

const asset = JSON.parse(readFileSync('assets/common/penguin.body.asset.json', 'utf8'))
const original = JSON.parse(readFileSync(process.argv[2], 'utf8'))
await parseGameAsset(asset, 'assets/common/penguin.body.asset.json')
const node = asset.document.nodes.penguin, names = node.rig.bones.map(b => b.name)
const required = ['idle', 'waddle', 'run', 'jump', 'dive', 'bellySlide', 'handPush', 'grab', 'hang', 'climbUp', 'fall',
  'emote.wave', 'emote.dance', 'emote.cheer', 'emote.laugh']
assert.equal(node.clips.length, 15)
assert.equal(new Set(node.clips.map(c => c.name)).size, 15)
assert.deepEqual(node.clips.map(c => c.name).sort(), required.sort())
// Verify the entire inherited asset, including geometry, bindings, attachments and earlier clips.
const restored = structuredClone(asset)
restored.document.nodes.penguin.clips = restored.document.nodes.penguin.clips.slice(0, -2)
restored.hash = original.hash
assert.deepEqual(restored, original)
assert.equal(names.length, 12)
assert(!names.includes('jaw'), 'Q7 keeps the owner rig intact')
const { bindings, smooth, ...preset } = node.rig
const api = await loadRaaAnim(), rig = api.loadRig(JSON.stringify(preset)), handles = []
const report = { ok: true, inventory: node.clips.map(c => c.name), preservedInheritedAsset: true }
const only = process.argv.find(s => s.startsWith('--clip='))?.slice(7)
try {
  const clips = new Map(node.clips.map(c => {
    const h = api.loadClip(rig, JSON.stringify(c)); handles.push(h); return [c.name, h]
  }))
  const sample = (name, tick) => api.sampleClip(clips.get(name), tick)
  const at = (name, i) => names.indexOf(name) * 10 + i
  const diff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])))
  const range = (poses, name, i) => {
    const vs = poses.map(p => p.local[at(name, i)])
    return Math.max(...vs) - Math.min(...vs)
  }
  const rest = sample('idle', 0)
  for (const name of ['emote.cheer', 'emote.laugh'].filter(n => !only || only === n)) {
    const def = node.clips.find(c => c.name === name)
    assert.equal(def.loop, false); assert.equal(def.rootMotion, 'none')
    assert.deepEqual(def.events, [])
    assert(def.tracks.every(t => t.keys.every(k => k.interp === 'BEZIER')))
    const poses = Array.from({ length: def.lengthTicks + 1 }, (_, t) => sample(name, t))
    for (let t = 0; t <= def.lengthTicks * 2; t++) {
      const p = sample(name, t)
      for (const field of ['skin', 'local', 'model']) assert(p[field].every(Number.isFinite), `${name} ${field} ${t}`)
      assert.equal(p.skin.length, 12 * 16)
      assert(p.rootDelta.every(v => v === 0))
    }
    assert(diff(poses[0].local, rest.local) < 1e-4, `${name} starts at rest`)
    assert(diff(poses.at(-1).local, rest.local) < 1e-4, `${name} settles to rest`)
    assert.deepEqual(sample(name, def.lengthTicks + 50).skin, poses.at(-1).skin)
    const maxTickStep = Math.max(...poses.slice(1).map((p, i) => diff(p.local, poses[i].local)))
    assert(maxTickStep < 0.12, `${name} smooth per-tick poses: ${maxTickStep}`)
    const bounce = range(poses, 'root', 1), headPitch = range(poses, 'head', 3)
    if (name === 'emote.cheer') {
      const p = poses[44]
      const position = bone => Array.from(p.model.slice(names.indexOf(bone) * 16 + 12, names.indexOf(bone) * 16 + 15))
      const head = position('head'), l = position('tip.l'), r = position('tip.r')
      // Broad V: both tips are above the head pivot, on opposite sides, not crossed overhead.
      assert(l[1] > head[1] + 0.7 && r[1] > head[1] + 0.7, 'both flippers raised above head')
      assert(l[0] > 0.5 && r[0] < -0.5, 'broad raised-flipper celebration')
      assert(bounce > 0.13)
      assert(poses[44].local[1] > poses[32].local[1] + 0.09 && poses[68].local[1] > poses[56].local[1] + 0.09, 'two celebration pumps')
      report.cheer = { lengthTicks: def.lengthTicks, tipL: l, tipR: r, headPivot: head, bounce, maxTickStep }
    } else {
      assert(bounce > 0.06 && headPitch > 0.25, 'body bounce and head toss')
      const flipperShake = Math.min(range(poses, 'lower.l', 5), range(poses, 'lower.r', 5))
      assert(flipperShake > 0.1)
      for (const [up, down] of [[24, 32], [40, 48], [56, 64]]) {
        assert(poses[up].local[1] > poses[down].local[1] + 0.06, 'chuckle body bounce')
        assert(poses[up].local[at('head', 3)] < poses[down].local[at('head', 3)] - 0.15, 'head toss coordinated with bounce')
      }
      // The unchanged beak binding makes it follow the head rigidly, as Q7 requires.
      const beak = node.rig.bindings.find(b => b.source.shape === 'beak')
      assert.deepEqual(beak.bones, [{ bone: 'head', factor: 1 }])
      report.laugh = { lengthTicks: def.lengthTicks, bounce, headPitch, flipperShake, maxTickStep, beak: 'rigid head binding (Q7)' }
    }
  }
  // Every name in the completed S19 inventory loads and yields a finite pose.
  for (const def of node.clips) for (const tick of [0, Math.floor(def.lengthTicks / 2), def.lengthTicks]) {
    assert(sample(def.name, tick).skin.every(Number.isFinite), def.name)
  }
  console.log(JSON.stringify(report, null, 2))
} finally { for (const h of handles) h.free(); rig.free() }

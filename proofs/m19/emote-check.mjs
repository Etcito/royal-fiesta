// Acceptance check for the wave/dance task: both exact S19 clip names load and sample on the game animation runtime, the wave is a
// readable flipper greeting, the dance coordinates body and limbs and is distinct from the locomotion clips, prior data is intact.
// usage (repo root): node --experimental-strip-types proofs/m19/emote-check.mjs <original-asset.json>   (original = git show HEAD:assets/common/penguin.body.asset.json)
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
assert.deepEqual(node.clips.map((c) => c.name), [...prior.clips.map((c) => c.name), 'emote.wave', 'emote.dance'])
const bones = new Set(node.rig.bones.map((b) => b.name))
const defs = { wave: node.clips.at(-2), dance: node.clips.at(-1) }
assert.equal(defs.wave.loop, false); assert.equal(defs.dance.loop, true)
for (const d of Object.values(defs)) {
  assert.equal(d.lengthTicks, 96); assert.equal(d.rootMotion, 'none'); assert.deepEqual(d.events, [])
  assert(d.tracks.every((t) => bones.has(t.bone) && ['translation', 'rotation', 'scale'].includes(t.channel) && t.keys.every((k) => k.interp === 'BEZIER')))
}
const { bindings, smooth, ...preset } = node.rig
const names = preset.bones.map((b) => b.name), at = (n) => names.indexOf(n) * 10
const api = await loadRaaAnim(), rig = api.loadRig(JSON.stringify(preset))
const clips = []
try {
  const load = (name) => { const c = api.loadClip(rig, JSON.stringify(node.clips.find((x) => x.name === name))); clips.push(c); return (t) => api.sampleClip(c, t) }
  const wave = load('emote.wave'), dance = load('emote.dance'), idle = load('idle'), waddle = load('waddle'), run = load('run')
  const local = (f, t) => Array.from(f(t).local)
  const diff = (a, b, from = 0, to = a.length) => Math.max(...a.slice(from, to).map((v, i) => Math.abs(v - b[from + i])))
  const bone = (a, b, n) => diff(a, b, at(n), at(n) + 10)
  const range = (f, n, k, ticks) => { const v = ticks.map((t) => local(f, t)[at(n) + k]); return Math.max(...v) - Math.min(...v) }
  const ticks = Array.from({ length: 193 }, (_, i) => i)
  for (const [name, f] of [['wave', wave], ['dance', dance]]) for (const t of ticks) {
    const p = f(t)
    assert.equal(p.skin.length, 12 * 16, name); assert(p.skin.every(Number.isFinite)); assert(p.local.every(Number.isFinite))
    assert(p.rootDelta.every((n) => n === 0), 'world displacement stays with the simulation')
  }
  const rest = local(idle, 0), report = {}
  // ---- wave
  assert(diff(local(wave, 0), rest) < 1e-4, 'wave starts at the rest pose')
  assert(diff(local(wave, 96), rest) < 1e-4, 'wave ends at the rest pose')
  assert.deepEqual(local(wave, 96), local(wave, 150), 'wave clamps on its last pose')
  const w20 = local(wave, 20)
  const rUp = bone(w20, rest, 'upper.r'), lUp = bone(w20, rest, 'upper.l')
  assert(rUp > 0.4 && lUp < 0.1, `the right flipper greets, the left stays low (${rUp}, ${lUp})`)
  const swing = ticks.filter((t) => t <= 96).map((t) => local(wave, t)[at('lower.r') + 5])
  let reversals = 0
  for (let i = 2; i < swing.length; i++) if ((swing[i] - swing[i - 1]) * (swing[i - 1] - swing[i - 2]) < 0 && Math.abs(swing[i] - swing[i - 1]) > 1e-5) reversals++
  assert(reversals >= 4, `forearm waves side to side (${reversals} reversals)`)
  const waveRange = Math.max(...swing) - Math.min(...swing)
  assert(waveRange > 0.3, `wave swing amplitude ${waveRange}`)
  const headTurn = range(wave, 'head', 4, ticks.filter((t) => t <= 96))
  assert(headTurn > 0.1, `head turns toward the viewer (${headTurn})`)
  let waveStep = 0
  for (let t = 1; t <= 96; t++) waveStep = Math.max(waveStep, diff(local(wave, t), local(wave, t - 1)))
  assert(waveStep < 0.12, `wave changes smoothly tick to tick (${waveStep})`)
  report.wave = { rightFlipperLift: rUp, leftFlipperLift: lUp, forearmReversals: reversals, forearmSwing: waveRange, headTurn, maxTickStep: waveStep }
  // ---- dance
  const loop96 = ticks.filter((t) => t < 96)
  const seam = diff(local(dance, 95), local(dance, 96)), typical = Math.max(...loop96.slice(1).map((t) => diff(local(dance, t), local(dance, t - 1))))
  assert.deepEqual(local(dance, 96), local(dance, 0), 'loop seam closes exactly')
  assert(seam <= typical + 1e-6, `seam step ${seam} within the clip's own step range ${typical}`)
  const yawRange = range(dance, 'root', 4, loop96), bounceRange = range(dance, 'root', 1, loop96), sy = range(dance, 'root', 8, loop96)
  const flippers = Math.min(range(dance, 'upper.l', 5, loop96), range(dance, 'upper.r', 5, loop96))
  const knees = Math.min(range(dance, 'upperLeg.l', 3, loop96), range(dance, 'upperLeg.r', 3, loop96))
  const headRoll = range(dance, 'head', 5, loop96) + range(dance, 'head', 4, loop96)
  assert(yawRange > 0.25 && bounceRange > 0.08 && sy > 0.08, `body: yaw ${yawRange} bounce ${bounceRange} squash ${sy}`)
  assert(flippers > 0.4 && knees > 0.25 && headRoll > 0.2, `limbs: flippers ${flippers} knees ${knees} head ${headRoll}`)
  for (const [n, f] of [['waddle', waddle], ['run', run]]) {
    const loopLen = n === 'waddle' ? 48 : 24, ys = range(f, 'root', 4, Array.from({ length: loopLen }, (_, i) => i))
    assert(yawRange > 2.5 * ys, `dance yaw ${yawRange} well above ${n} yaw ${ys}`)
  }
  // distance to each locomotion loop at the best phase alignment, in mean per-component pose error
  const dist = (f, len) => { let best = Infinity
    for (let o = 0; o < len; o++) { let s = 0; for (let t = 0; t < 96; t++) { const a = local(dance, t), b = local(f, (t + o) % len); s += a.reduce((m, v, i) => m + Math.abs(v - b[i]), 0) / a.length } best = Math.min(best, s / 96) }
    return best }
  const dW = dist(waddle, 48), dR = dist(run, 24), dI = dist(idle, 120)
  const own = loop96.reduce((s, t) => s + local(dance, t).reduce((m, v, i) => m + Math.abs(v - rest[i]), 0) / rest.length, 0) / 96
  assert(Math.min(dW, dR, dI) > 0.02, `dance distinct from locomotion (${dW}, ${dR}, ${dI})`)
  let danceStep = 0
  for (let t = 1; t <= 96; t++) danceStep = Math.max(danceStep, diff(local(dance, t), local(dance, t - 1)))
  assert(danceStep < 0.12, `dance changes smoothly tick to tick (${danceStep})`)
  // wave vs dance: different gesture
  const wd = loop96.reduce((s, t) => s + local(wave, t).reduce((m, v, i) => m + Math.abs(v - local(dance, t)[i]), 0) / rest.length, 0) / 96
  assert(wd > 0.02, `wave and dance differ (${wd})`)
  report.dance = { rootYaw: yawRange, rootBounce: bounceRange, squash: sy, flipperRange: flippers, kneeRange: knees, headRange: headRoll, seamStep: seam, maxTickStep: danceStep,
    distanceToWaddle: dW, distanceToRun: dR, distanceToIdle: dI, meanDistanceFromRest: own, waveVsDance: wd }
  console.log(JSON.stringify({ ok: true, ...report, keys: [defs.wave, defs.dance].map((d) => d.tracks.reduce((n, t) => n + t.keys.length, 0)) }, null, 1))
} finally { for (const c of clips) c.free?.(); rig.free() }

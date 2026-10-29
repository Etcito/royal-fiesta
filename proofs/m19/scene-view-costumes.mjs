// Renders proofs/m19/penguin-costumes.mp4: the game's SceneView (packages/game/src/render/sceneView.ts) with
// the three SDF Modeler costumes mounted through the penguin rig's head, neck and body attach points. A real
// 8-player MatchSim drives the local player through locomotion, jump/dive actions and the S19 cheer/laugh
// emotes while every observed tick poses each character's own graph. The recording port keeps what SceneView
// submitted (instance transforms, setPose matrices, camera) and a CPU raster draws that state, so the video
// shows the port's view: the skinned character, costume.propeller-hat on head, costume.fish-scarf on neck and
// costume.pineapple-suit on body. The checks recompose each costume from the character placement, the posed
// bone model and the rig attachment and compare it with what SceneView submitted; a second sim run without a
// view proves costume drawing never changes simulation state. NO_VIDEO=1 runs the checks only.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { createMatchSim } from '@royal-fiesta/sim/match/matchSim'
import { neutralInput } from '@royal-fiesta/sim/input'
import { CharMode } from '@royal-fiesta/sim/character/constants'
import { parseGameAsset } from '@royal-fiesta/game/gameAsset'
import { fixtureResolver } from '../../packages/game/src/assets.ts'
import { matchCourses } from '../../packages/game/src/courseSet.ts'
import { netSetup } from '../../packages/game/src/net/tuning.ts'
import { NullRenderPort } from '../../packages/game/src/render/nullPort.ts'
import { SceneView } from '../../packages/game/src/render/sceneView.ts'

const W = 640, H = 400, FPS = 30, FRAMES = Number(process.env.FRAMES ?? 240)
const OUT = 'proofs/m19/penguin-costumes.mp4'
const STILL = 'proofs/m19/scene-view-costumes.png'
const SIDE = 'proofs/m19/scene-view-costumes-side-by-side.png'
const RECORD = 'proofs/m19/penguin-costumes.json'
const COSTUMES = [
  { slot: 'head', id: 'costume.propeller-hat' },
  { slot: 'neck', id: 'costume.fish-scarf' },
  { slot: 'body', id: 'costume.pineapple-suit' },
]
const read = async rel => readFileSync(rel, 'utf8')
const resolver = fixtureResolver(read)

// Courses and obstacle assets exactly as packages/game/test/sceneView.test.ts loads them.
const entries = readdirSync('fixtures/courses').filter(n => n.endsWith('.course.json')).sort()
  .map(n => ({ path: `fixtures/courses/${n}`, json: JSON.parse(readFileSync(`fixtures/courses/${n}`, 'utf8')) }))
const courses = await matchCourses(entries, resolver, 'sprint')
const assets = new Map()
for (const c of courses) for (const o of c.obstacles) if (!assets.has(o.asset)) assets.set(o.asset, (await resolver.resolve(o.asset)).asset)
const bean = (await resolver.resolve('bean')).asset

// The skinned penguin: S16 rig and S17 clips of the asset document, S18 joints/weights of its meshed body.
const buf = readFileSync('proofs/m19/penguin-fall-dive.glb')
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), jl = dv.getUint32(12, true)
const gltf = JSON.parse(buf.subarray(20, 20 + jl).toString('utf8')), bin = buf.subarray(28 + jl)
const accessor = id => {
  const a = gltf.accessors[id], b = gltf.bufferViews[a.bufferView]
  const n = a.count * { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type]
  const T = a.componentType === 5126 ? Float32Array : a.componentType === 5123 ? Uint16Array : a.componentType === 5121 ? Uint8Array : Uint32Array
  const off = (b.byteOffset ?? 0) + (a.byteOffset ?? 0)
  return new T(bin.buffer.slice(bin.byteOffset + off, bin.byteOffset + off + n * T.BYTES_PER_ELEMENT))
}
const prim = gltf.meshes[0].primitives[0], at = prim.attributes
const pos = accessor(at.POSITION), nor = accessor(at.NORMAL), col = accessor(at.COLOR_0)
const joints = Uint16Array.from(accessor(at.JOINTS_0)), weights = accessor(at.WEIGHTS_0), idx = accessor(prim.indices)
const colScale = col instanceof Float32Array ? 1 : col instanceof Uint8Array ? 1 / 255 : 1 / 65535
const NV = pos.length / 3, cstride = col.length / NV
const bodyJson = JSON.parse(readFileSync('assets/common/penguin.body.asset.json', 'utf8'))
const owner = bodyJson.document.nodes.penguin
const skinned = {
  assetId: bodyJson.id,
  skin: { rig: owner.rig, clips: owner.clips, parts: [{ name: 'penguin', skin: { joints, weights } }] },
  graph: readFileSync('assets/common/penguin.animgraph.json', 'utf8'),
}

// ---- costumes: mesh the committed SDF Modeler assets, keeping their anchors and material colours -------------
const meshNode = await import(new URL('../../apps/headless/src/mama/meshNode.ts', import.meta.url).href)
const linear = hex => [1, 3, 5].map(i => (parseInt(hex.slice(i, i + 2), 16) / 255) ** 2.2)
async function costumeGeometry({ id, slot }) {
  const cache = `/tmp/m19-${id}.cache.json`
  if (existsSync(cache)) {
    const c = JSON.parse(readFileSync(cache, 'utf8'))
    return { slot, id, prims: c.prims, pos: Float32Array.from(c.pos), nor: Float32Array.from(c.nor), col: Float32Array.from(c.col), idx: Uint32Array.from(c.idx) }
  }
  const path = `assets/common/${id}.asset.json`
  const json = JSON.parse(readFileSync(path, 'utf8'))
  const meshed = await meshNode.meshWholeAsset(await parseGameAsset(json, path), 55000)
  const cp = [], cn = [], cc = [], ci = []
  const colourOf = m => linear(String(json.document.materials[m]?.graph.nodes[0].params['in.base_color'] ?? '#808080'))
  const xf = (f, x, y, z) => [f[0] * x + f[4] * y + f[8] * z + f[12], f[1] * x + f[5] * y + f[9] * z + f[13], f[2] * x + f[6] * y + f[10] * z + f[14]]
  for (const group of meshed.data.groups) for (const part of group.parts) {
    for (const mesh of part.meshes) {
      const base = cp.length / 3, f = part.frame, c = colourOf(mesh.material)
      for (let v = 0; v < mesh.positions.length / 3; v++) {
        const p = xf(f, mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2])
        const n = xf(f, mesh.normals[v * 3], mesh.normals[v * 3 + 1], mesh.normals[v * 3 + 2])
        const l = Math.hypot(n[0], n[1], n[2]) || 1
        cp.push(...p); cn.push(n[0] / l, n[1] / l, n[2] / l); cc.push(...c)
      }
      for (const i of mesh.indices) ci.push(i + base)
    }
  }
  const prims = {
    format: 'raa.prims', version: 0, id, name: id, budget: { triangles: 0, segments: 0 },
    nodes: [], materials: {}, anchors: json.anchors, collision: { mode: 'override', colliders: [] },
  }
  writeFileSync(cache, JSON.stringify({ prims, pos: cp, nor: cn, col: cc, idx: ci }))
  return { slot, id, prims, pos: Float32Array.from(cp), nor: Float32Array.from(cn), col: Float32Array.from(cc), idx: Uint32Array.from(ci) }
}
const costumes = new Map()
for (const c of COSTUMES) costumes.set(c.slot, await costumeGeometry(c))
console.error(`costumes: ${COSTUMES.map(c => `${c.id}=${costumes.get(c.slot).idx.length / 3} tris`).join(', ')}`)

// Keeps what SceneView submits so the raster draws the port's state, not the sim's.
class RecordingPort extends NullRenderPort {
  names = new Map()
  inst = []
  cam = null
  registerAsset(name, asset) {
    const h = super.registerAsset(name, asset)
    this.names.set(h, name)
    return h
  }
  createInstance(asset, tint) {
    const h = super.createInstance(asset, tint)
    this.inst[h] = { name: this.names.get(asset), tint, t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1], visible: true }
    return h
  }
  setTransform(i, t, r, s) { super.setTransform(i, t, r, s); Object.assign(this.inst[i], { t: [...t], r: [...r], s: [...s] }) }
  setVisible(i, v) { super.setVisible(i, v); this.inst[i].visible = v }
  setCamera(v, cam) { super.setCamera(v, cam); this.cam = cam }
}

const R = await initRapier()
const setup = netSetup(7, 1, 'sprint', courses)
const sim = createMatchSim(R, setup)
const port = new RecordingPort()
await port.init({ canvas: null, width: W, height: H, viewports: [{ x: 0, y: 0, width: W, height: H }] })
const fit = 1
const costumeSet = {
  head: { asset: costumes.get('head').prims, scale: fit },
  neck: { asset: costumes.get('neck').prims, scale: fit },
  body: { asset: costumes.get('body').prims, scale: fit },
}
const camera = focus => ({ eye: [focus.x + 2.1, focus.y + 0.9, focus.z + 4.4], target: [focus.x, focus.y + 0.05, focus.z], fovYDeg: 45, near: 0.1, far: 120 })
const view = new SceneView({ port, viewport: 0, localPlayer: 0, bean, assets: n => assets.get(n), skinned, costumes: costumeSet, camera })
assert.equal(view.animationError, null)

// ---- independent S16 composition, used only to check what SceneView submitted --------------------------------
const m4 = (t, q, s) => {
  const [x, y, z, w] = q
  return new Float64Array([
    (1 - 2 * y * y - 2 * z * z) * s[0], (2 * x * y + 2 * z * w) * s[0], (2 * x * z - 2 * y * w) * s[0], 0,
    (2 * x * y - 2 * z * w) * s[1], (1 - 2 * x * x - 2 * z * z) * s[1], (2 * y * z + 2 * x * w) * s[1], 0,
    (2 * x * z + 2 * y * w) * s[2], (2 * y * z - 2 * x * w) * s[2], (1 - 2 * x * x - 2 * y * y) * s[2], 0,
    t[0], t[1], t[2], 1,
  ])
}
const mm = (a, b) => {
  const o = new Float64Array(16)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
  return o
}
const conj = q => [-q[0], -q[1], -q[2], q[3]]
const rig = owner.rig
const boneAt = new Map(rig.bones.map((b, i) => [b.name, i]))
const rest = new Float32Array(rig.bones.length * 16)
rig.bones.forEach((bone, i) => {
  const local = m4(bone.rest.t, bone.rest.r, bone.rest.s)
  const parent = bone.parent === null ? -1 : boneAt.get(bone.parent)
  rest.set(parent < 0 ? local : mm(rest.subarray(parent * 16, parent * 16 + 16), local), i * 16)
})
function rigidRotation(m) {
  let a00 = m[0], a10 = m[1], a20 = m[2], a01 = m[4], a11 = m[5], a21 = m[6], a02 = m[8], a12 = m[9], a22 = m[10]
  for (let i = 0; i < 8; i++) {
    const det = a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20) + a02 * (a10 * a21 - a11 * a20)
    if (!(Math.abs(det) > 1e-12)) break
    const d = 1 / det
    const b00 = (a11 * a22 - a12 * a21) * d, b01 = (a02 * a21 - a01 * a22) * d, b02 = (a01 * a12 - a02 * a11) * d
    const b10 = (a12 * a20 - a10 * a22) * d, b11 = (a00 * a22 - a02 * a20) * d, b12 = (a02 * a10 - a00 * a12) * d
    const b20 = (a10 * a21 - a11 * a20) * d, b21 = (a01 * a20 - a00 * a21) * d, b22 = (a00 * a11 - a01 * a10) * d
    a00 = 0.5 * (a00 + b00); a10 = 0.5 * (a10 + b01); a20 = 0.5 * (a20 + b02)
    a01 = 0.5 * (a01 + b10); a11 = 0.5 * (a11 + b11); a21 = 0.5 * (a21 + b12)
    a02 = 0.5 * (a02 + b20); a12 = 0.5 * (a12 + b21); a22 = 0.5 * (a22 + b22)
  }
  const sx = Math.hypot(a00, a10, a20) || 1, sy = Math.hypot(a01, a11, a21) || 1, sz = Math.hypot(a02, a12, a22) || 1
  const m00 = a00 / sx, m10 = a10 / sx, m20 = a20 / sx, m01 = a01 / sy, m11 = a11 / sy, m21 = a21 / sy, m02 = a02 / sz, m12 = a12 / sz, m22 = a22 / sz
  const trace = m00 + m11 + m22
  let x, y, z, w
  if (trace > 0) { const k = Math.sqrt(trace + 1) * 2; w = 0.25 * k; x = (m21 - m12) / k; y = (m02 - m20) / k; z = (m10 - m01) / k }
  else if (m00 > m11 && m00 > m22) { const k = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / k; x = 0.25 * k; y = (m01 + m10) / k; z = (m02 + m20) / k }
  else if (m11 > m22) { const k = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / k; x = (m01 + m10) / k; y = 0.25 * k; z = (m12 + m21) / k }
  else { const k = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / k; x = (m02 + m20) / k; y = (m12 + m21) / k; z = 0.25 * k }
  const n = Math.hypot(x, y, z, w) || 1
  return [x / n, y / n, z / n, w / n]
}
function expectedCostume(slot, bean, model, scale) {
  const attach = rig.attach[slot]
  const anchor = costumes.get(slot).prims.anchors[slot]
  const bone = boneAt.get(attach.bone)
  const pose = model === null ? rest.subarray(bone * 16, bone * 16 + 16) : model.subarray(bone * 16, bone * 16 + 16)
  const anchorInv = m4([-anchor.t[0], -anchor.t[1], -anchor.t[2]], conj(anchor.r), [1, 1, 1])
  const fitted = mm(m4([0, 0, 0], [0, 0, 0, 1], [scale, scale, scale]), anchorInv)
  const full = mm(mm(mm(m4(bean.t, bean.r, [1, 1, 1]), pose), m4(attach.t, attach.r, [1, 1, 1])), fitted)
  return m4([full[12], full[13], full[14]], rigidRotation(full), [1, 1, 1])
}
function maxDiff(a, b) {
  let d = 0
  for (let i = 0; i < 16; i++) d = Math.max(d, Math.abs(a[i] - b[i]))
  return d
}

// ---- real match: local player runs, jumps, dives, then plays cheer and laugh while the pack races -----------
const inputs = Array.from({ length: sim.setup.playerCount }, () => neutralInput())
const control = createMatchSim(R, setup)
const controlInputs = Array.from({ length: control.setup.playerCount }, () => neutralInput())
const batch = f => (f % 12 === 5 ? 4 : f % 12 === 6 ? 0 : 2)
const emoteAt = f => (f >= 110 && f < 160 ? 3 : f >= 160 && f < 205 ? 4 : 0)
function inputAt(f) {
  const i = neutralInput()
  if (f < 50) i.moveZ = 1
  if (f >= 56 && f < 60) i.jump = true
  if (f >= 68 && f < 74) i.dive = true
  return i
}
const frames = [], stepped = []
let handles = new Map()
let driver = null, emotePhase = 0, repeatedRenders = 0, posesOnRepeat = 0
const wait = () => new Promise(r => setTimeout(r, 10))
for (let f = 0; f < FRAMES; f++) {
  inputs[0] = inputAt(f)
  controlInputs[0] = inputAt(f)
  const n = batch(f)
  for (let k = 0; k < n; k++) {
    sim.step(inputs)
    control.step(controlInputs)
    stepped.push(sim.tick)
  }
  if (driver === null && view.anim) {
    driver = view.anim
    const observe = driver.observeTick.bind(driver)
    // S9 emote is a view-side graph input (the match carries none); the sim is only observed.
    driver.observeTick = (tick, chars) => {
      if (emotePhase !== 0) for (const c of chars) c.emote = emotePhase
      observe(tick, chars)
    }
  }
  if (driver === null) await wait()
  emotePhase = emoteAt(f)
  const poseCalls = port.calls.setPose
  view.update(sim, null, 1, 1 / FPS)
  if (n === 0 && driver !== null) {
    repeatedRenders++
    const before = snapshot(f)
    view.update(sim, null, 1, 1 / FPS)
    const after = snapshot(f)
    assert.deepEqual(after.wear, before.wear, `repeated render ${f} resubmits no costume transform`)
    posesOnRepeat += port.calls.setPose - poseCalls
  }
  frames.push(snapshot(f))
}
assert.ok(driver !== null, 'the animation driver loaded')
assert.equal(view.animationError, null)

function costumeHandles() {
  const out = new Map()
  for (const [h, inst] of port.inst.entries()) {
    if (COSTUMES.some(c => c.id === inst.name) && !out.has(inst.name)) out.set(inst.name, h)
  }
  return out
}
function snapshot(f) {
  if (handles.size === 0) handles = costumeHandles()
  const c = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 } }
  const chars = []
  for (let p = 0; p < sim.setup.playerCount; p++) {
    sim.character(p, c)
    const beanInst = port.inst[view.beans[p]]
    chars.push({ t: beanInst.t, r: beanInst.r, visible: beanInst.visible, mode: c.mode, x: c.pos.x, y: c.pos.y, z: c.pos.z })
  }
  const wear = COSTUMES.map(({ slot, id }) => {
    const h = handles.get(id)
    if (h === undefined) return { slot, id, instance: -1 }
    const inst = port.inst[h]
    return { slot, id, instance: h, t: [...inst.t], r: [...inst.r], s: [...inst.s], visible: inst.visible }
  })
  const models = [], skins = []
  for (let p = 0; p < sim.setup.playerCount; p++) {
    const pose = driver === null ? undefined : driver.pose(p)
    models.push(pose === undefined ? null : Float32Array.from(pose.model))
    skins.push(port.poseOf(view.beans[p]))
  }
  return { f, tick: sim.tick, cam: port.cam, chars, models, skins, model: models[0], wear }
}

// ---- checks -------------------------------------------------------------------------------------------------
const poseFrames = frames.filter(fr => fr.model !== null)
let restFrames = 0, worst = 0, emoteHeadMax = 0
const headRotations = new Set()
const distinctWear = new Set(frames.filter(fr => fr.tick > 0).map(fr => JSON.stringify(fr.wear.map(w => w.t.map(v => v.toFixed(3))))))
assert.equal(handles.size, 3, 'the local character wears all three costumes')
assert.equal(frames.at(-1).wear.length, 3)
assert.ok(poseFrames.length > Math.min(60, FRAMES / 4), `posed frames: ${poseFrames.length}`)
const slotWorst = { head: 0, neck: 0, body: 0 }
let bad = null
for (const fr of frames) {
  const bean = { t: fr.chars[0].t, r: fr.chars[0].r }
  for (const w of fr.wear) {
    assert.equal(w.visible, true, `frame ${fr.f}: ${w.id} visible with its character`)
    if (w.instance < 0) continue
    const want = expectedCostume(w.slot, bean, fr.model, fit)
    const diff = maxDiff(want, m4(w.t, w.r, w.s))
    if (diff > slotWorst[w.slot]) {
      slotWorst[w.slot] = diff
      bad = { frame: fr.f, slot: w.slot, diff, want: Array.from(want), got: Array.from(m4(w.t, w.r, w.s)), trs: { t: w.t, r: w.r, s: w.s } }
    }
    worst = Math.max(worst, diff)
  }
  if (fr.model === null) { restFrames++; continue }
  // The head costume orientation is the posed head bone's: count distinct head attitudes.
  const head = fr.model.subarray(boneAt.get('head') * 16, boneAt.get('head') * 16 + 16)
  headRotations.add(Array.from(head.subarray(0, 11), v => v.toFixed(3)).join(','))
  if (emoteAt(fr.f) !== 0) emoteHeadMax = Math.max(emoteHeadMax, Math.abs(head[5] - rest[boneAt.get('head') * 16 + 5]))
}
assert.ok(worst < 5e-4, `costume transforms match the composed bone attachment (max element error ${worst}; ${JSON.stringify({ slotWorst, bad })})`)
assert.ok(restFrames > 0, 'characters draw costumed at rest before the graph loads')
assert.ok(headRotations.size > 10, `head bone attitudes across the run: ${headRotations.size}`)
if (FRAMES >= 205) assert.ok(emoteHeadMax > 0.02, `emote head motion carried by the hat: ${emoteHeadMax}`)
assert.equal(posesOnRepeat, 0, 'a repeated render steps no graph and submits no pose')
assert.ok(distinctWear.size > Math.min(30, FRAMES / 4), `distinct costume placements: ${distinctWear.size}`)
// The same steps on a sim with no view: positions, modes and tick must match exactly.
const a = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 } }
const b = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 } }
assert.equal(sim.tick, control.tick, 'costume drawing never advances the simulation')
for (let p = 0; p < sim.setup.playerCount; p++) {
  sim.character(p, a); control.character(p, b)
  assert.deepEqual(a, b, `character ${p} state is untouched by costume drawing`)
}
view.dispose()
assert.equal(driver.disposed, true, 'dispose releases costumes and character graphs together')
sim.free()
control.free()

const record = {
  video: OUT, still: STILL, sideBySide: SIDE, frames: FRAMES, fps: FPS, simHz: 60,
  costumes: COSTUMES, characters: sim.setup.playerCount, localPlayer: 0,
  ticksStepped: stepped.length, poseFrames: poseFrames.length, restFrames,
  repeatedRenders, posesSubmittedOnRepeatedRenders: posesOnRepeat, setPoseCalls: port.calls.setPose,
  costumeInstances: handles.size, maxCostumeMatrixError: worst, distinctHeadAttitudes: headRotations.size,
  distinctCostumePlacements: distinctWear.size, emoteHeadMotion: emoteHeadMax,
  simStateIdenticalWithoutView: true,
  skin: 'proofs/m19/penguin-fall-dive.glb', asset: 'assets/common/penguin.body.asset.json',
  graph: 'assets/common/penguin.animgraph.json', raster: 'CPU preview of the RenderPort state (not a GPU capture)',
  presentation: 'costume scale 1; the preview draws costumes with a 0.35 m depth bias so the two independently meshed coarse surfaces do not z-fight',
  segments: [
    { from: 0, to: 50, name: 'run (locomotion)' },
    { from: 56, to: 74, name: 'jump / dive (actions)' },
    { from: 110, to: 160, name: 'emote.cheer (view-side S19 emote input)' },
    { from: 160, to: 205, name: 'emote.laugh (view-side S19 emote input)' },
  ],
}
console.log(JSON.stringify(record, null, 2))
if (process.env.NO_VIDEO) process.exit(0)

// ---- CPU raster of the recorded port state (no GPU): bodies from the posed bone models, costumes from the
// rigid instance transforms SceneView submitted ---------------------------------------------------------------
const rgb = new Uint8Array(W * H * 3), depth = new Float32Array(W * H)
const LIGHT = [0.35, 0.8, 0.45].map(c => c / Math.hypot(0.35, 0.8, 0.45))
const COSTUME_BIAS = 0.35
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l] }
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
function rotate(q, v) {
  const u = [q[0], q[1], q[2]], t = cross(u, v).map(c => 2 * c), c2 = cross(u, t)
  return [v[0] + q[3] * t[0] + c2[0], v[1] + q[3] * t[1] + c2[1], v[2] + q[3] * t[2] + c2[2]]
}
let viewCam = null
function setCamera(cam) {
  const f = norm(sub(cam.target, cam.eye)), r = norm(cross(f, [0, 1, 0])), u = cross(r, f)
  viewCam = { eye: cam.eye, f, r, u, focal: 1 / Math.tan(cam.fovYDeg * Math.PI / 360), near: cam.near }
}
function project(p, X, Y, Z, i) {
  const d = sub(p, viewCam.eye), z = dot(d, viewCam.f)
  X[i] = W / 2 + (dot(d, viewCam.r) / z) * viewCam.focal * (H / 2)
  Y[i] = H / 2 - (dot(d, viewCam.u) / z) * viewCam.focal * (H / 2)
  Z[i] = z
}
function triangle(a, b, c, X, Y, Z, C, bias = 0) {
  if (Z[a] < viewCam.near || Z[b] < viewCam.near || Z[c] < viewCam.near) return
  const area = (X[b] - X[a]) * (Y[c] - Y[a]) - (X[c] - X[a]) * (Y[b] - Y[a])
  if (area === 0) return
  const x0 = Math.max(0, Math.floor(Math.min(X[a], X[b], X[c]))), x1 = Math.min(W - 1, Math.ceil(Math.max(X[a], X[b], X[c])))
  const y0 = Math.max(0, Math.floor(Math.min(Y[a], Y[b], Y[c]))), y1 = Math.min(H - 1, Math.ceil(Math.max(Y[a], Y[b], Y[c])))
  for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
    const x = px + 0.5, y = py + 0.5
    const wa = ((X[b] - x) * (Y[c] - y) - (X[c] - x) * (Y[b] - y)) / area
    const wb = ((X[c] - x) * (Y[a] - y) - (X[a] - x) * (Y[c] - y)) / area
    const wc = 1 - wa - wb
    if (wa < 0 || wb < 0 || wc < 0) continue
    const z = wa * Z[a] + wb * Z[b] + wc * Z[c] - bias, o = py * W + px
    if (z >= depth[o]) continue
    depth[o] = z
    for (let k = 0; k < 3; k++) rgb[o * 3 + k] = Math.round(255 * Math.min(1, wa * C[a * 3 + k] + wb * C[b * 3 + k] + wc * C[c * 3 + k]) ** (1 / 2.2))
  }
}
// Ground: a checker grid at the local character's last grounded contact height (capsule centre - 0.85 m).
const G = 24, gx = new Float32Array((G + 1) ** 2), gy = new Float32Array(gx.length), gz = new Float32Array(gx.length)
let groundY = null
function ground(center) {
  const s = 2, ox = Math.round(center[0] / s) * s - G, oz = Math.round(center[2] / s) * s - G
  for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) project([ox + i * s, groundY, oz + j * s], gx, gy, gz, j * (G + 1) + i)
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const a = j * (G + 1) + i, odd = (i + j + Math.round(ox / s) + Math.round(oz / s)) & 1
    const c = odd ? [0.55, 0.62, 0.7] : [0.66, 0.72, 0.8], C = new Float32Array(12).map((_, k) => c[k % 3])
    const quad = [a, a + 1, a + G + 2, a + G + 1]
    const X = [], Y = [], Z = []
    for (let k = 0; k < 4; k++) { X.push(gx[quad[k]]); Y.push(gy[quad[k]]); Z.push(gz[quad[k]]) }
    triangle(0, 1, 2, X, Y, Z, C); triangle(0, 2, 3, X, Y, Z, C)
  }
}
const sx = new Float32Array(NV), sy = new Float32Array(NV), sz = new Float32Array(NV), shade = new Float32Array(NV * 3)
function character(ch, skin) {
  const tint = ch.tint ?? [1, 1, 1]
  for (let v = 0; v < NV; v++) {
    const p = [0, 0, 0], q = [0, 0, 0]
    if (skin === null) { p[0] = pos[v * 3]; p[1] = pos[v * 3 + 1]; p[2] = pos[v * 3 + 2]; q[0] = nor[v * 3]; q[1] = nor[v * 3 + 1]; q[2] = nor[v * 3 + 2] }
    else for (let k = 0; k < 4; k++) {
      const w = weights[v * 4 + k]; if (w === 0) continue
      const o = joints[v * 4 + k] * 16
      for (let r = 0; r < 3; r++) {
        p[r] += w * (skin[o + r] * pos[v * 3] + skin[o + 4 + r] * pos[v * 3 + 1] + skin[o + 8 + r] * pos[v * 3 + 2] + skin[o + 12 + r])
        q[r] += w * (skin[o + r] * nor[v * 3] + skin[o + 4 + r] * nor[v * 3 + 1] + skin[o + 8 + r] * nor[v * 3 + 2])
      }
    }
    const wp = rotate(ch.r, p), wn = norm(rotate(ch.r, q))
    const lam = Math.max(0, dot(wn, LIGHT))
    for (let c = 0; c < 3; c++) shade[v * 3 + c] = col[v * cstride + c] * colScale * tint[c] * (0.35 + 0.8 * lam)
    project([wp[0] + ch.t[0], wp[1] + ch.t[1], wp[2] + ch.t[2]], sx, sy, sz, v)
  }
  for (let t = 0; t < idx.length; t += 3) triangle(idx[t], idx[t + 1], idx[t + 2], sx, sy, sz, shade)
}
const cbuf = new Map()
function costume(w) {
  let b = cbuf.get(w.id)
  if (b === undefined) {
    const g = costumes.get(w.slot)
    b = { n: g.pos.length / 3, X: new Float32Array(g.pos.length / 3), Y: new Float32Array(g.pos.length / 3), Z: new Float32Array(g.pos.length / 3), C: new Float32Array(g.pos.length) }
    cbuf.set(w.id, b)
  }
  const g = costumes.get(w.slot), n = b.n
  for (let v = 0; v < n; v++) {
    const p = rotate(w.r, [g.pos[v * 3] * w.s[0], g.pos[v * 3 + 1] * w.s[1], g.pos[v * 3 + 2] * w.s[2]])
    const q = norm(rotate(w.r, [g.nor[v * 3], g.nor[v * 3 + 1], g.nor[v * 3 + 2]]))
    const lam = Math.max(0, dot(q, LIGHT))
    for (let c = 0; c < 3; c++) b.C[v * 3 + c] = g.col[v * 3 + c] * (0.32 + 0.85 * lam)
    project([p[0] + w.t[0], p[1] + w.t[1], p[2] + w.t[2]], b.X, b.Y, b.Z, v)
  }
  // A small depth bias layers the costume over the skinned body: two independently meshed coarse surfaces sit
  // within a few millimetres and would otherwise z-fight (a shader would resolve this with a polygon offset).
  for (let t = 0; t < g.idx.length; t += 3) triangle(g.idx[t], g.idx[t + 1], g.idx[t + 2], b.X, b.Y, b.Z, b.C, COSTUME_BIAS)
}
function render(frame) {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 3, s = y / H
    rgb[o] = 150 + 60 * s; rgb[o + 1] = 190 + 40 * s; rgb[o + 2] = 235
  }
  depth.fill(Infinity)
  if (frame.cam === null) return rgb
  setCamera(frame.cam)
  const local = frame.chars[0]
  if (groundY === null || (local.mode !== CharMode.air && local.mode !== CharMode.dive)) groundY = local.y - 0.85
  ground(local.t)
  for (let p = 0; p < frame.chars.length; p++) {
    const ch = frame.chars[p]
    if (ch.visible) character(ch, frame.skins[p])
  }
  for (const w of frame.wear) if (w.instance >= 0 && w.visible) costume(w)
  return rgb
}

const stillAt = Math.min(frames.length - 1, Number(process.env.STILL_FRAME ?? 180))
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', `${FPS}`, '-i', '-',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-movflags', '+faststart', OUT], { stdio: ['pipe', 'inherit', 'inherit'] })
for (const frame of frames) {
  const img = render(frame)
  if (!ff.stdin.write(Buffer.from(img))) await new Promise(r => ff.stdin.once('drain', r))
  if (frame.f === stillAt) writeFileSync('/tmp/scene-view-costumes-still.rgb', img)
}
ff.stdin.end()
await new Promise((res, rej) => ff.on('close', code => code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}`))))
const png = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-i', '/tmp/scene-view-costumes-still.rgb', STILL], { stdio: 'inherit' })
await new Promise((res, rej) => png.on('close', code => code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}`))))
const side = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', STILL, '-i', '/refs/penguin-base-ortho.png', '-filter_complex',
  '[1:v]scale=-2:400[r];[0:v][r]hstack', SIDE], { stdio: 'inherit' })
await new Promise((res, rej) => side.on('close', code => code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}`))))
writeFileSync(RECORD, JSON.stringify({ ...record, stillFrame: stillAt, stillTick: frames[stillAt].tick }, null, 2) + '\n')
console.log(`wrote ${OUT}, ${STILL}, ${SIDE}, ${RECORD}`)

// Renders proofs/m19/penguin-scene-view.mp4: the game's SceneView (packages/game/src/render/sceneView.ts) bound
// to a real 8-player MatchSim, registering the skinned penguin through RenderPort.registerSkinned and posing
// every character from its own AnimDriver graph. The sim runs 60 Hz ticks in uneven batches before each 30 fps
// render (2 ticks, sometimes 4, sometimes 0 = a repeated render), exactly like the game loops, which only call
// update() once per frame. A recording port keeps what SceneView submitted (instance tint, transform, setPose
// matrices, camera) and a CPU raster draws that state, so the video shows the port's view of the scene: each
// character's placement, facing, palette tint and pose, the follow camera and the ground. Obstacles are not
// drawn (their prims meshes are not part of this preview). The checks prove every stepped tick is observed
// exactly once, repeated renders never step a graph nor resubmit a pose, and characters carry distinct poses.
// The skin streams come from proofs/m19/penguin-fall-dive.glb, the same penguin document meshed with its rig.
// Usage: node --experimental-strip-types proofs/m19/render-scene-view.mjs   (NO_VIDEO=1 for the checks only)
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { createMatchSim } from '@royal-fiesta/sim/match/matchSim'
import { neutralInput } from '@royal-fiesta/sim/input'
import { CharMode } from '@royal-fiesta/sim/character/constants'
import { fixtureResolver } from '../../packages/game/src/assets.ts'
import { matchCourses } from '../../packages/game/src/courseSet.ts'
import { netSetup } from '../../packages/game/src/net/tuning.ts'
import { NullRenderPort } from '../../packages/game/src/render/nullPort.ts'
import { SceneView } from '../../packages/game/src/render/sceneView.ts'

const W = 960, H = 540, FRAMES = Number(process.env.FRAMES ?? 420), OUT = 'proofs/m19/penguin-scene-view.mp4'
const STILL = 'proofs/m19/scene-view-waddle.png', SIDE = 'proofs/m19/scene-view-waddle-side-by-side.png'
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
const asset = JSON.parse(readFileSync('assets/common/penguin.body.asset.json', 'utf8'))
const owner = asset.document.nodes.penguin
const skinned = {
  assetId: asset.id,
  skin: { rig: owner.rig, clips: owner.clips, parts: [{ name: 'penguin', skin: { joints, weights } }] },
  graph: readFileSync('assets/common/penguin.animgraph.json', 'utf8'),
}

// Keeps what SceneView submits so the raster draws the port's state, not the sim's.
class RecordingPort extends NullRenderPort {
  inst = []
  cam = null
  createInstance(asset, tint) {
    const h = super.createInstance(asset, tint)
    this.inst[h] = { asset, tint, t: [0, 0, 0], r: [0, 0, 0, 1], visible: true }
    return h
  }
  setTransform(i, t, r, s) { super.setTransform(i, t, r, s); Object.assign(this.inst[i], { t: [...t], r: [...r] }) }
  setVisible(i, v) { super.setVisible(i, v); this.inst[i].visible = v }
  setCamera(v, cam) { super.setCamera(v, cam); this.cam = cam }
}

const R = await initRapier()
// Every seat is a bot, so the followed character races the course with the pack.
const setup = netSetup(7, 1, 'sprint', courses)
const sim = createMatchSim(R, { ...setup, humans: setup.humans.map(() => false) })
const port = new RecordingPort()
await port.init({ canvas: null, width: W, height: H, viewports: [{ x: 0, y: 0, width: W, height: H }] })
const view = new SceneView({ port, viewport: 0, localPlayer: 0, bean, assets: n => assets.get(n), skinned })
assert.equal(view.animationError, null)

// ---- frame loop: uneven tick batches per render, as the game's fixed-step loops produce them ----
const inputs = Array.from({ length: sim.setup.playerCount }, () => neutralInput())
const batch = f => (f % 12 === 5 ? 4 : f % 12 === 6 ? 0 : 2) // a catch-up batch, then a repeated render
const observed = [], stepped = [], frames = []
let driver = null, repeatedRenders = 0, posesOnRepeat = 0
for (let f = 0; f < FRAMES; f++) {
  const n = batch(f)
  for (let k = 0; k < n; k++) {
    sim.step(inputs)
    stepped.push(sim.tick)
  }
  const poseCalls = port.calls.setPose
  view.update(sim, null, 1, 1 / 30)
  // The graphs load asynchronously; characters draw at rest until then (ticks before are not replayed).
  if (driver === null && view.anim) {
    driver = view.anim
    const observe = driver.observeTick.bind(driver)
    driver.observeTick = (tick, chars) => { observed.push(tick); observe(tick, chars) }
  }
  if (driver === null) await new Promise(r => setTimeout(r, 20))
  if (n === 0 && driver !== null) {
    repeatedRenders++
    posesOnRepeat += port.calls.setPose - poseCalls
    view.update(sim, null, 1, 1 / 30) // and once more: rendering a tick again never steps
    posesOnRepeat += port.calls.setPose - poseCalls
  }
  frames.push(snapshot(f))
}
assert.ok(driver !== null, 'the animation driver loaded')
const first = observed[0]
const expected = stepped.filter(t => t >= first)
assert.deepEqual(observed, expected, 'every stepped tick after the graphs loaded is observed once, in order')
assert.equal(posesOnRepeat, 0, 'a repeated render submits no pose')
const distinct = frames.at(-1).chars.filter(c => c.visible && c.pose)
const keys = new Set(distinct.map(c => Array.from(c.pose.subarray(0, 64), v => v.toFixed(4)).join()))
assert.ok(distinct.length >= 2 && keys.size >= 2, 'characters carry their own poses')

function snapshot(f) {
  const chars = [], c = { pos: {}, vel: {}, facing: {} }
  for (let p = 0; p < sim.setup.playerCount; p++) {
    const h = view.beans[p], i = port.inst[h]
    sim.character(p, c)
    chars.push({ t: i.t, r: i.r, tint: i.tint, visible: i.visible, pose: port.poseOf(h), air: c.mode === CharMode.air || c.mode === CharMode.dive })
  }
  return { f, tick: sim.tick, cam: port.cam, chars }
}
const record = {
  video: OUT, still: STILL, sideBySide: SIDE, frames: FRAMES, fps: 30, simHz: 60,
  ticksStepped: stepped.length, firstObservedTick: first, ticksObserved: observed.length,
  graphStepsPerObservedTick: 1, repeatedRenders, posesSubmittedOnRepeatedRenders: posesOnRepeat,
  setPoseCalls: port.calls.setPose, characters: sim.setup.playerCount, distinctPosesLastFrame: keys.size,
  skin: 'proofs/m19/penguin-fall-dive.glb', asset: 'assets/common/penguin.body.asset.json', graph: 'assets/common/penguin.animgraph.json',
  raster: 'CPU preview of the RenderPort state (not a GPU capture)',
}
view.dispose()
assert.equal(driver.disposed, true, 'dispose releases the character graphs with the instances')
console.log(JSON.stringify(record, null, 2))
if (process.env.NO_VIDEO) process.exit(0)

// ---- CPU raster of the recorded port state ----
const rgb = new Uint8Array(W * H * 3), depth = new Float32Array(W * H)
const sx = new Float32Array(NV), sy = new Float32Array(NV), sz = new Float32Array(NV), shade = new Float32Array(NV * 3)
const LIGHT = [0.35, 0.8, 0.45].map(c => c / Math.hypot(0.35, 0.8, 0.45))
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const norm = a => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l] }
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
function rotate(q, v) { // v + 2w(q x v) + 2 q x (q x v)
  const u = [q[0], q[1], q[2]], t = cross(u, v).map(c => 2 * c), c2 = cross(u, t)
  return [v[0] + q[3] * t[0] + c2[0], v[1] + q[3] * t[1] + c2[1], v[2] + q[3] * t[2] + c2[2]]
}
let camera = null
function setCamera(cam) {
  const f = norm(sub(cam.target, cam.eye)), r = norm(cross(f, [0, 1, 0])), u = cross(r, f)
  camera = { eye: cam.eye, f, r, u, focal: 1 / Math.tan(cam.fovYDeg * Math.PI / 360), near: cam.near }
}
function project(p, out, i) {
  const d = sub(p, camera.eye), z = dot(d, camera.f)
  out[0][i] = W / 2 + (dot(d, camera.r) / z) * camera.focal * (H / 2)
  out[1][i] = H / 2 - (dot(d, camera.u) / z) * camera.focal * (H / 2)
  out[2][i] = z
}
function triangle(a, b, c, X, Y, Z, C) {
  if (Z[a] < camera.near || Z[b] < camera.near || Z[c] < camera.near) return
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
    const z = wa * Z[a] + wb * Z[b] + wc * Z[c], o = py * W + px
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
  for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) project([ox + i * s, groundY, oz + j * s], [gx, gy, gz], j * (G + 1) + i)
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const a = j * (G + 1) + i, odd = (i + j + Math.round(ox / s) + Math.round(oz / s)) & 1
    const c = odd ? [0.55, 0.62, 0.7] : [0.66, 0.72, 0.8], C = new Float32Array(12).map((_, k) => c[k % 3])
    const quad = new Uint32Array([a, a + 1, a + G + 2, a + G + 1]).map(Number)
    const X = [], Y = [], Z = []
    for (let k = 0; k < 4; k++) { X.push(gx[quad[k]]); Y.push(gy[quad[k]]); Z.push(gz[quad[k]]) }
    triangle(0, 1, 2, X, Y, Z, C); triangle(0, 2, 3, X, Y, Z, C)
  }
}
function character(ch) {
  const m = ch.pose, tint = ch.tint ?? [1, 1, 1]
  for (let v = 0; v < NV; v++) {
    let p = [0, 0, 0], q = [0, 0, 0]
    if (m === null) { p = [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]; q = [nor[v * 3], nor[v * 3 + 1], nor[v * 3 + 2]] }
    else for (let k = 0; k < 4; k++) {
      const w = weights[v * 4 + k]; if (w === 0) continue
      const o = joints[v * 4 + k] * 16
      for (let r = 0; r < 3; r++) {
        p[r] += w * (m[o + r] * pos[v * 3] + m[o + 4 + r] * pos[v * 3 + 1] + m[o + 8 + r] * pos[v * 3 + 2] + m[o + 12 + r])
        q[r] += w * (m[o + r] * nor[v * 3] + m[o + 4 + r] * nor[v * 3 + 1] + m[o + 8 + r] * nor[v * 3 + 2])
      }
    }
    const wp = rotate(ch.r, p), wn = norm(rotate(ch.r, q))
    const lam = Math.max(0, dot(wn, LIGHT))
    for (let c = 0; c < 3; c++) shade[v * 3 + c] = col[v * cstride + c] * colScale * tint[c] * (0.35 + 0.8 * lam)
    project([wp[0] + ch.t[0], wp[1] + ch.t[1], wp[2] + ch.t[2]], [sx, sy, sz], v)
  }
  for (let t = 0; t < idx.length; t += 3) triangle(idx[t], idx[t + 1], idx[t + 2], sx, sy, sz, shade)
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
  if (groundY === null || !local.air) groundY = local.t[1] - 0.85
  ground(local.t)
  for (const ch of frame.chars) if (ch.visible) character(ch)
  return rgb
}

const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', '30', '-i', '-',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-movflags', '+faststart', OUT], { stdio: ['pipe', 'inherit', 'inherit'] })
const stillAt = Math.min(frames.length - 1, Number(process.env.STILL_FRAME ?? Math.floor(frames.length * 0.62)))
for (const frame of frames) {
  const img = render(frame)
  if (!ff.stdin.write(Buffer.from(img))) await new Promise(r => ff.stdin.once('drain', r))
  if (frame.f === stillAt) writeFileSync('/tmp/scene-view-still.rgb', img)
}
ff.stdin.end()
await new Promise((res, rej) => ff.on('close', code => code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}`))))
const png = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-i', '/tmp/scene-view-still.rgb', STILL], { stdio: 'inherit' })
await new Promise((res, rej) => png.on('close', code => code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}`))))
// The look reference next to the in-scene still, for review.
const side = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', STILL, '-i', '/refs/penguin-base-ortho.png', '-filter_complex',
  '[1:v]scale=-2:540[r];[0:v][r]hstack', SIDE], { stdio: 'inherit' })
await new Promise((res, rej) => side.on('close', code => code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}`))))
writeFileSync('proofs/m19/penguin-scene-view.json', JSON.stringify({ ...record, stillFrame: stillAt, stillTick: frames[stillAt].tick }, null, 2) + '\n')
console.log(`wrote ${OUT}, ${STILL}, ${SIDE}`)

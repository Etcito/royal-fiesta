// Renders proofs/m19/penguin-animgraph-run.mp4: assets/common/penguin.animgraph.json loaded by the
// consumed S19 runtime (@etcito/raa-anim loadGraph) and stepped once per 60 Hz tick through a scripted
// CharMode/velocity/grounded input timeline: idle -> speed ramp through waddle to run -> jump -> fall ->
// land -> walk off a ledge -> fall -> land -> dive (mode 2) -> diveRecover (mode 3) landing.
// Every tick the graph's skin output is matched against every pure clip sample: the label shows the
// clip the graph is playing (or "blend" during blend-space mixes and crossfades). The CPU raster is a
// pose preview for approval; the summary is written to proofs/m19/penguin-animgraph-run.json.
// Usage: node proofs/m19/render-graph-run.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { loadRaaAnim } from '@etcito/raa-anim'

const W = 960, H = 540, FPS = 30, TICKS = 780, OUT = 'proofs/m19/penguin-animgraph-run.mp4'
const asset = JSON.parse(readFileSync('assets/common/penguin.body.asset.json', 'utf8'))
const owner = asset.document.nodes.penguin
const { bindings, smooth, ...preset } = owner.rig
const api = await loadRaaAnim(), rig = api.loadRig(JSON.stringify(preset))
const clips = owner.clips.map(def => ({ def, clip: api.loadClip(rig, JSON.stringify(def)) }))
const graph = api.loadGraph(readFileSync('assets/common/penguin.animgraph.json', 'utf8'), rig, clips.map(c => c.clip))
const state = graph.newState()
const NB = preset.bones.length * 16
const samples = clips.map(({ def, clip }) => ({ name: def.name, poses: Array.from({ length: def.lengthTicks + 1 }, (_, t) => api.sampleClip(clip, t).skin.slice(0, NB)) }))
function classify(skin) {
  let best = 'blend', err = 1e-4
  for (const s of samples) for (const p of s.poses) {
    let e = 0
    for (let i = 0; i < NB && e < err; i++) e = Math.max(e, Math.abs(p[i] - skin[i]))
    if (e < err) { err = e; best = s.name }
  }
  return best
}

// Scripted sim inputs per tick, using the CharMode values of packages/sim/src/character/constants.ts.
function inputs(t) {
  const p = { speed: 0, vy: 0, grounded: true, mode: 0 }
  if (t < 90) return p
  if (t < 150) return { ...p, speed: 3 * (t - 90) / 60 }
  if (t < 180) return { ...p, speed: 3 }
  if (t < 240) return { ...p, speed: 3 + 5 * (t - 180) / 60 }
  if (t < 340) return { ...p, speed: 8 }
  if (t < 420) { const vy = 6 - 12 * (t - 340) / 80; return { speed: 6, vy, grounded: false, mode: 1, jump: t === 340 } }
  if (t < 500) return { ...p, speed: 3 }
  if (t < 560) return { speed: 3, vy: -6 * (t - 500) / 60, grounded: false, mode: 1 }
  if (t < 600) return { ...p, speed: 3 }
  if (t < 620) { const vy = 5 - 10 * (t - 600) / 80; return { speed: 4, vy, grounded: false, mode: 1, jump: t === 600 } }
  if (t < 680) return { speed: 7, vy: 5 - 10 * (t - 600) / 80, grounded: false, mode: 2 }
  if (t < 700) return { speed: 2, vy: 0, grounded: true, mode: 3 }
  return { ...p, speed: 0 }
}

const buf = readFileSync('proofs/m19/penguin-fall-dive.glb')
const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), jl = view.getUint32(12, true)
const gltf = JSON.parse(buf.subarray(20, 20 + jl).toString('utf8')), bin = buf.subarray(28 + jl)
const accessor = id => {
  const a = gltf.accessors[id], b = gltf.bufferViews[a.bufferView]
  const n = a.count * { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type]
  const T = a.componentType === 5126 ? Float32Array : a.componentType === 5123 ? Uint16Array : Uint32Array
  const off = (b.byteOffset ?? 0) + (a.byteOffset ?? 0)
  return new T(bin.buffer.slice(bin.byteOffset + off, bin.byteOffset + off + n * T.BYTES_PER_ELEMENT))
}
const prim = gltf.meshes[0].primitives[0], at = prim.attributes
const pos = accessor(at.POSITION), nor = accessor(at.NORMAL), col = accessor(at.COLOR_0)
const joints = accessor(at.JOINTS_0), weights = accessor(at.WEIGHTS_0), idx = accessor(prim.indices)
const n = pos.length / 3, cstride = col.length / n
const YAW = 55 * Math.PI / 180, cy = Math.cos(YAW), sy_ = Math.sin(YAW)
const eye = [0, 2.2, 13], focal = 1 / Math.tan(18 * Math.PI / 180)
const light = [0.35, 0.75, 0.55].map(c => c / Math.hypot(0.35, 0.75, 0.55))
const rgb = new Uint8Array(W * H * 3), depth = new Float32Array(W * H)
const sx = new Float32Array(n), sy = new Float32Array(n), sz = new Float32Array(n), shade = new Float32Array(n * 3)
const project = (x, y, z, cx) => { const d = eye[2] - z; return [cx + (x / d) * focal * (H / 2), H * 0.42 - ((y - eye[1]) / d) * focal * (H / 2), d] }
function draw(skin, lift, cx) {
  for (let v = 0; v < n; v++) {
    const p = [0, 0, 0], q = [0, 0, 0]
    for (let k = 0; k < 4; k++) {
      const w = weights[v * 4 + k]; if (w === 0) continue
      const m = skin.subarray(joints[v * 4 + k] * 16)
      for (let r = 0; r < 3; r++) {
        p[r] += w * (m[r] * pos[v * 3] + m[4 + r] * pos[v * 3 + 1] + m[8 + r] * pos[v * 3 + 2] + m[12 + r])
        q[r] += w * (m[r] * nor[v * 3] + m[4 + r] * nor[v * 3 + 1] + m[8 + r] * nor[v * 3 + 2])
      }
    }
    const px = cy * p[0] + sy_ * p[2], pz = -sy_ * p[0] + cy * p[2], qx = cy * q[0] + sy_ * q[2], qz = -sy_ * q[0] + cy * q[2]
    const len = Math.hypot(qx, q[1], qz) || 1
    const lam = Math.max(0, (qx * light[0] + q[1] * light[1] + qz * light[2]) / len)
    for (let c = 0; c < 3; c++) shade[v * 3 + c] = col[v * cstride + c] * (0.3 + 0.85 * lam)
    ;[sx[v], sy[v], sz[v]] = project(px, p[1] + 1.65 + lift, pz, cx)
  }
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2]
    const area = (sx[b] - sx[a]) * (sy[c] - sy[a]) - (sx[c] - sx[a]) * (sy[b] - sy[a])
    if (area === 0) continue
    const x0 = Math.max(0, Math.floor(Math.min(sx[a], sx[b], sx[c]))), x1 = Math.min(W - 1, Math.ceil(Math.max(sx[a], sx[b], sx[c])))
    const y0 = Math.max(0, Math.floor(Math.min(sy[a], sy[b], sy[c]))), y1 = Math.min(H - 1, Math.ceil(Math.max(sy[a], sy[b], sy[c])))
    for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
      const X = px + 0.5, Y = py + 0.5
      const wa = ((sx[b] - X) * (sy[c] - Y) - (sx[c] - X) * (sy[b] - Y)) / area
      const wb = ((sx[c] - X) * (sy[a] - Y) - (sx[a] - X) * (sy[c] - Y)) / area
      const wc = 1 - wa - wb
      if (wa < 0 || wb < 0 || wc < 0) continue
      const z = wa * sz[a] + wb * sz[b] + wc * sz[c], o = py * W + px
      if (z >= depth[o]) continue
      depth[o] = z
      for (let k = 0; k < 3; k++) rgb[o * 3 + k] = Math.round(255 * Math.min(1, wa * shade[a * 3 + k] + wb * shade[b * 3 + k] + wc * shade[c * 3 + k]) ** (1 / 2.2))
    }
  }
}
function rect(x0, y0, x1, y1, r, g, b) {
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) { const o = (y * W + x) * 3; rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b }
}

// Pass 1: step the graph every tick and classify its output.
const ticks = []
let lift = 0
for (let t = 0; t < TICKS; t++) {
  const p = inputs(t), step = graph.step(state, p)
  lift = p.grounded ? 0 : Math.max(0, lift + p.vy / 60)
  ticks.push({ t, p, lift, skin: step.skin.slice(0, NB), pose: classify(step.skin) })
}
const segments = []
for (const k of ticks) {
  const last = segments.at(-1)
  if (last && last.pose === k.pose) last.to = k.t
  else segments.push({ pose: k.pose, from: k.t, to: k.t })
}
const poseAt = t => ticks[t].pose
const checks = {
  idleAtRest: poseAt(80) === 'idle',
  waddleAtSpeed3: poseAt(170) === 'waddle',
  blendBetweenPoints: poseAt(120) === 'blend' && poseAt(210) === 'blend',
  runAtSpeed8: poseAt(330) === 'run',
  jumpOnTrigger: poseAt(350) === 'jump',
  fallWhenDescending: poseAt(410) === 'fall',
  landToLocomotion: poseAt(495) === 'waddle',
  ledgeFall: poseAt(550) === 'fall',
  diveOnMode2: poseAt(670) === 'dive',
  recoverToLocomotion: poseAt(770) === 'idle',
}
if (process.env.NO_VIDEO) { console.log(JSON.stringify({ checks, segments }, null, 0)); process.exit(0) }
const fontFile = ['/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'].find(existsSync)
const txt = (s, x, y, size, extra = '') => `drawtext=fontfile=${fontFile}:text='${s}':x=${x}:y=${y}:fontsize=${size}:fontcolor=white:borderw=2:bordercolor=0x203040${extra}`
const filters = fontFile ? [
  txt('penguin.animgraph.json  (S19 graph stepped per 60 Hz tick)', 20, 14, 20),
  ...segments.map(s => txt(`graph pose\\: ${s.pose === 'blend' ? 'blend / crossfade' : s.pose}`, 20, 44, 30, `:enable='between(t,${(s.from / 60).toFixed(4)},${((s.to + 1) / 60 - 1e-4).toFixed(4)})'`)),
  txt('speed 0..8', 20, H - 112, 16), txt('vy', 20, H - 84, 16), txt('grounded', 20, H - 56, 16), txt('CharMode', 20, H - 28, 16),
] : []

// Pass 2: rasterise every other tick (30 fps) with the input bars, encode with the pose labels.
let minY = Infinity
for (let v = 0; v < n; v++) minY = Math.min(minY, pos[v * 3 + 1])
const floorY = Math.round(project(0, minY + 1.65, 0, 0)[1])
const frames = []
for (let t = 0; t < (Number(process.env.PREVIEW_TICKS) || TICKS); t += 2) frames.push(ticks[t])
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
  ...(filters.length ? ['-vf', filters.join(',')] : []), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', OUT], { stdio: ['pipe', 'inherit', 'inherit'] })
for (const k of frames) {
  for (let o = 0; o < W * H; o++) { const g = 0.62 + 0.3 * (o / W / H); rgb[o * 3] = 150 * g; rgb[o * 3 + 1] = 200 * g; rgb[o * 3 + 2] = 255 * g; depth[o] = Infinity }
  rect(0, floorY, W, H - 124, 225, 238, 248) // snow floor at the rest pose's lowest point
  draw(k.skin, k.lift, W / 2)
  rect(0, H - 124, W, H, 30, 44, 66)
  const bx = 140, bw = W - 160
  rect(bx, H - 110, bx + Math.round(bw * k.p.speed / 8), H - 94, 120, 220, 120)
  rect(bx + Math.min(bw / 2, bw / 2 + Math.round(bw / 2 * k.p.vy / 6)), H - 82, bx + Math.max(bw / 2, bw / 2 + Math.round(bw / 2 * k.p.vy / 6)), H - 66, 240, 180, 80)
  rect(bx, H - 54, bx + 60, H - 38, k.p.grounded ? 120 : 70, k.p.grounded ? 220 : 70, k.p.grounded ? 120 : 90)
  for (let m = 0; m < 4; m++) rect(bx + m * 70, H - 26, bx + m * 70 + 60, H - 10, m === k.p.mode ? 250 : 70, m === k.p.mode ? 120 : 70, m === k.p.mode ? 200 : 90)
  rect(0, H - 4, Math.round(W * k.t / TICKS), H, 255, 255, 255)
  if (!ff.stdin.write(Buffer.from(rgb))) await new Promise(r => ff.stdin.once('drain', r))
}
ff.stdin.end()
await new Promise((res, rej) => ff.on('close', code => code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}`))))
state.free(); graph.free(); clips.forEach(c => c.clip.free()); rig.free()
const summary = { video: OUT, graph: 'assets/common/penguin.animgraph.json', ticks: TICKS, fps: FPS, frames: frames.length, labels: Boolean(fontFile),
  segments: segments.map(s => ({ pose: s.pose, fromTick: s.from, toTick: s.to })), checks, ok: Object.values(checks).every(Boolean) }
writeFileSync('proofs/m19/penguin-animgraph-run.json', JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify({ ok: summary.ok, checks, segments: summary.segments.length }))
process.exit(summary.ok ? 0 : 1)

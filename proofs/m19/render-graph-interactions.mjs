// Renders proofs/m19/penguin-animgraph-interactions.mp4: assets/common/penguin.animgraph.json loaded by
// the consumed S19 runtime (@etcito/raa-anim loadGraph) and stepped once per 60 Hz tick through a scripted
// CharMode / grounded / S9 emote timeline covering bellySlide, grab -> handPush, jump -> grab -> hang ->
// climbUp, the four emotes (each held 2 s as S9 says), a repeated cheer request and a laugh interrupted by
// a jump. Every tick the graph's skin output is matched against every pure clip sample (clip and clip
// tick), so the checks prove entries, exits, that sustained states keep advancing instead of restarting,
// and that one-shot emotes reach their last key. The CPU raster is a pose preview for approval; the
// summary is written to proofs/m19/penguin-animgraph-interactions.json.
// Usage: node proofs/m19/render-graph-interactions.mjs   (NO_VIDEO=1 for the checks only)
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { loadRaaAnim } from '@etcito/raa-anim'
const { loadGraph } = await import(new URL('./pkg/raa_anim_js.js', import.meta.resolve('@etcito/raa-anim')).href)

const W = 960, H = 540, FPS = 30, TICKS = 1620, OUT = 'proofs/m19/penguin-animgraph-interactions.mp4'
const asset = JSON.parse(readFileSync('assets/common/penguin.body.asset.json', 'utf8'))
const owner = asset.document.nodes.penguin
const { bindings, smooth, ...preset } = owner.rig
const api = await loadRaaAnim(), rig = api.loadRig(JSON.stringify(preset))
const clips = owner.clips.map(def => ({ def, clip: api.loadClip(rig, JSON.stringify(def)) }))
const graph = loadGraph(readFileSync('assets/common/penguin.animgraph.json', 'utf8'), rig, clips.map(c => c.clip))
const state = graph.newState()
const NB = preset.bones.length * 16
const samples = clips.map(({ def, clip }) => ({ name: def.name, length: def.lengthTicks, loop: def.loop, poses: Array.from({ length: def.lengthTicks + 1 }, (_, t) => api.sampleClip(clip, t).skin.slice(0, NB)) }))
// Clip poses can coincide (rest-pose ends, loop seams): among the matches, continuing the previous tick's
// clip at its next tick wins, then the smallest error.
function classify(skin, prev) {
  const matches = []
  for (const s of samples) s.poses.forEach((p, tick) => {
    let e = 0
    for (let i = 0; i < NB && e < 1e-4; i++) e = Math.max(e, Math.abs(p[i] - skin[i]))
    if (e < 1e-4) matches.push({ pose: s.name, tick, e, len: s.length, loop: s.loop })
  })
  if (!matches.length) return { pose: 'blend', tick: -1 }
  const gap = m => {
    if (m.pose !== prev?.pose) return Infinity
    const next = prev.tick + 1 // the next tick, a loop's wrap, or a finished one-shot holding its last key
    return Math.min(Math.abs(m.tick - next), m.loop ? Math.abs(m.tick - (next - m.len)) : Infinity, next > m.len ? Math.abs(m.tick - m.len) : Infinity)
  }
  matches.sort((a, b) => gap(a) - gap(b) || a.e - b.e)
  return { pose: matches[0].pose, tick: matches[0].tick }
}

// Scripted sim inputs per tick: CharMode values of packages/sim/src/character/constants.ts, S9 emote ids.
const EMOTES = ['none', 'wave', 'dance', 'cheer', 'laugh']
function inputs(t) {
  const p = { speed: 0, vy: 0, grounded: true, mode: 0, emote: 0 }
  if (t >= 40 && t < 160) return { ...p, speed: 4, mode: 3 } // diveRecover: belly slide
  if (t >= 220 && t < 340) return { ...p, mode: 5 } // grabbing on the ground: grab -> handPush
  if (t >= 380 && t < 400) return { ...p, speed: 2, vy: 5, grounded: false, mode: 1, jump: t === 380 }
  if (t >= 400 && t < 520) return { ...p, grounded: false, mode: 5 } // grab a ledge in the air -> hang
  if (t >= 520 && t < 530) return { ...p, mode: 5 } // pulled onto the ledge: climbUp
  if (t >= 640 && t < 760) return { ...p, emote: 1 }
  if (t >= 800 && t < 920) return { ...p, emote: 3 }
  if (t >= 960 && t < 1080) return { ...p, emote: 4 }
  if (t >= 1120 && t < 1240) return { ...p, emote: 2 }
  if (t >= 1280 && t < 1400) return { ...p, emote: 3 } // the same one-shot requested again
  if (t >= 1440 && t < 1560) {
    const air = t >= 1470 && t < 1520
    return { ...p, emote: 4, ...(air ? { speed: 2, vy: 5 - 10 * (t - 1470) / 50, grounded: false, mode: 1, jump: t === 1470 } : {}) }
  }
  return p
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
  lift = p.grounded ? 0 : Math.min(1.2, Math.max(0, lift + (p.mode === 5 ? 0 : p.vy / 60)))
  ticks.push({ t, p, lift, skin: step.skin.slice(0, NB), ...classify(step.skin, ticks.at(-1)) })
}
const segments = []
for (const k of ticks) {
  const last = segments.at(-1)
  if (last && last.pose === k.pose) last.to = k.t
  else segments.push({ pose: k.pose, from: k.t, to: k.t })
}
const poseAt = t => ticks[t].pose
// A sustained state keeps playing: over [a, b] the pose stays on its clip and the clip tick advances by
// one (or wraps a loop) every tick, so the state never re-enters itself.
const sustained = (pose, a, b) => ticks.slice(a, b + 1).every((k, i, all) => {
  if (k.pose !== pose) return false
  if (i === 0) return true
  const len = samples.find(s => s.name === pose).length, d = (k.tick - all[i - 1].tick + len) % len
  return d === 1 || (d === 0 && (k.tick === 0 || k.tick === len))
})
const finishes = (pose, a, b) => ticks.slice(a, b + 1).some(k => k.pose === pose && k.tick === samples.find(s => s.name === pose).length)
const checks = {
  idleAtStart: poseAt(30) === 'idle',
  bellySlideSustained: sustained('bellySlide', 60, 159),
  bellySlideExitsToLocomotion: poseAt(200) === 'idle',
  grabOnGroundedGrabbing: poseAt(235) === 'grab',
  handPushSustained: sustained('handPush', 260, 339),
  handPushExitsToLocomotion: poseAt(370) === 'idle',
  jumpOnTrigger: poseAt(392) === 'jump',
  grabInAir: poseAt(415) === 'grab',
  hangSustained: sustained('hang', 440, 519),
  climbUpOnLanding: sustained('climbUp', 540, 590),
  climbUpFinishesToLocomotion: finishes('climbUp', 520, 610) && poseAt(630) === 'idle',
  waveFinishes: sustained('emote.wave', 660, 740) && finishes('emote.wave', 640, 760),
  waveExitsOnRelease: poseAt(790) === 'idle',
  cheerFinishes: sustained('emote.cheer', 820, 910) && finishes('emote.cheer', 800, 920),
  laughFinishes: sustained('emote.laugh', 980, 1060) && finishes('emote.laugh', 960, 1080),
  danceLoops: sustained('emote.dance', 1140, 1239),
  danceExitsOnRelease: poseAt(1270) === 'idle',
  cheerRequestedAgain: sustained('emote.cheer', 1300, 1390) && finishes('emote.cheer', 1280, 1400),
  laughInterruptedByJump: poseAt(1460) === 'emote.laugh' && poseAt(1485) === 'jump',
  laughResumesAfterLanding: poseAt(1545) === 'emote.laugh',
  locomotionAfterEmoteEnds: poseAt(1610) === 'idle',
}
if (process.env.NO_VIDEO) { console.log(JSON.stringify({ checks, segments }, null, 0)); process.exit(0) }
const fontFile = ['/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'].find(existsSync)
const txt = (s, x, y, size, extra = '') => `drawtext=fontfile=${fontFile}:text='${s}':x=${x}:y=${y}:fontsize=${size}:fontcolor=white:borderw=2:bordercolor=0x203040${extra}`
const between = (a, b) => `:enable='between(t,${(a / 60).toFixed(4)},${((b + 1) / 60 - 1e-4).toFixed(4)})'`
const runs = key => {
  const out = []
  for (const k of ticks) { const v = key(k), last = out.at(-1); if (last && last.v === v) last.to = k.t; else out.push({ v, from: k.t, to: k.t }) }
  return out
}
const MODES = ['ground', 'air', 'dive', 'diveRecover', 'stunned', 'grabbing']
const filters = fontFile ? [
  txt('penguin.animgraph.json  interactions + emotes (S19 graph per 60 Hz tick)', 20, 14, 20),
  ...segments.map(s => txt(`graph pose\\: ${s.pose === 'blend' ? 'blend / crossfade' : s.pose}`, 20, 44, 30, between(s.from, s.to))),
  ...runs(k => `CharMode ${k.p.mode} ${MODES[k.p.mode]}   grounded ${k.p.grounded}${k.p.jump ? '   jump!' : ''}`).map(r => txt(r.v, 20, 84, 18, between(r.from, r.to))),
  ...runs(k => `S9 emote ${k.p.emote} ${EMOTES[k.p.emote]}`).map(r => txt(r.v, 20, 108, 18, between(r.from, r.to))),
  txt('speed 0..8', 20, H - 84, 16), txt('grounded', 20, H - 56, 16), txt('mode/emote', 20, H - 28, 16),
] : []

// Pass 2: rasterise every other tick (30 fps) with the input bars, encode with the labels.
let minY = Infinity
for (let v = 0; v < n; v++) minY = Math.min(minY, pos[v * 3 + 1])
const floorY = Math.round(project(0, minY + 1.65, 0, 0)[1])
const frames = []
for (let t = 0; t < (Number(process.env.PREVIEW_TICKS) || TICKS); t += 2) frames.push(ticks[t])
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
  ...(filters.length ? ['-vf', filters.join(',')] : []), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', OUT], { stdio: ['pipe', 'inherit', 'inherit'] })
for (const k of frames) {
  for (let o = 0; o < W * H; o++) { const g = 0.62 + 0.3 * (o / W / H); rgb[o * 3] = 150 * g; rgb[o * 3 + 1] = 200 * g; rgb[o * 3 + 2] = 255 * g; depth[o] = Infinity }
  rect(0, floorY, W, H - 96, 225, 238, 248) // snow floor at the rest pose's lowest point
  if (k.p.mode === 5 && !k.p.grounded) rect(W / 2 - 160, 70, W / 2 + 160, 92, 120, 140, 170) // the ledge being held
  draw(k.skin, k.lift, W / 2)
  rect(0, H - 96, W, H, 30, 44, 66)
  const bx = 140, bw = W - 160
  rect(bx, H - 82, bx + Math.round(bw * k.p.speed / 8), H - 66, 120, 220, 120)
  rect(bx, H - 54, bx + 60, H - 38, k.p.grounded ? 120 : 70, k.p.grounded ? 220 : 70, k.p.grounded ? 120 : 90)
  for (let m = 0; m < 6; m++) rect(bx + m * 50, H - 26, bx + m * 50 + 42, H - 10, m === k.p.mode ? 250 : 70, m === k.p.mode ? 120 : 70, m === k.p.mode ? 200 : 90)
  for (let e = 0; e < 5; e++) rect(bx + 360 + e * 50, H - 26, bx + 402 + e * 50, H - 10, e === k.p.emote ? 250 : 70, e === k.p.emote ? 210 : 70, e === k.p.emote ? 90 : 90)
  rect(0, H - 4, Math.round(W * k.t / TICKS), H, 255, 255, 255)
  if (!ff.stdin.write(Buffer.from(rgb))) await new Promise(r => ff.stdin.once('drain', r))
}
ff.stdin.end()
await new Promise((res, rej) => ff.on('close', code => code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}`))))
state.free(); graph.free(); clips.forEach(c => c.clip.free()); rig.free()
const summary = { video: OUT, graph: 'assets/common/penguin.animgraph.json', ticks: TICKS, fps: FPS, frames: frames.length, labels: Boolean(fontFile),
  segments: segments.map(s => ({ pose: s.pose, fromTick: s.from, toTick: s.to })), checks, ok: Object.values(checks).every(Boolean) }
writeFileSync('proofs/m19/penguin-animgraph-interactions.json', JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify({ ok: summary.ok, checks, segments: summary.segments.length }))
process.exit(summary.ok ? 0 : 1)

// Renders proofs/m19/penguin-fall-dive.mp4: the penguin's real S17 fall (left) and dive (right) clips,
// sampled by @etcito/raa-anim, skinned from the committed GLB weights and rasterised on the CPU.
// A clip pose preview for approval; the in-game GPU review capture is proofs/m19/clip-review.mjs.
// Usage: node proofs/m19/render-fall-dive-preview.mjs [out.mp4]
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { loadRaaAnim } from '@etcito/raa-anim'

const W = 1280, H = 540, FPS = 30, SECONDS = 4
const out = process.argv[2] ?? 'proofs/m19/penguin-fall-dive.mp4'
const asset = JSON.parse(readFileSync('assets/common/penguin.body.asset.json', 'utf8'))
const owner = asset.document.nodes.penguin
const { bindings, smooth, ...preset } = owner.rig
const api = await loadRaaAnim(), rig = api.loadRig(JSON.stringify(preset))
const clips = ['fall', 'dive'].map(name => {
  const def = owner.clips.find(c => c.name === name)
  return { name, def, clip: api.loadClip(rig, JSON.stringify(def)) }
})

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
const yaw = v => [cy * v[0] + sy_ * v[2], v[1], -sy_ * v[0] + cy * v[2]]
const eye = [0, 1.5, 10], focal = 1 / Math.tan(18 * Math.PI / 180) // 36 degree fov, orthogonal-ish front view
const light = [0.35, 0.75, 0.55].map(c => c / Math.hypot(0.35, 0.75, 0.55))
const rgb = new Uint8Array(W * H * 3), depth = new Float32Array(W * H)
const sx = new Float32Array(n), sy = new Float32Array(n), sz = new Float32Array(n), shade = new Float32Array(n * 3)

function project(x, y, z, cx) { const d = eye[2] - z; return [cx + (x / d) * focal * (H / 2), H / 2 - ((y - eye[1]) / d) * focal * (H / 2), d] }
function draw(skin, off, cx) {
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
    const pr = yaw(p), qr = yaw(q); p.splice(0, 3, ...pr); q.splice(0, 3, ...qr)
    const len = Math.hypot(...q) || 1
    const lam = Math.max(0, (q[0] * light[0] + q[1] * light[1] + q[2] * light[2]) / len)
    for (let c = 0; c < 3; c++) shade[v * 3 + c] = col[v * cstride + c] * (0.3 + 0.85 * lam)
    ;[sx[v], sy[v], sz[v]] = project(p[0] + off[0], p[1] + off[1], p[2] + off[2], cx)
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
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const o = (y * W + x) * 3; rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b }
}

const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] })
const FRAMES = FPS * SECONDS
for (let f = 0; f < FRAMES; f++) {
  for (let o = 0; o < W * H; o++) { const g = 0.62 + 0.3 * (o / W / H); rgb[o * 3] = 150 * g; rgb[o * 3 + 1] = 200 * g; rgb[o * 3 + 2] = 255 * g; depth[o] = Infinity }
  clips.forEach(({ def, clip }, i) => {
    const tick = Math.floor(f * 60 / FPS) // 60 Hz sim ticks
    draw(api.sampleClip(clip, tick).skin.slice(0, 12 * 16), [0, 1.65, 0], W * (0.25 + 0.5 * i))
    rect(i * (W / 2) + 20, H - 36, i * (W / 2) + 20 + Math.round((W / 2 - 40) * ((tick % def.lengthTicks) / def.lengthTicks)), H - 28, 255, 255, 255)
  })
  rect(W / 2 - 1, 0, W / 2 + 1, H, 40, 60, 90)
  if (!ff.stdin.write(rgb)) await new Promise(r => ff.stdin.once('drain', r))
}
ff.stdin.end()
await new Promise((res, rej) => ff.on('close', code => code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}`))))
clips.forEach(c => c.clip.free()); rig.free()
console.log(JSON.stringify({ out, vertices: n, triangles: idx.length / 3, frames: FRAMES, left: 'fall', right: 'dive' }))
process.exit(0)

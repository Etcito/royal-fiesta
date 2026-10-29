// Renders docs/media/skin-poses.mp4: two penguin characters registered through the RenderPort skin
// path (NullRenderPort.registerSkinned / setPose) with separate per-frame poses, skinned on the CPU
// from the submitted S16 skin matrices and rasterised here (no GPU). The penguin asset has no
// authored rig yet, so this tool builds a demo core rig (root, hips, spine, head, jaw) and
// height-band weights; the real rig and weights come from SDF Modeler.
// Usage: node --experimental-strip-types tools/skinPoseDemo.ts [out.mp4]
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { parseGameAsset } from '@royal-fiesta/game/gameAsset'
import { NullRenderPort } from '@royal-fiesta/game/render/nullPort'
import { repoRoot } from './bricks.ts'
import { decodeMesh } from '../apps/web/src/sdf/meshWire.ts'

type V3 = [number, number, number]
type M4 = number[]
const W = 640, H = 400, FPS = 24, FRAMES = Number(process.env.FRAMES ?? 96)
const out = process.argv[2] ?? join(repoRoot(), 'docs/media/skin-poses.mp4')
const assetPath = 'assets/common/penguin.body.asset.json'

const json = JSON.parse(readFileSync(join(repoRoot(), assetPath), 'utf8'))
const asset = await parseGameAsset(json, assetPath)
// S24: the saved mesh sdfm writes next to the asset; the server mesher is retired.
const meshPath = assetPath.replace(/\.asset\.json$/, '.mesh')
if (!existsSync(join(repoRoot(), meshPath))) throw new Error(`${meshPath} is missing: save penguin.body in sdfm first`)
const saved = decodeMesh(new Uint8Array(readFileSync(join(repoRoot(), meshPath))))
if (saved.assetId !== asset.id || saved.hash !== asset.hash) throw new Error(`${meshPath} is stale: save penguin.body in sdfm again`)
const meshed = saved as unknown as { data: { groups: { parts: { name: string; meshes: { material: string | null; positions: Float32Array; normals: Float32Array; indices: Uint32Array }[] }[] }[] } }
const part = meshed.data.groups[0].parts[0]
const colorOf = (m: string | null): V3 => {
  const hex = m === null ? '#808080' : String(json.document.materials[m]?.graph.nodes[0].params['in.base_color'] ?? '#808080')
  return [1, 3, 5].map(i => (parseInt(hex.slice(i, i + 2), 16) / 255) ** 2.2) as V3
}

// One part like sdfPort's partMesh: meshes concatenated, colour per vertex from its material.
const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [], mat: (string | null)[] = []
for (const m of part.meshes) {
  const base = pos.length / 3
  pos.push(...m.positions); nor.push(...m.normals)
  for (let v = 0; v < m.positions.length / 3; v++) { col.push(...colorOf(m.material)); mat.push(m.material) }
  for (const i of m.indices) idx.push(i + base)
}
const n = pos.length / 3

// Demo core rig in asset space; the beak (orange, upper body) follows the jaw.
let beak: V3 = [0, 0, 0], beakN = 0
for (let v = 0; v < n; v++) if (mat[v] === 'm3' && pos[v * 3 + 1] > 0) { beak = [beak[0] + pos[v * 3], beak[1] + pos[v * 3 + 1], beak[2] + pos[v * 3 + 2]]; beakN++ }
beak = beak.map(c => c / Math.max(beakN, 1)) as V3
const world: V3[] = [[0, -0.865, 0], [0, -0.45, 0], [0, 0, 0], [0, 0.32, 0], [0, beak[1], beak[2] - 0.12]]
const parents = [-1, 0, 1, 2, 3]
const rig = { format: 'raa.rig', version: 1, name: 'penguin', bones: ['root', 'hips', 'spine', 'head', 'jaw'].map((name, b) => ({
  name, parent: b === 0 ? null : ['root', 'hips', 'spine', 'head'][parents[b]],
  rest: { t: world[b].map((c, i) => c - (b === 0 ? 0 : world[parents[b]][i])), r: [0, 0, 0, 1], s: [1, 1, 1] },
})) }
const smooth = (a: number, b: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
const joints = new Uint16Array(n * 4), weights = new Float32Array(n * 4)
for (let v = 0; v < n; v++) {
  const y = pos[v * 3 + 1]
  if (mat[v] === 'm3' && y > 0) { joints.set([4, 0, 0, 0], v * 4); weights.set([1, 0, 0, 0], v * 4); continue }
  const hs = smooth(-0.5, 0.05, y), sh = smooth(0.12, 0.4, y)
  const w = [(1 - hs), hs * (1 - sh), sh]
  joints.set([1, 2, 3, 0], v * 4); weights.set([w[0], w[1], w[2], 0], v * 4)
}

const port = new NullRenderPort()
await port.init({ canvas: null, width: W, height: H, viewports: [{ x: 0, y: 0, width: W, height: H }] })
const handle = port.registerSkinned('penguin.body', { rig, clips: [], parts: [{ name: part.name, skin: { joints, weights } }] })
const chars = [port.createInstance(handle, null), port.createInstance(handle, null)]
const offsets: V3[] = [[-0.85, 0, 0], [0.85, 0, 0]]
chars.forEach((c, i) => port.setTransform(c, offsets[i], [0, 0, 0, 1], [1, 1, 1]))

const quat = (ax: V3, a: number): number[] => { const s = Math.sin(a / 2); return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(a / 2)] }
const qmul = (a: number[], b: number[]): number[] => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]]
const trs = (t: number[], q: number[]): M4 => {
  const [x, y, z, w] = q
  return [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0, 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0, t[0], t[1], t[2], 1]
}
const mul = (a: M4, b: M4): M4 => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o }
// S16: model = parent_model * TRS(local); skin = model * inverse_bind (rest rotations are identity).
function skinPose(rot: number[][], bob: number): Float32Array {
  const model: M4[] = [], out = new Float32Array(16 * rot.length)
  rig.bones.forEach((b, i) => {
    const t = [b.rest.t[0], b.rest.t[1] + (i === 0 ? bob : 0), b.rest.t[2]]
    model[i] = i === 0 ? trs(t, rot[i]) : mul(model[parents[i]], trs(t, rot[i]))
    out.set(mul(model[i], trs(world[i].map(c => -c), [0, 0, 0, 1])), i * 16)
  })
  return out
}
const X: V3 = [1, 0, 0], Y: V3 = [0, 1, 0], Z: V3 = [0, 0, 1]
const I = [0, 0, 0, 1]
function poses(f: number): Float32Array[] {
  const p = (2 * Math.PI * f) / 48
  const waddle = skinPose([I, quat(Z, 0.2 * Math.sin(p)), quat(Z, -0.12 * Math.sin(p)), qmul(quat(Y, 0.3 * Math.sin(p)), quat(Z, -0.1 * Math.sin(p))), I], 0.05 * Math.abs(Math.sin(p)))
  const cheer = skinPose([I, I, quat(X, 0.18 * Math.sin(p)), quat(X, -0.3 * Math.sin(2 * p)), quat(X, 0.45 * (0.5 + 0.5 * Math.sin(3 * p)))], 0)
  return [waddle, cheer]
}

// CPU skin + z-buffered Gouraud raster, camera in front of the pair.
const eye: V3 = [0, 0.02, 4.9], focal = 1 / Math.tan((32 * Math.PI) / 360)
const light: V3 = [0.35, 0.75, 0.55].map(c => c / Math.hypot(0.35, 0.75, 0.55)) as V3
const rgb = new Uint8Array(W * H * 3), depth = new Float32Array(W * H)
const sx = new Float32Array(n), sy = new Float32Array(n), sz = new Float32Array(n), shade = new Float32Array(n * 3)
function draw(pose: Float32Array, off: V3): void {
  for (let v = 0; v < n; v++) {
    const p = [0, 0, 0], q = [0, 0, 0]
    for (let k = 0; k < 4; k++) {
      const w = weights[v * 4 + k]; if (w === 0) continue
      const m = pose.subarray(joints[v * 4 + k] * 16)
      for (let r = 0; r < 3; r++) {
        p[r] += w * (m[r] * pos[v * 3] + m[4 + r] * pos[v * 3 + 1] + m[8 + r] * pos[v * 3 + 2] + m[12 + r])
        q[r] += w * (m[r] * nor[v * 3] + m[4 + r] * nor[v * 3 + 1] + m[8 + r] * nor[v * 3 + 2])
      }
    }
    const len = Math.hypot(q[0], q[1], q[2]) || 1
    const lam = Math.max(0, (q[0] * light[0] + q[1] * light[1] + q[2] * light[2]) / len)
    for (let c = 0; c < 3; c++) shade[v * 3 + c] = col[v * 3 + c] * (0.28 + 0.85 * lam)
    const x = p[0] + off[0] - eye[0], y = p[1] + off[1] - eye[1], z = eye[2] - (p[2] + off[2])
    sx[v] = W / 2 + (x / z) * focal * (H / 2); sy[v] = H / 2 - (y / z) * focal * (H / 2); sz[v] = z
  }
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]]
    const area = (sx[b] - sx[a]) * (sy[c] - sy[a]) - (sx[c] - sx[a]) * (sy[b] - sy[a])
    if (area === 0) continue
    const x0 = Math.max(0, Math.floor(Math.min(sx[a], sx[b], sx[c]))), x1 = Math.min(W - 1, Math.ceil(Math.max(sx[a], sx[b], sx[c])))
    const y0 = Math.max(0, Math.floor(Math.min(sy[a], sy[b], sy[c]))), y1 = Math.min(H - 1, Math.ceil(Math.max(sy[a], sy[b], sy[c])))
    for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
      const X0 = px + 0.5, Y0 = py + 0.5
      const wa = ((sx[b] - X0) * (sy[c] - Y0) - (sx[c] - X0) * (sy[b] - Y0)) / area
      const wb = ((sx[c] - X0) * (sy[a] - Y0) - (sx[a] - X0) * (sy[c] - Y0)) / area
      const wc = 1 - wa - wb
      if (wa < 0 || wb < 0 || wc < 0) continue
      const z = wa * sz[a] + wb * sz[b] + wc * sz[c], o = py * W + px
      if (z >= depth[o]) continue
      depth[o] = z
      for (let k = 0; k < 3; k++) rgb[o * 3 + k] = Math.round(255 * Math.min(1, wa * shade[a * 3 + k] + wb * shade[b * 3 + k] + wc * shade[c * 3 + k]) ** (1 / 2.2))
    }
  }
}

mkdirSync(dirname(out), { recursive: true })
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] })
for (let f = 0; f < FRAMES; f++) {
  poses(f).forEach((pose, i) => port.setPose(chars[i], pose))
  port.render()
  for (let o = 0; o < W * H; o++) { const g = 0.62 + 0.3 * (o / W / H); rgb[o * 3] = 150 * g; rgb[o * 3 + 1] = 200 * g; rgb[o * 3 + 2] = 255 * g; depth[o] = Infinity }
  chars.forEach((c, i) => draw(port.poseOf(c)!, offsets[i]))
  if (!ff.stdin.write(rgb)) await new Promise(r => ff.stdin.once('drain', r))
}
ff.stdin.end()
await new Promise<void>((res, rej) => ff.on('close', code => code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}`))))
console.log(JSON.stringify({ out, vertices: n, triangles: idx.length / 3, frames: FRAMES, beak, poses: port.calls.setPose }))
process.exit(0)

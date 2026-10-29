// Renders proofs/m20/penguin-ik.mp4: the same tick-driven graph pose (AnimDriver) without visual IK (left)
// and corrected by packages/game/src/anim/ik.ts (right), skinned from the committed GLB weights and
// rasterised on the CPU. Targets are world points converted through a non-trivial character transform:
// 0-3 s waddle on a rocking slope (foot placement) with an orbiting look target, 3-6 s grabbing a moving
// grab point (hand reach, head looks at it), 6-8 s grabbing with the targets removed (all corrections off).
// Usage: node --experimental-strip-types proofs/m20/render-ik-preview.mjs [out.mp4]
import { readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { AnimDriver } from '../../packages/game/src/anim/driver.ts'
import { loadAnimBrick } from '../../packages/game/src/anim/brick.ts'
import { VisualIk, toPoseFrame } from '../../packages/game/src/anim/ik.ts'

const W = 1280, H = 540, FPS = 30, SECONDS = 8, FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
const out = process.argv[2] ?? 'proofs/m20/penguin-ik.mp4'
const owner = JSON.parse(readFileSync('assets/common/penguin.body.asset.json', 'utf8')).document.nodes.penguin
const { bindings, smooth, ...preset } = owner.rig
const rigJson = JSON.stringify(preset), bones = preset.bones.map(b => b.name)
const driver = await AnimDriver.load(readFileSync('assets/common/penguin.animgraph.json', 'utf8'), rigJson, owner.clips.map(c => JSON.stringify(c)))
const ik = VisualIk.create(await loadAnimBrick(), rigJson)

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

// Character transform (sceneView convention) and its inverse, used only to place the sim-side world targets.
const xf = { pos: { x: 5, y: 1, z: -2 }, facing: { x: 0.6, z: 0.8 } }
const yawC = Math.cos(Math.atan2(0.6, 0.8)), yawS = Math.sin(Math.atan2(0.6, 0.8))
const toWorld = ([x, y, z], dir = false) => {
  const r = { x: x * yawC + z * yawS, y, z: -x * yawS + z * yawC }
  return dir ? r : { x: r.x + xf.pos.x, y: r.y + xf.pos.y, z: r.z + xf.pos.z }
}

const YAW = 35 * Math.PI / 180, PITCH = 16 * Math.PI / 180, DIST = 6.4, focal = 1 / Math.tan(18 * Math.PI / 180)
const light = [0.35, 0.75, 0.55].map(c => c / Math.hypot(0.35, 0.75, 0.55))
const rgb = new Uint8Array(W * H * 3), depth = new Float32Array(W * H)
const sx = new Float32Array(n), sy = new Float32Array(n), sz = new Float32Array(n), shade = new Float32Array(n * 3)
const cam = v => {
  const x = Math.cos(YAW) * v[0] + Math.sin(YAW) * v[2], z = -Math.sin(YAW) * v[0] + Math.cos(YAW) * v[2]
  return [x, Math.cos(PITCH) * (v[1] - 0.05) - Math.sin(PITCH) * z, Math.sin(PITCH) * (v[1] - 0.05) + Math.cos(PITCH) * z]
}
const project = (v, cx) => { const p = cam(v), d = DIST - p[2]; return [cx + (p[0] / d) * focal * (H / 2), H / 2 - (p[1] / d) * focal * (H / 2), d] }
const lit = (q, base) => {
  const p = cam(q), len = Math.hypot(...p) || 1, lam = Math.max(0, (p[0] * light[0] + p[1] * light[1] + p[2] * light[2]) / len)
  return base.map(c => c * (0.3 + 0.85 * lam))
}

function tri(a, b, c, ca, cb, cc) {
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])
  if (area === 0) return
  const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])))
  const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])))
  for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
    const X = px + 0.5, Y = py + 0.5
    const wa = ((b[0] - X) * (c[1] - Y) - (c[0] - X) * (b[1] - Y)) / area
    const wb = ((c[0] - X) * (a[1] - Y) - (a[0] - X) * (c[1] - Y)) / area
    const wc = 1 - wa - wb
    if (wa < 0 || wb < 0 || wc < 0) continue
    const z = wa * a[2] + wb * b[2] + wc * c[2], o = py * W + px
    if (z >= depth[o]) continue
    depth[o] = z
    for (let k = 0; k < 3; k++) rgb[o * 3 + k] = Math.round(255 * Math.min(1, wa * ca[k] + wb * cb[k] + wc * cc[k]) ** (1 / 2.2))
  }
}
function penguin(skin, cx) {
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
    shade.set(lit(q, [0, 1, 2].map(c => col[v * cstride + c])), v * 3)
    ;[sx[v], sy[v], sz[v]] = project(p, cx)
  }
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]]
    tri([sx[a], sy[a], sz[a]], [sx[b], sy[b], sz[b]], [sx[c], sy[c], sz[c]], shade.subarray(a * 3, a * 3 + 3), shade.subarray(b * 3, b * 3 + 3), shade.subarray(c * 3, c * 3 + 3))
  }
}
// The sim contact plane in the pose frame, drawn as a tiled slab so its slope reads.
function ground(p, nrm, cx) {
  const h = (x, z) => p[1] - (nrm[0] * (x - p[0]) + nrm[2] * (z - p[2])) / nrm[1]
  for (let i = 0; i < 8; i++) for (let j = 0; j < 7; j++) {
    const x0 = -2 + i * 0.5, z0 = -1.6 + j * 0.5, base = (i + j) % 2 ? [0.42, 0.52, 0.36] : [0.5, 0.6, 0.42]
    const v = [[x0, z0], [x0 + 0.5, z0], [x0 + 0.5, z0 + 0.5], [x0, z0 + 0.5]].map(([x, z]) => project([x, h(x, z), z], cx))
    const c = lit(nrm, base); tri(v[0], v[2], v[1], c, c, c); tri(v[0], v[3], v[2], c, c, c)
  }
}
function marker(p, cx, color) {
  const [x, y, d] = project(p, cx), r = 7
  for (let py = Math.round(y) - r; py <= Math.round(y) + r; py++) for (let px = Math.round(x) - r; px <= Math.round(x) + r; px++) {
    if (Math.abs(px + 0.5 - cx) > W / 4 || py < 0 || py >= H || (px - x) ** 2 + (py - y) ** 2 > r * r) continue
    const o = py * W + px; if (d > depth[o] + 0.05) continue
    rgb.set(color, o * 3)
  }
}

const vf = [
  ['IK off - graph pose', 20, 14, 'lt(t,99)'], ['IK on - rf-anim-ik corrected pose', W / 2 + 20, 14, 'lt(t,99)'],
  ['waddle on a rocking slope - foot placement, head looks at yellow target', 20, H - 40, 'lt(t,3)'],
  ['grabbing - flippers reach the red grab point, head looks at it', 20, H - 40, 'between(t,3,6)'],
  ['grabbing with targets removed - every correction inactive', 20, H - 40, 'gte(t,6)'],
].map(([text, x, y, en]) => `drawtext=fontfile=${FONT}:text='${text}':x=${x}:y=${y}:fontsize=24:fontcolor=white:borderw=2:enable='${en}'`).join(',')
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
  '-vf', vf, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] })
const bone = (pose, name, c = 3) => { const o = bones.indexOf(name) * 16 + c * 4; return [pose.model[o], pose.model[o + 1], pose.model[o + 2]] }
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const angle = (pose, target) => {
  const f = bone(pose, 'head', 2), h = bone(pose, 'head'), d = [0, 1, 2].map(k => target[k] - h[k])
  return Math.acos(Math.min(1, (f[0] * d[0] + f[1] * d[1] + f[2] * d[2]) / Math.hypot(...f) / Math.hypot(...d))) * 180 / Math.PI
}
const stats = { slope: { frames: 0, footSlopeErrOff: 0, footSlopeErrOn: 0, lookDegOff: 0, lookDegOn: 0 },
  grab: { frames: 0, tipDistOff: 0, tipDistOn: 0, lookDegOff: 0, lookDegOn: 0 }, removed: { frames: 0, maxSkinDelta: 0 } }
const actives = new Set()
for (let f = 0; f < FPS * SECONDS; f++) {
  const t = f / FPS, seg = t < 3 ? 'slope' : t < 6 ? 'grab' : 'removed', u = t - 3
  const mode = seg === 'slope' ? 0 : 5
  for (const tick of [2 * f + 1, 2 * f + 2]) {
    driver.observeTick(tick, [{ id: 1, mode, emote: 0, grounded: mode === 0, vel: toWorld([0, 0, mode === 0 ? 1.4 : 0], true) }])
  }
  const source = driver.pose(1)
  const nrm = seg === 'slope' ? [0.5 * Math.sin(t * 2.1), 1, 0.25 * Math.cos(t * 1.3)] : [0, 1, 0]
  const contact = [0, -0.95, 0.2], grab = [0.25 * Math.sin(u * 2.4), 0.4 + 0.25 * Math.cos(u * 1.9), 0.95]
  const look = seg === 'slope' ? [-1.2 + 0.7 * Math.sin(t * 1.8), 0.5 + 0.35 * Math.cos(t * 1.4), 1.6] : grab
  const targets = seg === 'slope' ? { mode, ground: { point: toWorld(contact), normal: toWorld(nrm, true) }, look: toWorld(look) }
    : seg === 'grab' ? { mode, grab: toWorld(grab), look: toWorld(look) } : { mode }
  const pose = ik.evaluate(source, xf, targets)
  actives.add(`${seg}:${JSON.stringify(pose.active)}`)
  // Draw in the pose frame: the sim's world targets come back through the same inverse transform.
  const p = toPoseFrame(targets.ground?.point ?? toWorld(contact), xf), nn = toPoseFrame(targets.ground?.normal ?? toWorld([0, 1, 0], true), xf, true)
  for (let o = 0; o < W * H; o++) { const g = 0.62 + 0.3 * (o / W / H); rgb[o * 3] = 150 * g; rgb[o * 3 + 1] = 200 * g; rgb[o * 3 + 2] = 255 * g; depth[o] = Infinity }
  ;[source, pose].forEach((ps, i) => {
    const cx = W * (0.25 + 0.5 * i)
    if (seg === 'slope') ground(p, nn, cx)
    penguin(ps.skin, cx)
    if (targets.look) marker(toPoseFrame(targets.look, xf), cx, [255, 220, 40])
    if (targets.grab) marker(toPoseFrame(targets.grab, xf), cx, [230, 40, 40])
  })
  for (let y = 0; y < H; y++) for (let x = W / 2 - 1; x <= W / 2; x++) rgb.set([40, 60, 90], (y * W + x) * 3)
  const s = stats[seg]; s.frames++
  // Foot placement keeps the animated lift above the contact height but follows the slope under the foot.
  const slopeErr = (q, lift) => Math.abs(q[1] - p[1] + (nn[0] * (q[0] - p[0]) + nn[2] * (q[2] - p[2])) / nn[1] - lift)
  if (seg === 'slope') for (const ft of ['foot.l', 'foot.r']) {
    const lift = bone(source, ft)[1] - p[1]
    s.footSlopeErrOff += slopeErr(bone(source, ft), lift) / 2; s.footSlopeErrOn += slopeErr(bone(pose, ft), lift) / 2
  }
  if (seg === 'grab') for (const tip of ['tip.l', 'tip.r']) { s.tipDistOff += dist(bone(source, tip), grab) / 2; s.tipDistOn += dist(bone(pose, tip), grab) / 2 }
  if (seg !== 'removed') { s.lookDegOff += angle(source, look); s.lookDegOn += angle(pose, look) }
  else s.maxSkinDelta = Math.max(s.maxSkinDelta, ...pose.skin.map((v, k) => Math.abs(v - source.skin[k])))
  if (!ff.stdin.write(rgb)) await new Promise(r => ff.stdin.once('drain', r))
}
ff.stdin.end()
await new Promise((res, rej) => ff.on('close', code => code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}`))))
for (const s of Object.values(stats)) for (const k of Object.keys(s)) if (k !== 'frames' && k !== 'maxSkinDelta') s[k] = +(s[k] / s.frames).toFixed(4)
const record = { out, script: 'proofs/m20/render-ik-preview.mjs', frames: FPS * SECONDS, fps: FPS, characterTransform: xf, active: [...actives], means: stats }
writeFileSync(out.replace(/\.mp4$/, '.json'), JSON.stringify(record, null, 2) + '\n')
ik.dispose(); driver.dispose()
console.log(JSON.stringify(record))
process.exit(0)

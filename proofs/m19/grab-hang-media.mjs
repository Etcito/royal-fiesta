// CPU preview of grab and hang: real S17 sampling + S18 linear-blend skinning, flat-lit software raster.
// Usage: node proofs/m19/grab-hang-media.mjs [out.mp4] [--frames=N]  (N limits frames per clip for probes)
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { loadRaaAnim } from '@etcito/raa-anim'
const out = process.argv.find(a => a.endsWith('.mp4')) ?? 'proofs/m19/penguin-grab-hang.mp4'
const limit = Number((process.argv.find(a => a.startsWith('--frames=')) ?? '').slice(9)) || Infinity
const W = 960, H = 540, PW = W / 2
const glb = readFileSync('proofs/m19/penguin-fall-dive.glb')
const jl = glb.readUInt32LE(12), gltf = JSON.parse(glb.subarray(20, 20 + jl)), bin = glb.subarray(28 + jl)
const acc = id => {
  const a = gltf.accessors[id], b = gltf.bufferViews[a.bufferView], n = a.count * { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type]
  const T = a.componentType === 5126 ? Float32Array : Uint16Array, off = bin.byteOffset + b.byteOffset + (a.byteOffset ?? 0)
  return new T(bin.buffer.slice(off, off + n * T.BYTES_PER_ELEMENT))
}
const prim = gltf.meshes[0].primitives[0], at = prim.attributes
const pos = acc(at.POSITION), nor = acc(at.NORMAL), col = acc(at.COLOR_0), jnt = acc(at.JOINTS_0), wgt = acc(at.WEIGHTS_0), idx = acc(prim.indices)
const nv = pos.length / 3
const api = await loadRaaAnim()
const asset = JSON.parse(readFileSync('assets/common/penguin.body.asset.json', 'utf8')).document.nodes.penguin
const { bindings, smooth, ...preset } = asset.rig
const rig = api.loadRig(JSON.stringify(preset))
const skinned = (skin, P, N) => {
  for (let v = 0; v < nv; v++) {
    let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0
    for (let k = 0; k < 4; k++) {
      const w = wgt[v * 4 + k]; if (!w) continue
      const m = jnt[v * 4 + k] * 16, x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2], a = nor[v * 3], b = nor[v * 3 + 1], c = nor[v * 3 + 2]
      px += w * (skin[m] * x + skin[m + 4] * y + skin[m + 8] * z + skin[m + 12])
      py += w * (skin[m + 1] * x + skin[m + 5] * y + skin[m + 9] * z + skin[m + 13])
      pz += w * (skin[m + 2] * x + skin[m + 6] * y + skin[m + 10] * z + skin[m + 14])
      nx += w * (skin[m] * a + skin[m + 4] * b + skin[m + 8] * c)
      ny += w * (skin[m + 1] * a + skin[m + 5] * b + skin[m + 9] * c)
      nz += w * (skin[m + 2] * a + skin[m + 6] * b + skin[m + 10] * c)
    }
    const l = Math.hypot(nx, ny, nz) || 1
    P.set([px, py, pz], v * 3); N.set([nx / l, ny / l, nz / l], v * 3)
  }
}
const SLOW = 1 // ticks per frame: 1 tick per frame at 30 fps is half speed
const plan = [['grab', 3], ['hang', 2]].map(([name, loops]) => {
  const def = asset.clips.find(c => c.name === name), clip = api.loadClip(rig, JSON.stringify(def))
  const frames = []
  for (let i = 0; i < Math.min(loops * def.lengthTicks / SLOW, limit); i++) {
    const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3)
    skinned(api.sampleClip(clip, (i * SLOW) % def.lengthTicks).skin, P, N); frames.push({ P, N })
  }
  return { name, frames }
})
// view basis: right (screen x) axis index/sign and depth axis; face looks down -Z (right=+X), profile looks down +X (right=+Z)
const views = [{ r: [1, 0, 0], d: [0, 0, 1] }, { r: [0, 0, 1], d: [-1, 0, 0] }]
const ext = views.map(() => ({ x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9 }))
const proj = (p, v, i) => p[i * 3] * v.r[0] + p[i * 3 + 1] * v.r[1] + p[i * 3 + 2] * v.r[2]
for (const { frames } of plan) for (const { P } of frames) for (let v = 0; v < nv; v++) views.forEach((vw, k) => {
  const x = proj(P, vw, v), y = P[v * 3 + 1], e = ext[k]
  e.x0 = Math.min(e.x0, x); e.x1 = Math.max(e.x1, x); e.y0 = Math.min(e.y0, y); e.y1 = Math.max(e.y1, y)
})
const floorY = Math.min(...Array.from({ length: nv }, (_, v) => pos[v * 3 + 1]))
const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', '30', '-i', '-',
  '-vf', ['drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:fontcolor=white:fontsize=22:x=12:y=10:text=face',
    'drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:fontcolor=white:fontsize=22:x=492:y=10:text=profile',
    ...plan.map((p, i) => {
      const a = plan.slice(0, i).reduce((s, q) => s + q.frames.length, 0), b = a + p.frames.length
      return `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:fontcolor=yellow:fontsize=24:x=(w-text_w)/2:y=h-40:enable='between(n,${a},${b - 1})':text='${p.name} (half speed)'`
    })].join(','),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', out], { stdio: ['pipe', 'inherit', 'inherit'] })
const light = (() => { const l = [0.4, 0.8, 0.45], n = Math.hypot(...l); return l.map(v => v / n) })()
for (const { frames } of plan) for (const { P, N } of frames) {
  const img = Buffer.alloc(W * H * 3), zb = new Float32Array(W * H).fill(1e9)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const g = 40 + 30 * (y / H), o = (y * W + x) * 3; img[o] = g; img[o + 1] = g + 6; img[o + 2] = g + 18 }
  views.forEach((vw, k) => {
    const e = ext[k], s = Math.min((PW - 60) / (e.x1 - e.x0), (H - 110) / (e.y1 - e.y0)), cx = (e.x0 + e.x1) / 2, cy = (e.y0 + e.y1) / 2
    const sx = i => k * PW + PW / 2 + (proj(P, vw, i) - cx) * s, sy = i => 50 + (H - 110) / 2 - (P[i * 3 + 1] - cy) * s
    const gy = Math.round(50 + (H - 110) / 2 - (floorY - cy) * s)
    if (gy >= 0 && gy < H) for (let x = k * PW + 20; x < (k + 1) * PW - 20; x++) { const o = (gy * W + x) * 3; img[o] = img[o + 1] = img[o + 2] = 110 }
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]], ax = sx(a), ay = sy(a), bx = sx(b), by = sy(b), cx2 = sx(c), cy2 = sy(c)
      const area = (bx - ax) * (cy2 - ay) - (by - ay) * (cx2 - ax); if (Math.abs(area) < 1e-6) continue
      const z = i => -(P[i * 3] * vw.d[0] + P[i * 3 + 1] * vw.d[1] + P[i * 3 + 2] * vw.d[2])
      const x0 = Math.max(k * PW, Math.floor(Math.min(ax, bx, cx2))), x1 = Math.min((k + 1) * PW - 1, Math.ceil(Math.max(ax, bx, cx2)))
      const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy2))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy2)))
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5
        const w0 = ((bx - px) * (cy2 - py) - (by - py) * (cx2 - px)) / area, w1 = ((cx2 - px) * (ay - py) - (cy2 - py) * (ax - px)) / area, w2 = 1 - w0 - w1
        if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue
        const zz = w0 * z(a) + w1 * z(b) + w2 * z(c); if (zz >= zb[y * W + x]) continue
        zb[y * W + x] = zz
        let nx = 0, ny = 0, nz = 0, r = 0, g = 0, bl = 0
        for (const [i, w] of [[a, w0], [b, w1], [c, w2]]) { nx += w * N[i * 3]; ny += w * N[i * 3 + 1]; nz += w * N[i * 3 + 2]; r += w * col[i * 4]; g += w * col[i * 4 + 1]; bl += w * col[i * 4 + 2] }
        const l = Math.hypot(nx, ny, nz) || 1, sh = 0.35 + 0.65 * Math.max(0, (nx * light[0] + ny * light[1] + nz * light[2]) / l)
        const o = (y * W + x) * 3, enc = u => Math.min(255, Math.round(255 * Math.pow(Math.max(0, u * sh), 1 / 2.2)))
        img[o] = enc(r); img[o + 1] = enc(g); img[o + 2] = enc(bl)
      }
    }
  })
  if (!ff.stdin.write(img)) await new Promise(r => ff.stdin.once('drain', r))
}
ff.stdin.end()
await new Promise((r, j) => ff.on('close', c => c ? j(Error(`ffmpeg ${c}`)) : r()))

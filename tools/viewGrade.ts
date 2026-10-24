// Studio grade of a C2 view: the SDF Modeler render has one fixed sun and grey ambient, so the plush look of ref-1
// (soft fur, sheen on the edges, a fuzzy silhouette, warm rim light, a little bloom) is added here from the
// renderer's own normals and materials passes. Geometry, materials and colours stay those of the committed assets.
import type { Rgba } from './renderViews.ts'

type V3 = [number, number, number]
export interface LegendEntry { rgb: V3; name: string }
// roughness: material name -> the asset's own `in.roughness`, which sets how glossy a candy material reads.
export interface ViewPasses { shaded: Rgba; normals: Rgba; materials: Rgba; legend: LegendEntry[]; roughness?: Record<string, number> }
export interface Relit { img: Rgba; subject: Uint8Array; plush: Uint8Array; screenNormal: Float32Array }

// Materials that are fur on the penguin (1.12): the plush body and the belly.
const PLUSH = /^penguin-(plush|belly)$/
const SHEEN: Record<string, { rgb: V3; k: number }> = {
  'penguin-plush': { rgb: [0x9f / 255, 0xb4 / 255, 1], k: 0.5 },
  'penguin-belly': { rgb: [0.86, 0.9, 1], k: 0.18 },
  'costume-fish-scarf-aqua': { rgb: [1, 1, 1], k: 0.3 },
  'costume-fish-scarf-white': { rgb: [1, 1, 1], k: 0.2 },
}
// Candy kit materials get ref-1's glossy vinyl: a hot key highlight, a broad softbox sheen from behind and a clear-coat edge.
const CANDY = /^candy-/
export function candyGloss(roughness: number): number { return clamp01((0.5 - roughness) / 0.38) }

// "#0 #e63840 penguin-plush (m1); #1 ..." from the text of a 'materials' render.
export function parseLegend(text: string): LegendEntry[] {
  const out: LegendEntry[] = []
  for (const m of text.matchAll(/#\d+ #([0-9a-f]{6}) ([\w.-]+) \(/g)) {
    const v = parseInt(m[1], 16)
    out.push({ rgb: [(v >> 16) & 255, (v >> 8) & 255, v & 255], name: m[2] })
  }
  return out
}

const unit = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l] }
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
const smooth = (a: number, b: number, x: number): number => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t) }
// Integer hash in [0, 1): fibre lengths and fur mottling, the same for every run.
export function hash01(x: number, y: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
// Smooth value noise with a cell of `cell` pixels.
function valueNoise(x: number, y: number, cell: number, seed: number): number {
  const fx = x / cell
  const fy = y / cell
  const ix = Math.floor(fx)
  const iy = Math.floor(fy)
  const tx = fx - ix
  const ty = fy - iy
  const sx = tx * tx * (3 - 2 * tx)
  const sy = ty * ty * (3 - 2 * ty)
  const h = (a: number, b: number): number => hash01(a + seed, b - seed)
  return (h(ix, iy) * (1 - sx) + h(ix + 1, iy) * sx) * (1 - sy) + (h(ix, iy + 1) * (1 - sx) + h(ix + 1, iy + 1) * sx) * sy
}

// Surface pass on the raw render (flat clear colour still in place, so the backdrop step can find it afterwards).
export function relight(p: ViewPasses, eye: V3, target: V3): Relit {
  const { width: w, height: h } = p.shaded
  const s = p.shaded.data
  const key = [s[0], s[1], s[2]]
  const n = w * h
  const subject = new Uint8Array(n)
  const mat = new Int16Array(n).fill(-1)
  for (let i = 0; i < n; i++) {
    if (Math.abs(s[i * 4] - key[0]) + Math.abs(s[i * 4 + 1] - key[1]) + Math.abs(s[i * 4 + 2] - key[2]) <= 3) continue
    subject[i] = 1
    let best = 1e9
    for (let k = 0; k < p.legend.length; k++) {
      const c = p.legend[k].rgb
      const d = Math.abs(p.materials.data[i * 4] - c[0]) + Math.abs(p.materials.data[i * 4 + 1] - c[1]) + Math.abs(p.materials.data[i * 4 + 2] - c[2])
      if (d < best) { best = d; mat[i] = k }
    }
    if (best > 60) mat[i] = -1
  }
  const plush = new Uint8Array(n)
  for (let i = 0; i < n; i++) if (mat[i] >= 0 && PLUSH.test(p.legend[mat[i]].name)) plush[i] = 1
  // The white belly shows the bump grain as grey streaks, so it gets a wider, stronger smoothing and a lighter mottle.
  const belly = p.legend.findIndex((e) => e.name === 'penguin-belly')
  const f = unit([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]])
  const r = unit([-f[2], 0, f[0]])
  const u: V3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]]
  const v: V3 = [-f[0], -f[1], -f[2]]
  // Lights in camera space, so every yaw gets the same studio: warm key upper left, cool rim from behind and above.
  const keyL = unit([-0.5 * r[0] + 0.7 * u[0] + 0.5 * v[0], -0.5 * r[1] + 0.7 * u[1] + 0.5 * v[1], -0.5 * r[2] + 0.7 * u[2] + 0.5 * v[2]])
  const rimL = unit([0.4 * r[0] + 0.6 * u[0] - 0.7 * v[0], 0.4 * r[1] + 0.6 * u[1] - 0.7 * v[1], 0.4 * r[2] + 0.6 * u[2] - 0.7 * v[2]])
  // A big softbox overhead, placed so its mirror half-vector leans 3 degrees towards the camera: a domed walkable top
  // shows a defined glossy patch and every rounded rim a streak along its crest, while a flat face stays unlit.
  const vh = unit([v[0], 0, v[2]])
  const boxH = unit([0.052 * vh[0], 0.9986, 0.052 * vh[2]])
  const keyH = unit([keyL[0] + v[0], keyL[1] + v[1], keyL[2] + v[2]])
  // Candy white (cloud puffs, stripes) sits near 1 before the grade, so it gets a longer shoulder that keeps its form.
  const white = p.legend.findIndex((e) => e.name === 'candy-white')
  const gloss = p.legend.map((e) => CANDY.test(e.name) && p.roughness?.[e.name] !== undefined ? candyGloss(p.roughness[e.name]) : 0)
  const screenNormal = new Float32Array(n * 2)
  const out = new Uint8Array(s)
  // Graded colour and white highlight per pixel; the highlights are softened before they are composited.
  const graded = new Float32Array(n * 3)
  const spec = new Float32Array(n)
  const R = 3
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!subject[i]) continue
      const nn = unit([p.normals.data[i * 4] / 127.5 - 1, p.normals.data[i * 4 + 1] / 127.5 - 1, p.normals.data[i * 4 + 2] / 127.5 - 1])
      screenNormal[i * 2] = dot(nn, r)
      screenNormal[i * 2 + 1] = -dot(nn, u)
      let c: V3 = [s[i * 4] / 255, s[i * 4 + 1] / 255, s[i * 4 + 2] / 255]
      const fres = 1 - clamp01(dot(nn, v))
      if (plush[i]) {
        // Soft fur: average out the bump grain over the same material, then a gentle mottling of tufts.
        const soft = mat[i] === belly
        const rr = soft ? 2 * R : R
        const acc = [0, 0, 0]
        let cnt = 0
        for (let dy = -rr; dy <= rr; dy++) {
          for (let dx = -rr; dx <= rr; dx++) {
            const xx = x + dx
            const yy = y + dy
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
            const j = yy * w + xx
            if (mat[j] !== mat[i]) continue
            acc[0] += s[j * 4]; acc[1] += s[j * 4 + 1]; acc[2] += s[j * 4 + 2]; cnt++
          }
        }
        const tuft = soft
          ? 0.97 + 0.07 * valueNoise(x, y, 12, 17) + 0.05 * valueNoise(x, y * 0.5, 3, 5)
          : 0.9 + 0.13 * valueNoise(x, y, 9, 17) + 0.07 * valueNoise(x, y * 0.5, 3, 5)
        const raw = soft ? 0.08 : 0.2
        c = [0, 1, 2].map((k) => (raw * c[k] + (1 - raw) * acc[k] / cnt / 255) * tuft) as V3
      }
      // Velvet sheen: cloth brightens towards grazing angles.
      const sheen = mat[i] >= 0 ? SHEEN[p.legend[mat[i]].name] : undefined
      if (sheen) {
        const sh = sheen.k * Math.pow(fres, 2.2)
        c = [0, 1, 2].map((k) => c[k] * (1 - 0.35 * sh) + sheen.rgb[k] * sh) as V3
      }
      // Half-Lambert key gives the volume the flat ambient lacks, plus a small warm lift on the lit side.
      const half = 0.5 + 0.5 * dot(nn, keyL)
      const form = 0.72 + 0.4 * half * half
      c = [c[0] * form, c[1] * form, c[2] * form]
      const kd = 0.05 * clamp01(dot(nn, keyL))
      const rim = 0.32 * Math.pow(fres, 3) * clamp01(dot(nn, rimL) + 0.35)
      c = [c[0] + kd * 1 + rim * 0.95, c[1] + kd * 0.95 + rim * 0.97, c[2] + kd * 0.85 + rim]
      // Candy grade: a little more saturation and contrast, with a soft shoulder so the white belly keeps its form.
      const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
      const g = mat[i] >= 0 ? gloss[mat[i]] : 0
      // White highlights go on after the grade (screen blend), so they stay white instead of being saturated.
      if (g > 0) spec[i] = g * (0.7 * Math.pow(clamp01(dot(nn, keyH)), 140) + 0.32 * smooth(0.989, 0.9996, dot(nn, boxH)) + 0.2 * Math.pow(fres, 3))
      for (let k = 0; k < 3; k++) {
        const t = Math.max(0, 0.45 + (l + (c[k] - l) * (plush[i] ? 0.95 : 1.12) - 0.45) * 1.08)
        const [k0, kw] = mat[i] === white && white >= 0 ? [0.62, 0.42] : [0.8, 0.2]
        graded[i * 3 + k] = t < k0 ? t : k0 + kw * (1 - Math.exp(-(t - k0) / kw))
      }
    }
  }
  // The normals pass is 8-bit, so a narrow lobe bands; a small blur turns the steps into a smooth glossy patch.
  for (let pass = 0; pass < 2; pass++) { boxBlur(spec, w, h, 2, true); boxBlur(spec, w, h, 2, false) }
  for (let i = 0; i < n; i++) {
    if (!subject[i]) continue
    const sp = clamp01(spec[i])
    for (let k = 0; k < 3; k++) out[i * 4 + k] = Math.round(255 * (graded[i * 3 + k] + (1 - graded[i * 3 + k]) * sp))
  }
  // The renderer does not anti-alias material borders (white rings and zigzags step in a sawtooth), so pixels within
  // 2 px of a candy border get a 5x5 mean.
  const src = new Uint8Array(out)
  const E = 2
  for (let y = E; y < h - E; y++) {
    for (let x = E; x < w - E; x++) {
      const i = y * w + x
      if (!subject[i] || mat[i] < 0 || gloss[mat[i]] === 0) continue
      let border = false
      for (let d = 1; d <= E && !border; d++) border = mat[i - d] !== mat[i] || mat[i + d] !== mat[i] || mat[i - d * w] !== mat[i] || mat[i + d * w] !== mat[i]
      if (!border) continue
      const acc = [0, 0, 0]
      let cnt = 0
      for (let dy = -E; dy <= E; dy++) {
        for (let dx = -E; dx <= E; dx++) {
          const j = i + dy * w + dx
          if (!subject[j]) continue
          acc[0] += src[j * 4]; acc[1] += src[j * 4 + 1]; acc[2] += src[j * 4 + 2]; cnt++
        }
      }
      for (let k = 0; k < 3; k++) out[i * 4 + k] = Math.round(acc[k] / cnt)
    }
  }
  return { img: { width: w, height: h, data: out }, subject, plush, screenNormal }
}

// Fuzzy silhouette: short fur fibres grow out of every plush edge along its screen normal, then bloom on the highlights.
export function fuzzAndBloom(staged: Rgba, relit: Relit): Rgba {
  const { width: w, height: h } = staged
  const out = new Uint8Array(staged.data)
  const src = relit.img.data
  const R = 5
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (relit.subject[i]) continue
      let best = -1
      let bd = 1e9
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx
          const yy = y + dy
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
          const j = yy * w + xx
          const d = dx * dx + dy * dy
          if (relit.plush[j] && d < bd) { bd = d; best = j }
        }
      }
      if (best < 0) continue
      const d = Math.sqrt(bd)
      let nx = relit.screenNormal[best * 2]
      let ny = relit.screenNormal[best * 2 + 1]
      const nl = Math.hypot(nx, ny) || 1
      nx /= nl
      ny /= nl
      // One fibre per 2-pixel slice across the normal, with its own length.
      const fibre = Math.floor((x * -ny + y * nx) / 2)
      const len = R * (0.25 + 0.75 * hash01(fibre, 7))
      if (d >= len) continue
      const a = 0.85 * (1 - d / len)
      for (let k = 0; k < 3; k++) out[i * 4 + k] = Math.round(out[i * 4 + k] * (1 - a) + src[best * 4 + k] * a)
    }
  }
  // Bloom: the subject's bright parts, blurred wide, added back.
  const n = w * h
  const glow = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
  for (let i = 0; i < n; i++) {
    if (!relit.subject[i]) continue
    const l = (0.2126 * out[i * 4] + 0.7152 * out[i * 4 + 1] + 0.0722 * out[i * 4 + 2]) / 255
    const b = Math.max(0, l - 0.8) / 0.2
    for (let k = 0; k < 3; k++) glow[k][i] = b * out[i * 4 + k] / 255
  }
  for (const g of glow) for (let pass = 0; pass < 3; pass++) { boxBlur(g, w, h, 14, true); boxBlur(g, w, h, 14, false) }
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) out[i * 4 + k] = Math.round(Math.min(255, out[i * 4 + k] + 255 * 0.3 * glow[k][i]))
  return { width: w, height: h, data: out }
}

// In-place box blur of radius r along rows (horizontal) or columns, clamped at the edges.
function boxBlur(a: Float32Array, w: number, h: number, r: number, horizontal: boolean): void {
  const len = horizontal ? w : h
  const lines = horizontal ? h : w
  const line = new Float32Array(len)
  for (let l = 0; l < lines; l++) {
    const at = (k: number): number => horizontal ? l * w + k : k * w + l
    for (let k = 0; k < len; k++) line[k] = a[at(k)]
    let sum = 0
    for (let k = -r; k <= r; k++) sum += line[Math.min(len - 1, Math.max(0, k))]
    for (let k = 0; k < len; k++) {
      a[at(k)] = sum / (2 * r + 1)
      sum += line[Math.min(len - 1, k + r + 1)] - line[Math.max(0, k - r)]
    }
  }
}

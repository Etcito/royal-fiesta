// Build-time placeholders from the saved polygon meshes, through the game's RAA renderer.
import type { Engine } from '@etcito/raa'
import { LOCAL_COSMETICS } from '@royal-fiesta/game/flow/startScreen'
import { createRaaEngine } from '../../render/raaEngine.ts'
import { decodeMesh } from '../../sdf/meshWire.ts'
import type { TourDeps } from '../uiTour.ts'
import { pendingPipelines } from '../../render/asyncPipelines.ts'
import { nextTask } from './boot.ts'
export const name = 'cosmeticThumbs'
export async function run(_input: unknown, deps: TourDeps) {
  const files: { name: string; blob: Blob }[] = []
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256
  const output = document.createElement('canvas'); output.width = output.height = 256
  const ctx = output.getContext('2d', { willReadFrequently: true })!
  const meshes = new Map()
  for (const base of LOCAL_COSMETICS.filter(c => c.id === c.asset)) {
    const response = await fetch(new URL(`content/assets/common/${base.asset}.mesh`, document.baseURI))
    if (!response.ok) throw new Error(`Missing saved mesh: ${base.asset}`)
    meshes.set(base.asset, decodeMesh(new Uint8Array(await response.arrayBuffer())))
  }
  const engine = await createRaaEngine(canvas, { maxInstances: 1024, maxMaterials: 1024 })
  engine.resize(256, 256)
  engine.applyEnvironment({ sky: 'day', fog: 'clear', post: 'neutral' })
  engine.setLight({ direction: [-.4, -1, -.8], color: [1, 1, 1], intensity: 3 })
  engine.setAmbient({ color: [.8, .85, 1], intensity: .8 })
  try {
    for (const pass of ['sky.background', 'fog', 'bloom', 'grading', 'ao.gtao', 'shadow.contact', 'shadow.csm']) engine.setPassEnabled(pass, false)
    for (const item of LOCAL_COSMETICS) {
      const root = engine.addNode(null)
      const data = meshes.get(item.asset).data as { materials: { name: string; constants: number[] }[]; groups: { parts: { frame: Float64Array; meshes: { positions: Float32Array; normals: Float32Array; indices: Uint32Array; material: string }[] }[] }[] }
      const fallback = engine.addMaterial({ color: [.8, .8, .8], model: 'pbr' })
      const materials = new Map<string, number>()
      for (const material of data.materials) {
        const floats = new Float32Array(new Uint32Array(material.constants).buffer)
        const color = [floats[3], floats[4], floats[5]].map((c, i) => Math.max(0, Math.min(1, c * (item.tint?.[i] ?? 1)))) as [number, number, number]
        materials.set(material.name, engine.addMaterial({ color, model: 'pbr', emissive: color.map(c => c*.15) as [number,number,number], roughness: .45, metallic: Math.max(0, Math.min(1, floats[6] ?? 0)) }))
      }
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
      for (const group of data.groups) for (const part of group.parts) for (const mesh of part.meshes) {
        const f = part.frame
        const positions = new Float32Array(mesh.positions.length), normals = new Float32Array(mesh.normals.length)
        for (let i = 0; i < mesh.positions.length; i += 3) for (let axis = 0; axis < 3; axis++) {
          const p = mesh.positions
          const v = f[axis] * p[i] + f[4 + axis] * p[i + 1] + f[8 + axis] * p[i + 2] + f[12 + axis]
          positions[i+axis] = v
          normals[i+axis] = f[axis]*mesh.normals[i] + f[4+axis]*mesh.normals[i+1] + f[8+axis]*mesh.normals[i+2]
          lo[axis] = Math.min(lo[axis], v); hi[axis] = Math.max(hi[axis], v)
        }
        const handle = engine.addMesh({ positions, normals, indices: mesh.indices })
        const instance = engine.addInstance(engine.addNode(root), handle, materials.get(mesh.material) ?? fallback)
        engine.setInstanceTint(instance, [1, 1, 1, 1])
      }
      const center = lo.map((v, i) => (v + hi[i]) / 2) as [number, number, number]
      const radius = Math.hypot(...hi.map((v, i) => v - lo[i])) / 2
      const distance = radius / Math.sin(32 * Math.PI / 360) * 1.12
      engine.setCamera( { eye: [center[0] + distance * .18, center[1] + distance * .12, center[2] + distance], target: center, fovYDeg: 32, near: .01, far: 100 })
      const pixels = async (white: boolean) => {
        engine.setBackground(white ? [1, 1, 1] : [0, 0, 0])
        engine.render(performance.now())
        const deadline = Date.now() + 30000
        while (pendingPipelines() > 0 && Date.now() < deadline) { await nextTask(); engine.render(performance.now()) }
        for (let warmup = 0; warmup < 4; warmup++) { engine.render(performance.now()); await new Promise(resolve => setTimeout(resolve, 20)) }
        engine.render(performance.now())
        const bitmap = await createImageBitmap(canvas); ctx.clearRect(0, 0, 256, 256); ctx.drawImage(bitmap, 0, 0); bitmap.close()
        return ctx.getImageData(0, 0, 256, 256)
      }
      // Two GPU backgrounds recover coverage even on RAA releases with an opaque swapchain.
      const black = await pixels(false), white = await pixels(true)
      for (let i = 0; i < black.data.length; i += 4) {
        const alpha = 255 - Math.max(white.data[i] - black.data[i], white.data[i+1] - black.data[i+1], white.data[i+2] - black.data[i+2])
        for (let c = 0; c < 3; c++) black.data[i+c] = alpha > 0 ? Math.min(255, black.data[i+c] * 255 / alpha) : 0
        black.data[i+3] = alpha
      }
      let brightest = 0
      for (let i = 0; i < black.data.length; i += 4) if (black.data[i+3] > 64) brightest = Math.max(brightest, black.data[i], black.data[i+1], black.data[i+2])
      if (brightest < 20) throw new Error(`Unlit thumbnail: ${item.id}`)
      ctx.putImageData(black, 0, 0)
      const blob = await new Promise<Blob | null>(resolve => output.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('Thumbnail encoding failed')
      files.push({ name: `${item.id}.png`, blob })
      engine.removeNode(root)
    }
  } finally { engine.dispose() }
  return { json: { ok: files.filter(f => f.name.startsWith('costume.')).length === 36, items: files.map(f => f.name), adapter: await deps.adapter() }, files }
}

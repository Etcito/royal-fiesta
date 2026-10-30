// Dedicated asset views, separate from the mech-lab course capture. Uses the game's mesher,
// material upload and body part filter. Poses show the authored travel limits, not simulated motion.
import { parseGameAsset } from '@royal-fiesta/game/gameAsset'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { Vec3T } from '@royal-fiesta/game/render/port'
import { loadMamaFacade, meshRequestOf } from '../sdf/mamaApi.ts'
import type { MeshedAsset } from '../sdf/mamaApi.ts'
import { createSdfPort } from '../sdf/sdfPort.ts'
import { limitPoseOf } from './limitPose.ts'
import { pendingPipelines } from '../render/asyncPipelines.ts'

const IDS = ['candy.mech-seesaw', 'candy.mech-plate'] as const
interface Input { probe?: boolean; firstAsset?: boolean; width?: number; height?: number }
interface Adapter {
  info?: { vendor?: string; architecture?: string; description?: string }
  isFallbackAdapter?: boolean
}

async function hardware() {
  const gpu = (navigator as Navigator & {
    gpu?: { requestAdapter(): Promise<Adapter | null> }
  }).gpu
  const adapter = await gpu?.requestAdapter()
  if (!adapter) throw new Error('Candy asset proof requires WebGPU on the GPU client')
  const info = adapter.info ?? {}
  if (adapter.isFallbackAdapter || /swiftshader|software|llvmpipe/i.test(JSON.stringify(info))) {
    throw new Error('Candy asset proof requires a hardware adapter')
  }
  return { ...info, software: false }
}

async function candyAssets(input: Input) {
  if (input.probe) return { json: { ok: true }, files: [] }
  const adapter = await hardware()
  const width = input.width ?? 1280
  const height = input.height ?? 960
  if (![width, height].every(n => Number.isInteger(n) && n >= 128 && n <= 1920)) {
    throw new Error('Use integer dimensions in 128..1920')
  }
  const mama = await loadMamaFacade()
  const pool = mama.createPool(1)
  const meshed = new Map<string, MeshedAsset>()
  const assets = []
  try {
    for (const id of input.firstAsset ? IDS.slice(0, 1) : IDS) {
      const path = `assets/candy/${id}.asset.json`
      const response = await fetch(new URL(`content/${path}`, document.baseURI))
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
      const asset = await parseGameAsset(await response.json(), path)
      assets.push(asset)
      meshed.set(id, await pool.mesh(meshRequestOf(asset), 60000))
    }
  } finally {
    pool.close()
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  document.body.append(canvas)
  const port = await createSdfPort({ canvas, width, height, viewports: [{ x: 0, y: 0, width, height }] }, meshed)
  const files: { name: string; blob: Blob }[] = []
  const captures = []
  try {
    port.setEnvironment(null)
    for (const asset of assets) {
      const visual = port.registerAsset(asset.id, { id: asset.id } as PrimsAsset)
      const bodies = asset.physics!.bodies.map(body => {
        const instance = port.createInstance(visual, null)
        port.setPartFilter(instance, body.parts)
        port.setTransform(instance, body.t, body.r, [1, 1, 1])
        return { body, instance }
      })
      const seesaw = asset.id === IDS[0]
      // Rest views are kept. The limit view of the seesaw looks along the hinge axis from the side, so the plank
      // reads as a slope against the level foot; the plate dip is seen from a low, close angle.
      const views: Record<'rest' | 'limit', { eye: Vec3T; target: Vec3T }> = {
        rest: seesaw
          ? { eye: [7, 5.8, 8], target: [0, 0.7, 0] }
          : { eye: [2.8, 2.6, 3.4], target: [0, -0.06, 0] },
        limit: seesaw
          ? { eye: [7, 3.5, 0], target: [0, 1.15, 0] }
          : { eye: [2.2, 1.2, 2.6], target: [0, -0.06, 0] },
      }
      for (const pose of input.firstAsset ? ['rest'] as const : ['rest', 'limit'] as const) {
        port.setCamera(0, { ...views[pose], fovYDeg: 40, near: 0.05, far: 100 })
        if (pose === 'limit') {
          const limit = limitPoseOf(asset)
          const moving = bodies.find(b => b.body.id === limit.body)!
          port.setTransform(moving.instance, limit.t, limit.r, [1, 1, 1])
        }
        // Shader compilation is asynchronous in the game renderer. Never capture its placeholder draws.
        port.render()
        const deadline = performance.now() + 30000
        while (pendingPipelines() > 0) {
          if (performance.now() > deadline) throw new Error('Candy asset pipelines did not become ready in 30 s')
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        const stats = port.render()
        if (stats.triangles === 0 || stats.drawCalls === 0) throw new Error(`${asset.id}: empty render`)
        const bytes = await port.capture()
        if (!bytes?.length) throw new Error(`${asset.id}: no PNG`)
        const name = `${asset.id}-${pose}.png`
        files.push({ name, blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }) })
        captures.push({ name, asset: asset.id, pose, parts: bodies.map(b => b.body.parts), triangles: stats.triangles })
      }
      for (const b of bodies) port.destroyInstance(b.instance)
    }
    return { json: { renderer: 'raa', adapter, width, height, captures }, files }
  } finally {
    port.dispose()
    canvas.remove()
  }
}

// This page has its own manifest and does not alter the game's operation registry.
Object.assign(window, { nmcGpu: { ops: { candyAssets } } })

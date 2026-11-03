// Opt-in real-App profiler. Wrappers are restored on exit and never alter simulation inputs.
import type { TourDeps, TourGame } from '../uiTour.ts'
import { nextTask, yieldTask, publishPhase } from './boot.ts'
import { ShowMode } from '../showMode.ts'
import { FiestaDomain } from '@royal-fiesta/sim/zones/fiestaDomain'
import { MatchLedger } from '@royal-fiesta/sim/zones/ledger'
import { CharacterSystem } from '@royal-fiesta/sim/character/system'
import { SceneView } from '@royal-fiesta/game/render/sceneView'
import { AnimDriver } from '@royal-fiesta/game/anim/driver'
import { DomainSceneSim } from '../../zone/domainSceneSim.ts'
export const name = 'botPerf'
// This diagnostic deliberately uses runtime access to private presentation fields, without exporting them.
type Obj = Record<string, any>
export async function run(raw: unknown, deps: TourDeps) {
  const input = (raw ?? {}) as { counts?: number[]; frames?: number; scenarios?: { n: number; cull?: boolean; yaw?: number }[]; capture?: boolean }
  let currentCull: boolean | undefined, currentYaw: number | undefined
  const files: { name: string; blob: Blob }[] = []
  const undo: (() => void)[] = []
  let values: Record<string, number> = {}, active = false
  const add = (key: string, n: number) => { if (active) values[key] = (values[key] ?? 0) + n }
  const wrapped = new WeakMap<object, Set<string>>()
  function wrap(target: Obj, key: string, metric: string, before?: (self: Obj) => void, after?: (self: Obj) => void) {
    if (typeof target[key] !== 'function') return
    let keys = wrapped.get(target); if (!keys) wrapped.set(target, keys = new Set())
    if (keys.has(key)) return; keys.add(key)
    const own = Object.getOwnPropertyDescriptor(target, key), original = target[key]
    target[key] = function(this: Obj, ...args: any[]) {
      before?.(this)
      const t = performance.now()
      try { return original.apply(this, args) } finally { add(metric, performance.now() - t); after?.(this) }
    }
    undo.push(() => { if (own) Object.defineProperty(target, key, own); else delete target[key] })
  }
  let domain: FiestaDomain | undefined
  wrap(FiestaDomain.prototype, 'step', 'domain', self => {
    domain = self as FiestaDomain
    const world = self.ctx.physics.world
    world.profilerEnabled = true
    wrap(world, 'step', 'physics', undefined, w => {
      add('broadphase', w.timingBroadPhase()); add('narrowphase', w.timingNarrowPhase()); add('solver', w.timingSolver())
    })
  })
  wrap(FiestaDomain.prototype, 'state', 'stateRead')
  wrap(CharacterSystem.prototype, 'bindBodies', 'binding')
  for (const key of ['preStep', 'postStep']) wrap(CharacterSystem.prototype, key, 'controller')
  wrap(ShowMode.prototype, 'sample', 'ai')
  wrap(MatchLedger.prototype, 'step', 'ledger')
  wrap(ShowMode.prototype, 'frame', 'show', self => { if (currentYaw !== undefined && self.options.orbit) self.options.orbit.yaw = currentYaw })
  wrap(AnimDriver.prototype, 'observeTick', 'animation', undefined, a => { add('graphsEvaluated', a.cacheStats.evaluated); add('ikEvaluated', a.cacheStats.ikEvaluated) })
  wrap(DomainSceneSim.prototype, 'refresh', 'scene')
  const ports = new Set<Obj>()
  wrap(SceneView.prototype, 'update', 'view', self => {
    if (currentCull === false) self.opts.crowdAspect = undefined
    const port = self.port
    if (ports.has(port)) return
    ports.add(port)
    wrap(port, 'setPose', 'setPose')
    wrap(port, 'flushPoses', 'upload')
    wrap(port, 'render', 'render', undefined, p => {
      let vertices = 0, skinned = 0
      for (const live of p.live ?? []) if (live?.visible && live.bones > 0) {
        skinned++
        for (const slot of live.skin) vertices += slot.part.desc.positions.length / 3
      }
      add('visibleSkinVertices', vertices); add('skinnedCharacters', skinned)
    })
    if (port.engine) wrap(port.engine, 'render', 'drawBuild')
  })
  // Timestamp every render/compute pass on every device (world and UI). Serial readback
  // bounds queue depth; GPU pass time is independent of host scheduling and iframe rAF throttling.
  const g = globalThis as Obj
  const devices: { device: any; query: any; resolve: any; read: any; count: number; labels: string[] }[] = []
  const adapterProto = g.GPUAdapter?.prototype
  if (!adapterProto) throw new Error('GPUAdapter unavailable')
  const request = adapterProto.requestDevice
  adapterProto.requestDevice = async function(desc: Obj = {}) {
    const enabled = this.features.has('timestamp-query')
    const device = await request.call(this, { ...desc, requiredFeatures: [...new Set([...(desc.requiredFeatures ?? []), ...(enabled ? ['timestamp-query'] : [])])] })
    if (!enabled) throw new Error('Hardware timestamp-query required')
    const rec = { device, query: device.createQuerySet({ type: 'timestamp', count: 1024 }),
      resolve: device.createBuffer({ size: 8192, usage: 512 | 4 }), read: device.createBuffer({ size: 8192, usage: 1 | 8 }), count: 0, labels: [] as string[] }
    devices.push(rec)
    const create = device.createCommandEncoder.bind(device)
    device.createCommandEncoder = (...args: any[]) => {
      const enc = create(...args)
      for (const key of ['beginRenderPass', 'beginComputePass']) {
        const begin = enc[key].bind(enc)
        enc[key] = (d: Obj = {}) => {
          let q = d
          if (active && rec.count < 1022) {
            const index = rec.count; rec.count += 2; rec.labels.push(String(d.label ?? key))
            q = { ...d, timestampWrites: { querySet: rec.query, beginningOfPassWriteIndex: index, endOfPassWriteIndex: index + 1 } }
          }
          const pass = begin(q)
          if (active) {
            add(key === 'beginRenderPass' ? 'renderPasses' : 'computePasses', 1)
            let lastPipeline: any
            const pipeline = pass.setPipeline.bind(pass)
            pass.setPipeline = (p: any) => { add('pipelineBinds', 1); if (p !== lastPipeline) add('pipelines', 1); lastPipeline = p; return pipeline(p) }
            for (const draw of ['draw', 'drawIndexed']) if (pass[draw]) {
              const orig = pass[draw].bind(pass)
              pass[draw] = (...a: number[]) => { add('draws', 1); add('triangles', a[0] * (a[1] ?? 1) / 3); return orig(...a) }
            }
          }
          return pass
        }
      }
      return enc
    }
    return device
  }
  undo.push(() => { adapterProto.requestDevice = request })
  async function gpuTimes() {
    let ms = 0; const passes: Record<string, number> = {}
    for (const rec of devices) {
      if (!rec.count) continue
      const enc = rec.device.createCommandEncoder()
      enc.resolveQuerySet(rec.query, 0, rec.count, rec.resolve, 0)
      enc.copyBufferToBuffer(rec.resolve, 0, rec.read, 0, rec.count * 8)
      rec.device.queue.submit([enc.finish()])
      await rec.read.mapAsync(1)
      const ns = new BigUint64Array(rec.read.getMappedRange())
      for (let j = 0; j < rec.count; j += 2) {
        const t = Number(ns[j + 1] - ns[j]) / 1e6
        ms += t; const label = rec.labels[j / 2]; passes[label] = (passes[label] ?? 0) + t
      }
      rec.read.unmap(); rec.count = 0; rec.labels = []
    }
    return { ms, passes }
  }
  const results: unknown[] = []
  let game: TourGame | null = null
  try {
    const adapter = await deps.adapter()
    if (adapter.software) throw new Error('Refusing software GPU')
    for (const scenario of input.scenarios ?? (input.counts ?? [8, 20, 40, 60]).map(n => ({ n, cull: undefined, yaw: undefined }))) {
      const { n } = scenario
      currentCull = scenario.cull; currentYaw = scenario.yaw
      let screen = ''
      game = await deps.boot(e => { screen = e.to }, { search: `?test=1&course=s1-c1-diamond-citadel&bots=${n}` })
      let frames = 0
      while (screen !== 'round') {
        if (screen === 'error' || frames++ > 4000) throw new Error(`Boot N=${n} screen=${screen} ${JSON.stringify(game.inventory())}`)
        game.step(1/60)
        if (screen === 'hub') { window.dispatchEvent(new KeyboardEvent('keydown', {code:'Enter', bubbles:true})); window.dispatchEvent(new KeyboardEvent('keyup', {code:'Enter', bubbles:true})) }
        await yieldTask(screen)
      }
      // The screen transition can arrive one tick earlier when async loading resolves.
      // Align the sampling window by simulation tick, rather than by UI callbacks.
      while (domain && domain.tick < 190) { game.step(1/60); await nextTask() }
      const rows: Record<string, number>[] = [], passTotals: Record<string, number> = {}
      for (let i = 0; i < (input.frames ?? 240); i++) {
        values = {}; active = true
        const start = performance.now(); game.step(1/60); values.cpu = performance.now() - start
        active = false
        const gpu = await gpuTimes(); values.gpu = gpu.ms
        for (const [k,v] of Object.entries(gpu.passes)) passTotals[k] = (passTotals[k] ?? 0) + v
        if (domain) { values.bodies = domain.ctx.physics.world.bodies.len(); values.colliders = domain.ctx.physics.world.colliders.len() }
        values.logic = (values.domain ?? 0) - (values.physics ?? 0) - (values.controller ?? 0) + (values.ledger ?? 0)
        values.scene = (values.scene ?? 0) + (values.view ?? 0) - (values.animation ?? 0) - (values.setPose ?? 0)
        values.animationPose = (values.animation ?? 0) + (values.setPose ?? 0) + (values.upload ?? 0)
        rows.push(values)
        if (i % 60 === 0) publishPhase(`botPerf ${n}: ${i}`)
        await nextTask()
      }
      const keys = [...new Set(rows.flatMap(Object.keys))]
      const mean = Object.fromEntries(keys.map(k => [k, rows.reduce((s,r) => s + (r[k] ?? 0),0)/rows.length]))
      const sorted = rows.map(r=>r.cpu).sort((a,b)=>a-b)
      const state = domain ? { tick: domain.tick, states: domain.seats.map(seat => ({ ...structuredClone(domain!.state(seat)), status: domain!.status(seat) })) } : null
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(state)))
      const stateHash = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('')
      const canvas = game.views.querySelector<HTMLCanvasElement>('canvas[data-show]')
      if (input.capture && canvas) {
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
        if (blob) files.push({ name: `crowd-${n}-${currentCull === false ? 'before' : 'after'}-${currentYaw ?? 0}.png`, blob })
      }
      results.push({ n, cull: currentCull, yaw: currentYaw, canvas: canvas ? [canvas.width, canvas.height] : null, stateHash, simTick: domain?.tick, frames: rows.length, mean, cpuP95: sorted[Math.ceil(sorted.length*.95)-1], passMs: Object.fromEntries(Object.entries(passTotals).map(([k,v])=>[k,v/rows.length])), inventory: game.inventory(), physicsBodies: domain?.ctx.physics.world.bodies.len(), colliders: domain?.ctx.physics.world.colliders.len(), rows })
      game.dispose(); game = null
    }
    return { json: { ok:true, adapter, results }, files }
  } finally {
    active = false; game?.dispose()
    for (const restore of undo.reverse()) restore()
  }
}

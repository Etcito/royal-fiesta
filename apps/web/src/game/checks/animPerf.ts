import { initRapier } from '@gamesaloon/rollback-rapier'
import { AnimDriver } from '../../../../../packages/game/src/anim/driver.ts'
import { VisualIk } from '../../../../../packages/game/src/anim/ik.ts'
import { createOfflineMatch } from '@royal-fiesta/game/net/offlineMatch'
import { newModeBotMemory, modeBotInput } from '@royal-fiesta/game/net/modeBots'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import type { MatchSim } from '@royal-fiesta/sim/match/matchSim'
import { SceneView } from '@royal-fiesta/game/render/sceneView'
import { PALETTE } from '@royal-fiesta/game/render/palette'
import type { RenderPort } from '@royal-fiesta/game/render/port'
import { DomainSceneSim } from '../../zone/domainSceneSim.ts'
import { zoneContent } from '../../zone/zoneContent.ts'
import { loadShowContent } from '../showContent.ts'
import { animPerfGpu } from '../animPerfGpu.ts'
import { pendingPipelines } from '../../render/asyncPipelines.ts'
import type { TourDeps } from '../uiTour.ts'
export const name = 'animPerf'
const DT = 1 / 60
const realNow = performance.now.bind(performance)
interface OpFile {
  name: string
  blob: Blob
}
function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  document.body.appendChild(canvas)
  return canvas
}
async function renderPng(port: RenderPort, what: string): Promise<Uint8Array> {
  port.render()
  const deadline = realNow() + 45000
  while (pendingPipelines() > 0) {
    if (realNow() > deadline)
      throw new Error(`Pipeline readiness timed out at ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  port.render()
  const png = await port.capture()
  if (!png?.length)
    throw new Error(`Empty capture at ${what}`)
  return png
}
async function record(name: string, png: Uint8Array, files: OpFile[]): Promise<void> {
  files.push({ name: `${name}.png`, blob: new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }) })
}
function yieldToBrowser(): Promise<void> { return new Promise(resolve => setTimeout(resolve, 0)); }
// Real round workload; timings use the browser clock and include the normal sim observer.
export async function run(raw: unknown, deps: TourDeps) {
  const input = (raw ?? {}) as {
    cache?: boolean
  }
  const load = AnimDriver.load
  AnimDriver.load = (graph, rig, clips, opts) => load(graph, rig, clips, { ...opts, cache: input.cache !== false })
  const gpuTimer = animPerfGpu()
  const R = await initRapier(), adapter = await deps.adapter()
  const show = await loadShowContent('sprint')
  const course = show.courses.find(c => c.kind === 'race')!
  const content = await zoneContent('sprint', course.id)
  const canvas = makeCanvas(1280, 720)
  const port = await content.createPort({ canvas, width: 1280, height: 720, viewports: [{ x: 0, y: 0, width: 1280, height: 720 }] })
  const skin = content.skinned
  if (!skin || !port.setPose)
    throw new Error('animPerf requires the real skinned penguin')
  const rows: unknown[] = []
  const files: OpFile[] = []
  let cacheCounts = { evaluated: 0, shared: 0, ikEvaluated: 0, ikShared: 0 }
  let graphMs = 0
  const graphProtos = new Map<any, any>()
  let animMs = 0, uploadMs = 0, flushMs = 0, ikMs = 0
  const evaluate = VisualIk.prototype.evaluate
  VisualIk.prototype.evaluate = function (...args) { const t = realNow(); try {
    return evaluate.apply(this, args)
  }
  finally {
    ikMs += realNow() - t
  } }
  const engine = (port as unknown as {
    engine: {
      setSkinPoses(...args: unknown[]): void
    }
  }).engine
  const flush = engine.setSkinPoses.bind(engine)
  engine.setSkinPoses = (...args) => { const t = realNow(); try {
    return flush(...args)
  }
  finally {
    flushMs += realNow() - t
  } }
  const observe = AnimDriver.prototype.observeTick
  const setPose = port.setPose.bind(port)
  AnimDriver.prototype.observeTick = function (tick, characters) {
    for (const entry of (this as any).entries.values()) {
      const proto = Object.getPrototypeOf(entry.execution?.graph ?? entry.graph ?? (this as any).graph)
      if (!graphProtos.has(proto)) {
        const step = proto.step
        graphProtos.set(proto, step)
        proto.step = function (...args: any[]) { const t = realNow(); try {
          return step.apply(this, args)
        }
        finally {
          graphMs += realNow() - t
        } }
      }
    }
    const t = realNow()
    try {
      return observe.call(this, tick, characters)
    }
    finally {
      animMs += realNow() - t
      for (const key of Object.keys(cacheCounts) as (keyof typeof cacheCounts)[])
        cacheCounts[key] += this.cacheStats?.[key] ?? 0
    }
  }
  port.setPose = (id, matrices) => { const t = realNow(); setPose(id, matrices); uploadMs += realNow() - t; }
  try {
    for (const count of [12, 30, 60]) {
      const match = createOfflineMatch(R, { course, zones: show.zones.get(course.id)!, seatCount: count, kind: 'race', profile: PROFILES.sprint })
      const adapter = new DomainSceneSim(course, count)
      const sim = adapter as unknown as MatchSim
      const memories = Array.from({ length: count }, () => newModeBotMemory())
      const step = () => { match.frame(DT, out => { for (let i = 0; i < count; i++)
        modeBotInput(match.domains[0], memories[i], i, match.stats.tick, out[i]); }); adapter.refresh(match.domains, match.stats.tick); }
      const scene = new SceneView({ port, viewport: 0, localPlayer: 0, assets: n => content.assets(n),
        bean: content.character, character: content.character, skinned: skin, loadingPaint: false,
        camera: focus => ({ eye: [focus.x + 10, focus.y + 12, focus.z + 18], target: [focus.x, focus.y, focus.z], fovYDeg: 60, near: 0.1, far: 200 }) })
      cacheCounts = { evaluated: 0, shared: 0, ikEvaluated: 0, ikShared: 0 }
      const gpuSamples: number[] = []
      const rafSamples: number[] = []
      let lastRaf = 0
      const samples: {
        graph: number
        ik: number
        flush: number
        anim: number
        upload: number
        update: number
        render: number
        frame: number
      }[] = []
      try {
        adapter.refresh(match.domains, 0)
        scene.update(sim, null, 1, DT)
        await scene.animationReady()
        if (scene.animationError)
          throw scene.animationError
        // Advance through countdown; measure running bots, not frozen spawn poses.
        for (let tick = 0; tick < 60; tick++)
          step()
        for (let frame = 0; frame < 240; frame++) {
          const raf = await new Promise<number>(resolve => { const timeout = setTimeout(() => resolve(realNow()), 25); requestAnimationFrame(t => { clearTimeout(timeout); resolve(t); }); })
          if (frame >= 60 && lastRaf)
            rafSamples.push(raf - lastRaf)
          lastRaf = raf
          const start = realNow()
          animMs = 0
          uploadMs = 0
          flushMs = 0
          ikMs = 0
          graphMs = 0
          step()
          const u = realNow()
          scene.update(sim, null, 1, DT)
          const r = realNow()
          gpuTimer.begin()
          port.render()
          const end = realNow()
          const gpuMs = await gpuTimer.end()
          if (frame >= 60 && gpuMs !== null)
            gpuSamples.push(gpuMs)
          if (frame >= 60)
            samples.push({ graph: graphMs, ik: ikMs, flush: flushMs, anim: animMs, upload: uploadMs, update: r - u, render: end - r, frame: end - start })
          if (frame % 30 === 0)
            await yieldToBrowser()
          if (frame === 120)
            await record(`animPerf-${count}`, await renderPng(port, 'animPerf'), files)
        }
        const mean = (key: keyof typeof samples[number]) => samples.reduce((n, s) => n + s[key], 0) / samples.length
        rows.push({ count, samples: samples.length, animMs: mean('anim'), graphMs: mean('graph'), ikMs: mean('ik'), paletteUploadMs: mean('flush'), setPoseMs: mean('upload'), sceneUpdateMs: mean('update'),
          renderSubmitMs: mean('render'), cpuFrameMs: mean('frame'), gpuPassMs: gpuSamples.length ? gpuSamples.reduce((a, b) => a + b, 0) / gpuSamples.length : null, rafMs: rafSamples.reduce((a, b) => a + b, 0) / rafSamples.length, cacheCounts, inventory: port.inventory?.() })
      }
      finally {
        scene.dispose()
        match.dispose()
      }
    }
    // Three stable locomotion clips at the same authored rig/graph time, for before/after pixel comparisons.
    const handle = port.registerSkinned!(skin.assetId, skin.skin)
    const inst = port.createInstance(handle, PALETTE[0])
    port.setTransform(inst, [0, 0, 0], [0, 0, 0, 1], [1, 1, 1])
    port.setCamera(0, { eye: [2.5, 1.8, 4], target: [0, 0.6, 0], fovYDeg: 35, near: 0.05, far: 30 })
    for (const [name, speed] of [['idle', 0], ['waddle', 3], ['run', 8]] as const) {
      const { bindings, smooth, ...rig } = skin.skin.rig as unknown as Record<string, unknown>
      const driver = await AnimDriver.load(skin.graph, JSON.stringify(rig), (skin.skin.clips ?? []).map(c => JSON.stringify(c)))
      try {
        for (let tick = 0; tick < 93; tick++)
          driver.observeTick(tick, [{ id: 0, mode: 0, vel: { x: 0, y: 0, z: speed }, grounded: true, surface: 'normal', emote: 0,
              xf: { pos: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 } }, ik: { mode: 0, look: { x: 0, y: 0, z: 10 }, ground: { point: { x: 0, y: -0.7, z: 0 }, normal: { x: 0, y: 1, z: 0 } } } }])
        port.setPose!(inst, driver.pose(0)!.skin)
        await record(`golden-${name}`, await renderPng(port, name), files)
      }
      finally {
        driver.dispose()
      }
    }
    port.destroyInstance(inst)
    return { json: { adapter, course: course.id, rows, gpuTimingNote: 'gpuPassMs sums timestamp-query render and compute pass durations; renderSubmitMs includes batched setSkinPoses upload' }, files }
  }
  finally {
    AnimDriver.prototype.observeTick = observe
    for (const [proto, step] of graphProtos)
      proto.step = step
    AnimDriver.load = load
    VisualIk.prototype.evaluate = evaluate
    engine.setSkinPoses = flush
    gpuTimer.dispose()
    port.dispose()
    canvas.remove()
  }
}

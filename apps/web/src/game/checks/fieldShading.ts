// fieldShading (game.html?test=1): the whole SDF candy world loaded through the real content provider and
// rendered by the real RAA port. Every capture waits on the port's field shading report, never on a fixed
// sleep: the GPU client runs the page in an off-screen frame where requestAnimationFrame is unreliable.
import type { CharState } from '@royal-fiesta/sim/character/system'
import type { ObstacleSpec, ResolvedCourse } from '@royal-fiesta/sim/course'
import type { MechItem } from '@royal-fiesta/sim/mechanismSpec'
import type { Pose } from '@royal-fiesta/sim/vec'
import { add3, quatConj, quatMul, quatRotate, sub3 } from '@royal-fiesta/sim/vec'
import { animationKind, trackPose } from '@royal-fiesta/sim/mechanisms/animation'
import { motionPose } from '@royal-fiesta/sim/obstacles/motion'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { CourseDressing, GameContent } from '@royal-fiesta/game/content'
import { AnimDriver } from '@royal-fiesta/game/anim/driver'
import type { CameraPose } from '@royal-fiesta/game/render/port'
import { WornMounts } from '@royal-fiesta/game/render/wornLook'
import type { WornLook } from '@royal-fiesta/game/render/wornLook'
import { pendingPipelines } from '../../render/asyncPipelines.ts'
import { pickContent } from '../../content/source.ts'
import { hardShadingFailures } from '../../content/shadingStatus.ts'
import { skinnedCharacterOf } from '../../content/providers/sdf.ts'
import type { ResizablePort, ShadingReport } from '../../sdf/sdfPort.ts'
import { nextTask } from './boot.ts'
import type { TourDeps } from '../uiTour.ts'

export const name = 'fieldShading'

const WIDTH = 1920
const HEIGHT = 1080
const WAIT_MS = 180_000
const HUB_ID = 'hub-plaza'
const MECH_COURSE = 'race-hammer-hill'

interface OpFile { name: string; blob: Blob }
interface Captures { files: OpFile[]; names: string[] }

function characterAt(pos: [number, number, number], vel: [number, number], facing: [number, number]): CharState {
  return {
    pos: { x: pos[0], y: pos[1], z: pos[2] }, vel: { x: vel[0], y: 0, z: vel[1] },
    facing: { x: facing[0], z: facing[1] }, mode: 0, grounded: true, groundObstacle: -1, knockbacks: 0, teleportTick: 0,
  }
}

function pageErrors(): string[] {
  const check = (window as { __nmcCheck?: { pageErrors?: unknown } }).__nmcCheck
  return Array.isArray(check?.pageErrors) ? check.pageErrors.filter((e): e is string => typeof e === 'string') : []
}

function assertNoPageErrors(what: string): void {
  const errors = pageErrors()
  if (errors.length > 0) throw new Error(`${what}: page error: ${errors[0]}`)
}

// The report's `failed` counts every named vertex reason, including the fallbacks this check must accept: the
// atlas demotions (QB12) and the field refusals MAMA saved with a part. hardShadingFailures keeps every other reason.
const hardFailures = hardShadingFailures

async function waitPipelines(what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS
  while (pendingPipelines() > 0) {
    if (Date.now() > deadline) throw new Error(`${what}: ${pendingPipelines()} material pipelines still compiling`)
    await nextTask()
  }
}

// Field shading becomes ready through the renderer, so submit a frame between yields. The bounded wait
// names the parts still pending instead of guessing a duration.
async function waitShading(port: ResizablePort, what: string): Promise<ShadingReport> {
  const deadline = Date.now() + WAIT_MS
  for (;;) {
    const report = port.shadingReport()
    if (report.pending === 0) {
      await waitPipelines(what)
      return port.shadingReport()
    }
    if (Date.now() > deadline) {
      // The parts it waited on and the pipelines still compiling come first; the named fallbacks (atlas budget, vertex
      // reasons) are reported states, never the reason of the wait, and follow only as a count.
      throw new Error(`${what}: field shading still pending after ${WAIT_MS / 1000} s: ${report.pending} parts ` +
        `(${report.pendingParts.join(', ')}); ${pendingPipelines()} material pipelines compiling; ${report.errors.length} named fallbacks`)
    }
    port.render()
    await nextTask()
  }
}

async function capture(port: ResizablePort, what: string, captures: Captures): Promise<void> {
  const report = port.shadingReport()
  if (report.pending > 0) throw new Error(`${what}: ${report.pending} parts still pending at capture time`)
  if (report.atlasFull > 0) throw new Error(`${what}: ${report.atlasFull} texture.atlas_full errors`)
  const failures = hardFailures(report)
  if (failures.length > 0) throw new Error(`${what}: ${failures.join('; ')}`)
  assertNoPageErrors(what)
  port.render()
  await nextTask()
  port.render()
  const png = await port.capture()
  if (png === null || png.length === 0) throw new Error(`${what}: the capture is empty`)
  captures.files.push({ name: `${what}.png`, blob: new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }) })
  captures.names.push(`${what}.png`)
}

interface StageOptions {
  // Decor stays only in the wide overview where the camera frames the whole plaza.
  decor: boolean
  obstacles?: readonly number[]
  mechanisms?: readonly number[]
}

// Draws only the chosen course instances: an off-screen instance never requests its field pipeline, and the
// port's pending count includes every live instance, so a close-up must not keep the rest of the world alive.
class Stage {
  private readonly port: ResizablePort
  private readonly course: ResolvedCourse
  private readonly dressing: CourseDressing
  private readonly assets: (name: string) => PrimsAsset
  private readonly handles = new Map<string, number>()
  private readonly obstacleSpecs: ObstacleSpec[] = []
  private readonly obstacleInst: number[] = []
  private readonly mechanismSpecs: { item: MechItem; at: number }[] = []
  private readonly mechanismInst: number[] = []
  private readonly withDecor: boolean
  private readonly rest: Pose = { t: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0, w: 1 } }
  private readonly q: Pose = { t: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0, w: 1 } }

  constructor(port: ResizablePort, content: GameContent, course: ResolvedCourse, options: StageOptions) {
    this.port = port
    this.course = course
    this.assets = name => content.assets(name)
    this.dressing = content.dressing()
    this.withDecor = options.decor
    // enter sets the course environment; a close-up leaves at once so its decor instances cannot stay pending.
    this.dressing.enter(port, course.id)
    if (!options.decor) this.dressing.leave(port)
    for (const index of options.obstacles ?? course.obstacles.map((_, i) => i)) {
      const spec = course.obstacles[index]
      if (spec === undefined) continue
      this.obstacleSpecs.push(spec)
      this.obstacleInst.push(port.createInstance(this.handle(spec.asset), null))
    }
    const items = course.mechanisms?.items ?? []
    for (const index of options.mechanisms ?? items.map((_, i) => i)) {
      const item = items[index]
      if (item === undefined) continue
      this.mechanismSpecs.push({ item, at: index })
      this.mechanismInst.push(port.createInstance(this.handle(item.asset), null))
    }
    this.update(0)
  }

  private handle(name: string): number {
    let handle = this.handles.get(name)
    if (handle === undefined) {
      handle = this.port.registerAsset(name, this.assets(name))
      this.handles.set(name, handle)
    }
    return handle
  }

  update(tick: number): void {
    for (let i = 0; i < this.obstacleSpecs.length; i++) {
      const spec = this.obstacleSpecs[i]
      motionPose(spec, tick, 0, this.q)
      const { t, r } = this.q
      this.port.setTransform(this.obstacleInst[i], [t.x, t.y, t.z], [r.x, r.y, r.z, r.w], [spec.s.x, spec.s.y, spec.s.z])
    }
    const mechanisms = this.course.mechanisms
    if (mechanisms === null || mechanisms === undefined) return
    for (let k = 0; k < this.mechanismSpecs.length; k++) {
      const { item, at } = this.mechanismSpecs[k]
      const place = item.place ?? item
      let t = place.t
      let r = place.r
      for (let a = 0; a < mechanisms.animations.length; a++) {
        const animation = mechanisms.animations[a]
        if (animation.target.item !== at || animationKind(mechanisms, a) !== 'tick') continue
        const body = item.bodies[animation.target.body]
        quatRotate(item.r, body.rest.t, this.rest.t)
        add3(item.t, this.rest.t, this.rest.t)
        quatMul(item.r, body.rest.r, this.rest.r)
        trackPose(animation, tick, this.q)
        add3(this.rest.t, this.q.t, this.q.t)
        quatMul(this.q.r, this.rest.r, this.q.r)
        sub3(place.t, this.rest.t, this.rest.t)
        quatConj(this.rest.r, this.rest.r)
        quatMul(this.q.r, this.rest.r, this.q.r)
        quatRotate(this.q.r, this.rest.t, this.rest.t)
        add3(this.q.t, this.rest.t, this.q.t)
        quatMul(this.q.r, place.r, this.q.r)
        t = this.q.t
        r = this.q.r
        break
      }
      this.port.setTransform(this.mechanismInst[k], [t.x, t.y, t.z], [r.x, r.y, r.z, r.w], [item.s.x, item.s.y, item.s.z])
    }
  }

  dispose(): void {
    if (this.withDecor) this.dressing.leave(this.port)
    for (const instance of [...this.obstacleInst, ...this.mechanismInst]) this.port.destroyInstance(instance)
  }
}

function obstacleOf(course: ResolvedCourse, asset: string): number {
  const index = course.obstacles.findIndex(spec => spec.asset === asset)
  if (index < 0) throw new Error(`course '${course.id}' has no '${asset}' obstacle`)
  return index
}

function mechanismOf(course: ResolvedCourse, asset: string): number {
  const items = course.mechanisms?.items ?? []
  const index = items.findIndex(item => item.asset === asset)
  if (index < 0) throw new Error(`course '${course.id}' has no '${asset}' mechanism`)
  return index
}

function walkObservation() {
  return { id: 0, mode: 0, vel: { x: 0, y: 0, z: 3 }, grounded: true, surface: 'normal' as const, emote: 0,
    xf: { pos: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 } },
    ik: { mode: 0, look: { x: 0, y: 0, z: 10 }, ground: { point: { x: 0, y: -0.7, z: 0 }, normal: { x: 0, y: 1, z: 0 } } } }
}

async function shootPenguin(port: ResizablePort, content: GameContent, captures: Captures): Promise<void> {
  const worn: WornLook = {
    colour: 7,
    items: [
      { asset: content.assets('costume.propeller-hat'), mount: [0, 0, 0], tint: null },
      { asset: content.assets('costume.fish-scarf'), mount: [0, 0, 0], tint: null },
    ],
  }
  const skin = skinnedCharacterOf(content)
  const mounts = new WornMounts(port)
  // An empty stage keeps the hub environment (sky, light) for the portrait without any decor instance.
  const backdrop = new Stage(port, content, content.hub(), { decor: false, obstacles: [], mechanisms: [] })
  let driver: AnimDriver | null = null
  let bean = -1
  try {
    if (skin === undefined) {
      bean = port.createInstance(port.registerAsset('penguin.body', content.character()), null)
      port.setTransform(bean, [0, 0, 0], [0, 0, 0, 1], [1, 1, 1])
      mounts.sync(worn)
      mounts.draw([0, 0, 0], [0, 0, 0, 1], [1, 1, 1])
    } else {
      // A near-black plumage reads as the penguin's black back; the belly, beak and feet keep their own colours.
      bean = port.createInstance(port.registerSkinned(skin.assetId, skin.skin), [0.08, 0.09, 0.12])
      port.setTransform(bean, [0, 0, 0], [0, 0, 0, 1], [1, 1, 1])
      const { bindings: _b, smooth: _s, ...rig } = skin.skin.rig as unknown as Record<string, unknown>
      driver = await AnimDriver.load(skin.graph, JSON.stringify(rig), (skin.skin.clips ?? []).map(clip => JSON.stringify(clip)))
      // A walking, not resting, pose: step the graph's own walk clip through a full second of ticks.
      for (let tick = 0; tick <= 60; tick++) driver.observeTick(tick, [walkObservation()])
      const pose = driver.pose(0)?.skin
      if (pose === undefined) throw new Error('penguin: the walk clip produced no pose')
      port.setPose(bean, pose)
      mounts.sync(worn)
      mounts.draw([0, 0, 0], [0, 0, 0, 1], [1, 1, 1])
      mounts.setPose(pose, { dtS: 1 / 60 })
    }
    port.setCamera(0, { eye: [0, 1.1, 2.5], target: [0, 0.55, 0], fovYDeg: 42, near: 0.05, far: 100 })
    await waitShading(port, 'penguin')
    await capture(port, 'penguin', captures)
    port.setShading('vertex')
    await waitShading(port, 'penguin-vertex')
    await capture(port, 'penguin-vertex', captures)
    port.setShading('field')
  } finally {
    driver?.dispose()
    mounts.destroy()
    if (bean >= 0) port.destroyInstance(bean)
    backdrop.dispose()
  }
}

async function shootWorld(port: ResizablePort, content: GameContent, captures: Captures): Promise<void> {
  const stage = new Stage(port, content, content.hub(), { decor: true })
  try {
    port.setCamera(0, { eye: [38, 26, 42], target: [0, 1.5, 0], fovYDeg: 60, near: 0.1, far: 500 })
    await waitShading(port, 'candy-world')
    await capture(port, 'candy-world', captures)
  } finally { stage.dispose() }
}

async function shootScenery(port: ResizablePort, content: GameContent, captures: Captures): Promise<void> {
  const hub = content.hub()
  const stage = new Stage(port, content, hub, { decor: false, obstacles: [obstacleOf(hub, 'candy.plaza-fountain')], mechanisms: [] })
  try {
    port.setCamera(0, { eye: [2.4, 1.8, 2.8], target: [0, 0.9, 0], fovYDeg: 55, near: 0.05, far: 200 })
    await waitShading(port, 'rounded-scenery')
    await capture(port, 'rounded-scenery', captures)
  } finally { stage.dispose() }
}

async function shootMechanisms(port: ResizablePort, content: GameContent, captures: Captures): Promise<void> {
  const course = content.course(MECH_COURSE)
  const at = mechanismOf(course, 'candy.pendulum-hammer')
  const item = course.mechanisms!.items[at]
  const place = item.place ?? item
  const target: [number, number, number] = [place.t.x, place.t.y + 1.35, place.t.z]
  const cam: CameraPose = { eye: [target[0] + 4, target[1] + 1.8, target[2] + 4], target, fovYDeg: 65, near: 0.1, far: 300 }
  const stage = new Stage(port, content, course, { decor: false, obstacles: [], mechanisms: [at] })
  try {
    port.setCamera(0, cam)
    await waitShading(port, 'mechanisms-a')
    await capture(port, 'mechanisms-a', captures)
    // 30 ticks = 0.5 s of sim time; the hammer's keyframes put a visibly different pose there.
    stage.update(30)
    port.setCamera(0, cam)
    await waitShading(port, 'mechanisms-b')
    await capture(port, 'mechanisms-b', captures)
  } finally { stage.dispose() }
}

export async function run(_input: unknown, deps: TourDeps): Promise<{ json: Record<string, unknown>; files: OpFile[] }> {
  const captures: Captures = { files: [], names: [] }
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  document.body.appendChild(canvas)
  const content = pickContent(new URLSearchParams({ content: 'sdf' }))
  let port: ResizablePort | null = null
  try {
    await content.load('sprint', () => {})
    assertNoPageErrors('content load')
    port = await content.createPort({ canvas, width: WIDTH, height: HEIGHT, viewports: [{ x: 0, y: 0, width: WIDTH, height: HEIGHT }] }) as ResizablePort
    // The default Graphics choice, whatever the page address says: the captures prove the field shading.
    port.setShading('field')
    await shootWorld(port, content, captures)
    await shootScenery(port, content, captures)
    await shootPenguin(port, content, captures)
    await shootMechanisms(port, content, captures)
    assertNoPageErrors('captures')
    const reported = content.report()
    const normals = (reported.normals as unknown as ShadingReport | undefined) ?? port.shadingReport()
    if (normals.field === 0) throw new Error('the whole world drew no field-shaded part')
    const failures = hardFailures(normals)
    if (failures.length > 0) throw new Error(`field shading failed: ${failures.join('; ')}`)
    return {
      json: {
        ok: true,
        content: content.id,
        shading: 'field',
        adapter: await deps.adapter(),
        assets: reported.assets,
        failedAssets: reported.failed,
        normals,
        hardFailures: failures,
        captures: captures.names,
      },
      files: captures.files,
    }
  } finally {
    port?.dispose()
    canvas.remove()
  }
}

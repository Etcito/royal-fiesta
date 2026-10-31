import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { neutralInput } from '@royal-fiesta/sim/input'
import { CharMode } from '@royal-fiesta/sim/character/constants'
import { Phase, createMatchSim } from '@royal-fiesta/sim/match/matchSim'
import type { CharacterView } from '@royal-fiesta/sim/match/matchSim'
import { emptyMechanisms } from '@royal-fiesta/sim/mechanismSpec'
import type { BodySpec } from '@royal-fiesta/sim/mechanismSpec'
import { add3, pose, quatConj, quatMul, quatNormalize, quatRotate, sub3, v3 } from '@royal-fiesta/sim/vec'
import { fixtureResolver } from '../src/assets.ts'
import type { CourseDressing } from '../src/content.ts'
import { matchCourses } from '../src/courseSet.ts'
import type { CourseEntry } from '../src/courseSet.ts'
import { netSetup } from '../src/net/tuning.ts'
import type { PrimsAsset } from '../src/prims.ts'
import { NullRenderPort } from '../src/render/nullPort.ts'
import type { CameraPose, QuatT, RenderPort, Vec3T } from '../src/render/port.ts'
import { restPoseSkin, SceneView } from '../src/render/sceneView.ts'

const ROOT = new URL('../../../', import.meta.url)
const read = async (rel: string) => readFileSync(new URL(rel, ROOT), 'utf8')
const resolver = fixtureResolver(read)

const R: RapierModule = await initRapier()

async function loadCourses(): Promise<ResolvedCourse[]> {
  const names = readdirSync(new URL('fixtures/courses/', ROOT), { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.course.json')).map(e => e.name).sort()
  const entries: CourseEntry[] = []
  for (const n of names) {
    const path = `fixtures/courses/${n}`
    entries.push({ path, json: JSON.parse(await read(path)) as unknown })
  }
  return matchCourses(entries, resolver, 'sprint')
}

const courses = await loadCourses()

// SceneView takes a synchronous lookup, so every asset the courses use is resolved up front.
const assets = new Map<string, PrimsAsset>()
for (const c of courses) {
  for (const o of c.obstacles) if (!assets.has(o.asset)) assets.set(o.asset, (await resolver.resolve(o.asset)).asset)
}
const bean = (await resolver.resolve('bean')).asset

test('SceneView keeps beans and obstacles on the port while the match runs', async () => {
  const sim = createMatchSim(R, netSetup(5, 1, 'sprint', courses))
  const port = new NullRenderPort()
  await port.init({ canvas: null, width: 960, height: 540, viewports: [{ x: 0, y: 0, width: 960, height: 540 }] })
  const used = new Set<string>()
  const view = new SceneView({
    port, viewport: 0, localPlayer: 0, bean,
    assets: name => {
      used.add(name)
      const a = assets.get(name)
      assert.ok(a, `asset ${name} preloaded`)
      return a
    },
  })
  try {
    const inputs = Array.from({ length: sim.setup.playerCount }, () => neutralInput())
    let transforms = port.calls.setTransform
    let grew = 0
    for (let i = 0; i < 200; i++) {
      sim.step(inputs)
      view.update(sim, null, 0.5, 1 / 60)
      if (sim.course() !== null) {
        assert.equal(view.instanceCount, 8 + sim.obstacleCount())
        assert.equal(view.courseIndex, courses.indexOf(sim.course()!))
      }
      if (port.calls.setTransform > transforms) grew++
      transforms = port.calls.setTransform
    }
    assert.ok(sim.course() !== null, 'a course is loaded')
    assert.ok(grew >= 190, `setTransform grew on ${grew} of 200 frames`)
    assert.equal(port.calls.registerAsset, used.size + 1, 'one registerAsset per distinct asset name (+ bean)')
    assert.equal(port.render().instances, view.instanceCount)
    assert.ok(view.camera !== null)
    assert.equal(view.camera.fovYDeg, 60)
  } finally {
    view.dispose()
    assert.equal(port.render().instances, 0)
    sim.free()
  }
})

test('SceneView uses the camera hook instead of the follow camera on the local player', async () => {
  const sim = createMatchSim(R, netSetup(5, 1, 'sprint', courses))
  // NullRenderPort keeps no camera, so record the last one per viewport.
  class RecordingPort extends NullRenderPort {
    readonly lastCamera = new Map<number, CameraPose>()
    override setCamera(viewport: number, cam: CameraPose): void {
      super.setCamera(viewport, cam)
      this.lastCamera.set(viewport, cam)
    }
  }
  const port = new RecordingPort()
  await port.init({ canvas: null, width: 960, height: 540, viewports: [{ x: 0, y: 0, width: 960, height: 540 }] })
  const fixed: CameraPose = { eye: [1, 2, 3], target: [4, 5, 6], fovYDeg: 50, near: 0.2, far: 300 }
  const seen: { x: number; y: number; z: number }[] = []
  const view = new SceneView({
    port, viewport: 0, localPlayer: 0, bean,
    assets: name => assets.get(name)!,
    camera: (focus, dt) => {
      assert.equal(dt, 1 / 60)
      seen.push({ x: focus.x, y: focus.y, z: focus.z })
      return fixed
    },
  })
  try {
    const inputs = Array.from({ length: sim.setup.playerCount }, () => neutralInput())
    const c: CharacterView = {
      pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
      mode: 0, status: 0, parked: false, teleportTick: -1,
    }
    let checked = 0
    for (let i = 0; i < 120; i++) {
      sim.step(inputs)
      const before = seen.length
      // alpha 1 and no smoother: the displayed position is the current tick's position.
      view.update(sim, null, 1, 1 / 60)
      sim.character(0, c)
      if (c.parked) continue
      assert.equal(seen.length, before + 1)
      assert.deepEqual(seen[seen.length - 1], { x: c.pos.x, y: c.pos.y, z: c.pos.z })
      checked++
    }
    assert.ok(checked > 0, 'the local player was shown')
    assert.equal(view.camera, fixed)
    assert.equal(port.lastCamera.get(0), fixed)
  } finally {
    view.dispose()
    sim.free()
  }
})

test('SceneView leaves the previous dressing and enters the new one on every course change', async () => {
  const sim = createMatchSim(R, netSetup(5, 1, 'sprint', courses))
  const port = new NullRenderPort()
  await port.init({ canvas: null, width: 960, height: 540, viewports: [{ x: 0, y: 0, width: 960, height: 540 }] })
  const log: string[] = []
  const dressing: CourseDressing = {
    enter(p: RenderPort, courseId: string): void {
      assert.equal(p, port)
      log.push(`enter:${courseId}`)
    },
    leave(p: RenderPort): void {
      assert.equal(p, port)
      log.push('leave')
    },
  }
  const view = new SceneView({ port, viewport: 0, localPlayer: 0, bean, assets: name => assets.get(name)!, dressing })
  try {
    const inputs = Array.from({ length: sim.setup.playerCount }, () => neutralInput())
    const ids: string[] = []
    for (let i = 0; i < 3000 && ids.length < 2; i++) {
      sim.step(inputs)
      view.update(sim, null, 1, 1 / 60)
      const c = sim.course()
      if (c !== null && ids[ids.length - 1] !== c.id) ids.push(c.id)
    }
    assert.equal(ids.length, 2, 'two courses were played')
    assert.notEqual(ids[0], ids[1])
    assert.deepEqual(log, [`enter:${ids[0]}`, 'leave', `enter:${ids[1]}`])
  } finally {
    view.dispose()
    sim.free()
  }
  assert.equal(log[log.length - 1], 'leave', 'dispose leaves the last dressing')
})

test('SceneView registers the custom character asset for the character instances', async () => {
  const sim = createMatchSim(R, netSetup(5, 1, 'sprint', courses))
  // NullRenderPort counts registrations only, so record which asset each name got.
  class RecordingPort extends NullRenderPort {
    readonly registered = new Map<string, PrimsAsset>()
    override registerAsset(name: string, asset: PrimsAsset): number {
      this.registered.set(name, asset)
      return super.registerAsset(name, asset)
    }
  }
  const port = new RecordingPort()
  await port.init({ canvas: null, width: 960, height: 540, viewports: [{ x: 0, y: 0, width: 960, height: 540 }] })
  const character: PrimsAsset = { ...bean, id: 'penguin-test', name: 'Penguin test' }
  const view = new SceneView({ port, viewport: 0, localPlayer: 0, bean, character, assets: name => assets.get(name)! })
  try {
    assert.equal(port.registered.get('penguin-test'), character)
    assert.ok(!port.registered.has('bean'), 'the bean is not registered when a character is given')
    sim.step(Array.from({ length: sim.setup.playerCount }, () => neutralInput()))
    view.update(sim, null, 1, 1 / 60)
    assert.equal(view.instanceCount, 8 + sim.obstacleCount())
  } finally {
    view.dispose()
    sim.free()
  }
})

test('prepared local scenes build on the first update without scheduling a loading paint', async () => {
  const { observeRoundLoad } = await import('../src/render/roundLoad.ts')
  const original = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame')
  let paints = 0
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => { paints++; return 1 } })
  const labels: (string | null)[] = []
  const stop = observeRoundLoad(label => labels.push(label), {})
  const sim = createMatchSim(R, netSetup(5, 1, 'sprint', courses))
  const port = new NullRenderPort()
  await port.init({ canvas: null, width: 640, height: 360, viewports: [{ x: 0, y: 0, width: 640, height: 360 }] })
  const scene = new SceneView({ port, viewport: 0, localPlayer: 0, bean, assets: name => assets.get(name)!, loadingPaint: false })
  try {
    sim.step(Array.from({ length: sim.setup.playerCount }, () => neutralInput()))
    scene.update(sim, null, 1, 0)
    assert.ok(scene.instanceCount > sim.setup.playerCount, 'course and bots exist before launch')
    assert.equal(paints, 0)
    assert.equal(labels.some(label => label?.startsWith('Preparing course:')), false)
  } finally {
    scene.dispose()
    sim.free()
    stop()
    if (original) Object.defineProperty(globalThis, 'requestAnimationFrame', original)
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame')
  }
})

// Inline courses keep mechanism rendering tests independent of game content.
function mechanismCourses(withMechanisms = true): ResolvedCourse[] {
  const mechanisms = emptyMechanisms()
  const bodies: BodySpec[] = ['dynamic', 'fixed'].map((type, i) => ({
    id: `body-${i}`, type: type as BodySpec['type'], parts: [`part-${i}`],
    colliders: [{ shape: 'cuboid', half: v3(0.5, 0.5, 0.5), t: v3(0, 0, 0), r: pose().r }],
    // Different body and item frames catch applying the item transform twice.
    rest: { t: v3(22 + i * 4, 12, 3), r: { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 } },
    density: 1, friction: 0.5, restitution: 0, linearDamping: 0, angularDamping: 0,
    gravityScale: 1, ccd: false, surface: 'normal',
  }))
  mechanisms.items.push({
    id: 'pair', asset: 'mechanism-pair', t: v3(20, 10, 3),
    r: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }, s: v3(2, 3, 4), bodies, joints: [],
  })
  const race: ResolvedCourse = {
    id: 'scene-mechanisms', name: 'Scene mechanisms', kind: 'race', profiles: ['sprint'],
    timeLimitS: 1, killPlaneY: -1000, contentHash: 1,
    spawns: Array.from({ length: 8 }, (_, i) => ({ t: v3(i * 2, 1, 0), facing: { x: 0, z: 1 } })),
    checkpoints: [], finish: { center: v3(0, 0, 100), half: v3(10, 3, 1) },
    path: [{ p: v3(0, 0, 100), jump: false, dive: false }],
    regions: [], queuePad: null, obstacles: [], mechanisms: withMechanisms ? mechanisms : undefined,
  }
  return [race, { ...race, id: 'scene-plain', kind: 'survival', finish: null, mechanisms: undefined }]
}

class MechanismRecordingPort extends NullRenderPort {
  readonly created: number[] = []
  readonly destroyed: number[] = []
  readonly transforms = new Map<number, { t: Vec3T; r: QuatT; s: Vec3T }>()
  readonly visibility = new Map<number, boolean>()
  override createInstance(asset: number, tint: Vec3T | null): number {
    const instance = super.createInstance(asset, tint)
    this.created.push(instance)
    this.visibility.set(instance, true)
    return instance
  }
  override setTransform(instance: number, t: Vec3T, r: QuatT, s: Vec3T): void {
    super.setTransform(instance, t, r, s) // Also rejects non-finite components.
    this.transforms.set(instance, { t: [...t], r: [...r], s: [...s] })
  }
  override setVisible(instance: number, visible: boolean): void {
    super.setVisible(instance, visible)
    this.visibility.set(instance, visible)
  }
  override destroyInstance(instance: number): void {
    super.destroyInstance(instance)
    this.destroyed.push(instance)
  }
}

async function mechanismScene(port = new MechanismRecordingPort(), list = mechanismCourses()) {
  const sim = createMatchSim(R, netSetup(5, 1, 'sprint', list))
  await port.init({ canvas: null, width: 640, height: 360, viewports: [{ x: 0, y: 0, width: 640, height: 360 }] })
  const view = new SceneView({ port, viewport: 0, localPlayer: 0, bean, assets: () => bean, loadingPaint: false })
  const inputs = Array.from({ length: sim.setup.playerCount }, () => neutralInput())
  sim.step(inputs)
  view.update(sim, null, 0.5, 1 / 60)
  return { sim, port, view, inputs }
}

function closeVector(actual: readonly number[], expected: readonly number[], tolerance = 1e-6): void {
  assert.equal(actual.length, expected.length)
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < tolerance, `${value} != ${expected[i]} at ${i}`))
}

test('SceneView creates two mechanism bodies and interpolates finite dynamic poses', async () => {
  const { sim, port, view, inputs } = await mechanismScene()
  try {
    assert.equal(view.mechanismInstanceCount, 2)
    assert.equal(view.instanceCount, 10)
    assert.equal(port.render().instances, 10)
    assert.equal(port.calls.registerAsset, 2, 'bean and one shared mechanism asset')
    const [dynamic, fixed] = port.created
    assert.equal(port.visibility.get(dynamic), true)
    assert.equal(port.visibility.get(fixed), false, 'the fallback draws the whole asset only on body 0')
    const item = sim.mechanismItem(0)
    const rest = item.bodies[0].rest
    // The sim reports world poses: the body's world rest is the item pose times its rest.
    const worldRestT = add3(item.t, quatRotate(item.r, rest.t, v3(0, 0, 0)), v3(0, 0, 0))
    const worldRestInvR = quatConj(quatMul(item.r, rest.r, pose().r), pose().r)
    const bodyPose = pose()
    const firstY = port.transforms.get(dynamic)!.t[1]
    const calls = port.calls.setTransform
    for (let i = 0; i < 20; i++) {
      const previous = [...port.transforms.get(dynamic)!.t]
      sim.step(inputs)
      view.update(sim, null, 1, 1 / 60)
      assert.ok(sim.mechanismBodyPose({ item: 0, body: 0 }, bodyPose))
      const current = [...port.transforms.get(dynamic)!.t]
      // The item placement moved by the body's motion since its world rest.
      // SceneView draws the normalised body rotation (Rapier reports f32 quaternions).
      const motion = quatMul(quatNormalize(bodyPose.r, pose().r), worldRestInvR, pose().r)
      const at = add3(bodyPose.t, quatRotate(motion, sub3(item.t, worldRestT, v3(0, 0, 0)), v3(0, 0, 0)), v3(0, 0, 0))
      closeVector(current, [at.x, at.y, at.z])
      const r = quatMul(motion, item.r, pose().r)
      closeVector(port.transforms.get(dynamic)!.r, [r.x, r.y, r.z, r.w])
      assert.deepEqual(port.transforms.get(dynamic)!.s, [2, 3, 4])
      view.update(sim, null, 0.5, 0)
      closeVector(port.transforms.get(dynamic)!.t, previous.map((v, k) => (v + current[k]) / 2))
      view.update(sim, null, 0, 0)
      closeVector(port.transforms.get(dynamic)!.t, previous)
      view.update(sim, null, 1, 0)
    }
    assert.ok(port.transforms.get(dynamic)!.t[1] < firstY - 0.1, 'the rendered dynamic body falls')
    assert.ok(port.calls.setTransform > calls)
    closeVector(port.transforms.get(fixed)!.t, [item.t.x, item.t.y, item.t.z])
  } finally {
    view.dispose()
    assert.equal(view.mechanismInstanceCount, 0)
    assert.equal(port.render().instances, 0)
    assert.deepEqual(port.destroyed.slice(-2), port.created.slice(0, 2).reverse())
    sim.free()
  }
})

// Course v1 items: identity item pose, world body rests, the obstacle placement in `place`.
test('SceneView draws course items at their place, not at the identity item pose', async () => {
  const list = mechanismCourses()
  const item = list[0].mechanisms!.items[0]
  const place = { t: item.t, r: item.r }
  list[0].mechanisms!.items[0] = {
    ...item, t: v3(0, 0, 0), r: pose().r, place,
    bodies: item.bodies.map(body => ({
      ...body,
      rest: { t: add3(place.t, quatRotate(place.r, body.rest.t, v3(0, 0, 0)), v3(0, 0, 0)), r: quatMul(place.r, body.rest.r, pose().r) },
    })),
  }
  const { sim, port, view, inputs } = await mechanismScene(new MechanismRecordingPort(), list)
  try {
    const [dynamic, fixed] = port.created
    const rest = sim.mechanismItem(0).bodies[0].rest
    const bodyPose = pose()
    for (let i = 0; i < 10; i++) {
      sim.step(inputs)
      view.update(sim, null, 1, 1 / 60)
    }
    assert.ok(sim.mechanismBodyPose({ item: 0, body: 0 }, bodyPose))
    assert.ok(bodyPose.t.y < rest.t.y, 'the dynamic body falls')
    closeVector(port.transforms.get(dynamic)!.t, [place.t.x + bodyPose.t.x - rest.t.x, place.t.y + bodyPose.t.y - rest.t.y, place.t.z + bodyPose.t.z - rest.t.z])
    closeVector(port.transforms.get(dynamic)!.r, [place.r.x, place.r.y, place.r.z, place.r.w])
    closeVector(port.transforms.get(fixed)!.t, [place.t.x, place.t.y, place.t.z])
    closeVector(port.transforms.get(fixed)!.r, [place.r.x, place.r.y, place.r.z, place.r.w])
  } finally {
    view.dispose()
    sim.free()
  }
})

test('SceneView filters mechanism parts in item then body order when the port supports it', async () => {
  class FilterPort extends MechanismRecordingPort {
    readonly filters: { instance: number; parts: readonly string[] | null }[] = []
    setPartFilter(instance: number, parts: readonly string[] | null): void { this.filters.push({ instance, parts }) }
  }
  const list = mechanismCourses()
  const item = list[0].mechanisms!.items[0]
  list[0].mechanisms!.items.push({
    ...item, id: 'second-pair', t: { ...item.t, x: item.t.x + 20 },
    bodies: item.bodies.map(body => ({ ...body, rest: { ...body.rest, t: { ...body.rest.t, x: body.rest.t.x + 20 } } })),
  })
  const port = new FilterPort()
  const { sim, view } = await mechanismScene(port, list)
  try {
    assert.equal(view.mechanismInstanceCount, 4)
    assert.equal(port.calls.registerAsset, 2, 'the same asset on another item is still registered once')
    assert.deepEqual(port.filters, port.created.slice(0, 4).map((instance, i) => ({ instance, parts: [`part-${i % 2}`] })))
    for (const instance of port.created.slice(0, 4)) assert.equal(port.visibility.get(instance), true)
  } finally {
    view.dispose()
    assert.deepEqual(port.destroyed.slice(-4), port.created.slice(0, 4).reverse())
    sim.free()
  }
})

test('SceneView destroys mechanism bodies in reverse order on a course change and resets pose history', async () => {
  const { sim, port, view, inputs } = await mechanismScene()
  const original = sim.course()
  const instances = port.created.slice(0, 2)
  let fresh: ReturnType<typeof createMatchSim> | null = null
  try {
    for (let i = 0; i < 1000 && sim.course() === original; i++) {
      sim.step(inputs)
      view.update(sim, null, 0.5, 1 / 60)
    }
    assert.notEqual(sim.course(), original, 'the match switched courses')
    assert.deepEqual(port.destroyed, [...instances].reverse())
    assert.equal(view.mechanismInstanceCount, 0)
    assert.equal(port.render().instances, 8)

    // Enter another course with bodies at their starting positions. Alpha 0 must
    // already show its current pose, with no history from the previous course.
    fresh = createMatchSim(R, netSetup(5, 1, 'sprint', mechanismCourses()))
    fresh.step(inputs)
    view.update(fresh, null, 0, 1 / 60)
    const newInstances = port.created.slice(-2)
    const atZero = newInstances.map(instance => port.transforms.get(instance)!)
    view.update(fresh, null, 1, 0)
    assert.deepEqual(newInstances.map(instance => port.transforms.get(instance)!), atZero)
    assert.equal(view.mechanismInstanceCount, 2)
    assert.equal(port.calls.registerAsset, 2, 'course re-entry reuses the asset handle')
  } finally {
    view.dispose()
    assert.equal(port.render().instances, 0)
    fresh?.free()
    sim.free()
  }
})

test('SceneView reports zero mechanism instances for a course without mechanisms', async () => {
  const { sim, port, view } = await mechanismScene(new MechanismRecordingPort(), mechanismCourses(false))
  try {
    assert.equal(view.mechanismInstanceCount, 0)
    assert.equal(view.instanceCount, 8)
    assert.equal(port.render().instances, 8)
    assert.equal(port.calls.registerAsset, 1)
  } finally {
    view.dispose()
    sim.free()
  }
})

const penguin = JSON.parse(await read('assets/common/penguin.body.asset.json')).document.nodes.penguin
const skinnedPenguin = {
  assetId: 'penguin', graph: await read('assets/common/penguin.animgraph.json'),
  skin: { rig: penguin.rig, clips: penguin.clips, parts: [{ name: 'p', skin: { joints: new Uint16Array(4), weights: new Float32Array([1, 0, 0, 0]) } }] },
}

function assertFlippersDown(skin: Float32Array): void {
  for (const name of ['upper.l', 'upper.r']) {
    const bone = penguin.rig.bones.findIndex((b: { name: string }) => b.name === name)
    assert.ok(bone >= 0)
    const matrix = skin.subarray(bone * 16, bone * 16 + 16)
    assert.equal(matrix.length, 16)
    assert.ok(matrix.every(Number.isFinite))
    assert.ok(matrix.some((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) > 1e-4), `${name} must never draw the T rest pose`)
  }
}

for (const scenario of ['walking', 'idle', 'podium'] as const) {
  test(`skinned penguin never draws a T pose before load or while ${scenario}`, async () => {
    const sim = createMatchSim(R, netSetup(5, 1, 'sprint', courses))
    const port = new NullRenderPort()
    await port.init({ canvas: null, width: 64, height: 36, viewports: [{ x: 0, y: 0, width: 64, height: 36 }] })
    const submitted: { instance: number; skin: Float32Array }[] = []
    port.setPose = (instance, skin) => { submitted.push({ instance, skin: Float32Array.from(skin) }) }
    const inputs = Array.from({ length: sim.setup.playerCount }, () => ({ ...neutralInput(), moveZ: scenario === 'walking' ? 1 : 0 }))
    // Get past the intro before drawing; walking then uses real forward input and velocity.
    for (let i = 0; i < 180; i++) sim.step(inputs)
    const character = sim.character.bind(sim)
    if (scenario !== 'walking') {
      sim.character = (p, out) => {
        const c = character(p, out)
        c.vel = { x: 0, y: 0, z: 0 }
        c.mode = scenario === 'podium' ? CharMode.frozen : CharMode.ground
        c.parked = scenario === 'podium' && p > 0
        return c
      }
    }
    if (scenario === 'podium') {
      const phase = sim.phase.bind(sim)
      sim.phase = out => { const state = phase(out); state.phase = Phase.podium; state.podium = [0]; return state }
    }
    const view = new SceneView({ port, viewport: 0, localPlayer: 0, bean, assets: n => assets.get(n)!, loadingPaint: false, skinned: skinnedPenguin })
    try {
      view.update(sim, null, 1, 0)
      assert.ok(submitted.length > 0, 'first update submits a fallback before async load')
      const firstCount = submitted.length
      const rest = restPoseSkin(penguin.rig)
      for (const { skin } of submitted) { assert.deepEqual(skin, rest); assertFlippersDown(skin) }
      view.update(sim, null, 1, 0)
      assert.equal(submitted.length, firstCount, 'fallback is submitted once')
      await view.animationReady()
      assert.equal(view.animationError, null)
      view.update(sim, null, 1, 0)
      assert.ok(submitted.length > firstCount, 'driver replaces the fallback')
      for (let i = 0; i < 30; i++) { sim.step(inputs); view.update(sim, null, 1, 1 / 60) }
      for (const { skin } of submitted) assertFlippersDown(skin)
      // Remove a posed character on an already observed tick: pose(id) is undefined.
      const driver = (view as unknown as { anim: { remove(id: number): void } }).anim
      driver.remove(0)
      const before = submitted.length
      view.update(sim, null, 1, 0)
      assert.equal(submitted.length, before + 1)
      assert.deepEqual(submitted.at(-1)!.skin, rest)
      view.update(sim, null, 1, 0)
      assert.equal(submitted.length, before + 1)
    } finally {
      view.dispose()
      sim.free()
    }
  })
}

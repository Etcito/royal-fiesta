import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { CharMode } from '@royal-fiesta/sim/character/constants'
import type { ObstacleSpec, ResolvedCourse } from '@royal-fiesta/sim/course'
import { neutralInput } from '@royal-fiesta/sim/input'
import type { CharacterView, MatchSim, MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { createMatchSim } from '@royal-fiesta/sim/match/matchSim'
import type { BodyRef, BodySpec, MechEvent, MechItem } from '@royal-fiesta/sim/mechanismSpec'
import { emptyMechanisms } from '@royal-fiesta/sim/mechanismSpec'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { Pose } from '@royal-fiesta/sim/vec'
import { pose, v3 } from '@royal-fiesta/sim/vec'
import type { AnimDriver } from '../src/anim/driver.ts'
import type { EngineSceneSim } from '../src/ege/sceneSim.ts'
import { fixtureResolver } from '../src/assets.ts'
import { matchCourses } from '../src/courseSet.ts'
import type { CourseEntry } from '../src/courseSet.ts'
import { classicNetSetup } from '../src/net/tuning.ts'
import type { PrimsAsset } from '../src/prims.ts'
import type { DomainSceneSim } from '../src/render/domainSceneSim.ts'
import { NullRenderPort } from '../src/render/nullPort.ts'
import type { QuatT, Vec3T } from '../src/render/port.ts'
import type { SceneReadView } from '../src/render/sceneReadView.ts'
import { SceneView } from '../src/render/sceneView.ts'
import { SeatSceneSim } from '../src/render/seatSceneSim.ts'

const ROOT = new URL('../../../', import.meta.url)
const read = async (rel: string) => readFileSync(new URL(rel, ROOT), 'utf8')
const resolver = fixtureResolver(read)
const R: RapierModule = await initRapier()

const entries: CourseEntry[] = []
for (const e of readdirSync(new URL('fixtures/courses/', ROOT), { withFileTypes: true })) {
  if (e.isFile() && e.name.endsWith('.course.json')) entries.push({ path: `fixtures/courses/${e.name}`, json: JSON.parse(await read(`fixtures/courses/${e.name}`)) })
}
entries.sort((a, b) => a.path.localeCompare(b.path))
const courses: ResolvedCourse[] = await matchCourses(entries, resolver, 'sprint')
const assets = new Map<string, PrimsAsset>()
for (const c of courses) for (const o of c.obstacles) if (!assets.has(o.asset)) assets.set(o.asset, (await resolver.resolve(o.asset)).asset)
const bean = (await resolver.resolve('bean')).asset
const node = JSON.parse(await read('assets/common/penguin.body.asset.json')).document.nodes.penguin
const skinned = {
  assetId: 'penguin', graph: await read('assets/common/penguin.animgraph.json'),
  skin: { rig: node.rig, clips: node.clips, parts: [{ name: 'p', skin: { joints: new Uint16Array(4), weights: new Float32Array([1, 0, 0, 0]) } }] },
}
const TICK = 1 / 60

// A read view over a MatchSim with no step method of its own. SceneView must present it through the
// read interface only; a seat outside this view's count refuses, the way every real adapter does.
class ReadView implements SceneReadView {
  readonly reads: number[] = []
  readonly sim: MatchSim
  private readonly seats: number
  constructor(sim: MatchSim, seats = sim.setup.playerCount) {
    this.sim = sim
    this.seats = seats
  }

  get tick(): number { return this.sim.tick }
  get setup(): { readonly playerCount: number } { return { playerCount: this.seats } }

  phase(out: MatchViewState): MatchViewState {
    return this.sim.phase(out)
  }

  character(player: number, out: CharacterView): CharacterView {
    if (!Number.isInteger(player) || player < 0 || player >= this.seats) {
      refuse('scene-read-view', `character(${player})`, `is outside 0..${this.seats - 1}; pass a seat of this read view`)
    }
    this.reads.push(player)
    return this.sim.character(player, out)
  }

  course(): ResolvedCourse | null {
    return this.sim.course()
  }

  obstacleCount(): number {
    return this.sim.obstacleCount()
  }

  obstacleSpec(index: number): ObstacleSpec {
    return this.sim.obstacleSpec(index)
  }

  obstaclePose(index: number, out: Pose): Pose {
    return this.sim.obstaclePose(index, out)
  }

  mechanismItemCount(): number {
    return this.sim.mechanismItemCount()
  }

  mechanismItem(index: number): MechItem {
    return this.sim.mechanismItem(index)
  }

  mechanismBodyPose(ref: BodyRef, out: Pose): boolean {
    return this.sim.mechanismBodyPose(ref, out)
  }

  mechanismEvents(fromTick: number, out: MechEvent[]): number {
    return this.sim.mechanismEvents(fromTick, out)
  }

  signal(id: string): boolean {
    return this.sim.signal(id)
  }
}

function characterOut(): CharacterView {
  return {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, status: 0, parked: false, teleportTick: 0,
    strokeTimer: 9, strokePhase: 0.5, strokeStart: 0.25, slideSpeed: 4, carry: 1, surface: 'ice', slideAir: true,
  }
}

async function readyPort(): Promise<NullRenderPort> {
  const port = new NullRenderPort()
  await port.init({ canvas: null, width: 640, height: 360, viewports: [{ x: 0, y: 0, width: 640, height: 360 }] })
  return port
}

function closeVector(actual: readonly number[], expected: readonly number[], tolerance = 1e-9): void {
  assert.equal(actual.length, expected.length)
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < tolerance, `${value} != ${expected[i]} at ${i}`))
}

function sceneOf(port: NullRenderPort, skinnedCharacter: typeof skinned | undefined, assetOf = (n: string) => assets.get(n)!): SceneView {
  return new SceneView({
    port, viewport: 0, localPlayer: 0, bean, assets: assetOf, loadingPaint: false,
    skinned: skinnedCharacter,
  })
}

test('a SceneReadView with no step method is presented and observed explicitly per tick', async () => {
  const sim = createMatchSim(R, classicNetSetup(5, 1, 'sprint', courses))
  const port = await readyPort()
  const read = new ReadView(sim)
  const scene = sceneOf(port, skinned)
  const inputs = Array.from({ length: sim.setup.playerCount }, () => neutralInput())
  try {
    sim.step(inputs)
    scene.update(read, null, 1, TICK)
    assert.equal('step' in read, false, 'the read view exposes no step method at all')
    assert.equal(scene.instanceCount, 8 + sim.obstacleCount())
    await scene.animationReady()
    const anim = (scene as unknown as { anim: AnimDriver }).anim
    assert.ok(anim, 'the graphs loaded')
    const seen: number[] = []
    const observe = anim.observeTick.bind(anim)
    anim.observeTick = (tick, characters) => { seen.push(tick); observe(tick, characters) }
    for (let i = 0; i < 3; i++) {
      sim.step(inputs)
      scene.observeTick(read)
    }
    assert.deepEqual(seen, [sim.tick - 2, sim.tick - 1, sim.tick], 'every explicitly observed tick reached the graphs in order')
    assert.equal(anim.observedTick, sim.tick)
    scene.observeTick(read)
    scene.observeTick(read)
    assert.deepEqual(seen, [sim.tick - 2, sim.tick - 1, sim.tick], 'a repeated observation of one tick never steps the graphs again')
  } finally {
    scene.dispose()
    sim.free()
  }
})

test('a read adapter with its own step method keeps it; only a MatchSim gets the legacy wrapper', async () => {
  class SteppedReadView extends ReadView {
    calls = 0
    step(): void { this.calls++ }
  }
  const sim = createMatchSim(R, classicNetSetup(5, 1, 'sprint', courses))
  const port = await readyPort()
  const read = new SteppedReadView(sim)
  const scene = sceneOf(port, skinned)
  const inputs = Array.from({ length: sim.setup.playerCount }, () => neutralInput())
  try {
    sim.step(inputs)
    scene.update(read, null, 1, TICK)
    await scene.animationReady()
    assert.equal(read.step, SteppedReadView.prototype.step, 'the adapter step is untouched')
    assert.equal(Object.hasOwn(read, 'step'), false, 'nothing replaced it with a wrapper')
    read.step()
    assert.equal(read.calls, 1)
  } finally {
    scene.dispose()
    sim.free()
  }

  // The compatibility path: a real MatchSim attaches its step observer automatically in update().
  const legacy = createMatchSim(R, classicNetSetup(5, 1, 'sprint', courses))
  const legacyPort = await readyPort()
  const legacyScene = sceneOf(legacyPort, skinned)
  try {
    legacy.step(inputs)
    legacyScene.update(legacy, null, 1, TICK)
    await legacyScene.animationReady()
    const anim = (legacyScene as unknown as { anim: AnimDriver }).anim
    assert.ok(anim)
    legacy.step(inputs)
    assert.equal(anim.observedTick, legacy.tick, 'a MatchSim step is observed without a draw')
    // Switching to a plain read view detaches the legacy wrapper: its step no longer reaches the graphs.
    const detached = new ReadView(legacy)
    legacyScene.update(detached, null, 1, TICK)
    await legacyScene.animationReady()
    const fresh = (legacyScene as unknown as { anim: AnimDriver }).anim
    assert.notEqual(fresh, anim, 'a view change starts a fresh driver')
    const at = fresh.observedTick
    legacy.step(inputs)
    assert.equal(fresh.observedTick, at, 'the old MatchSim is no longer observed')
    legacyScene.observeTick(detached)
    assert.equal(fresh.observedTick, legacy.tick, 'the new view is observed explicitly')
  } finally {
    legacyScene.dispose()
    legacy.free()
  }
})

test('a view change resets the character set and never reads a non-seat index', async () => {
  const sim = createMatchSim(R, classicNetSetup(5, 1, 'sprint', courses))
  const port = await readyPort()
  const full = new ReadView(sim)
  const two = new ReadView(sim, 2)
  const scene = sceneOf(port, skinned)
  const inputs = Array.from({ length: sim.setup.playerCount }, () => neutralInput())
  try {
    sim.step(inputs)
    scene.update(full, null, 1, TICK)
    await scene.animationReady()
    const before = (scene as unknown as { anim: AnimDriver }).anim
    assert.ok(before)
    two.reads.length = 0
    scene.update(two, null, 1, TICK)
    await scene.animationReady()
    const beans = (scene as unknown as { beans: number[] }).beans
    assert.equal(beans.length, 2, 'the two-seat view rebuilt the character set')
    assert.deepEqual([...new Set(two.reads)].sort((a, b) => a - b), [0, 1], 'only the view seats were read')
    assert.notEqual((scene as unknown as { anim: AnimDriver }).anim, before, 'the borrowed driver was replaced')
  } finally {
    scene.dispose()
    sim.free()
  }
  const out = characterOut()
  assert.throws(() => two.character(2, out), /\[scene-read-view\] character\(2\)/)
  const bad = new SceneView({ port, viewport: 0, localPlayer: 2, bean, assets: n => assets.get(n)!, loadingPaint: false })
  try {
    assert.throws(() => bad.update(two, null, 1, TICK), /\[scene\] SceneViewOptions.localPlayer/)
  } finally {
    bad.dispose()
  }
})

test('the engine round and domain adapters structurally supply the read interface', () => {
  // Compile-time conformance: a missing or renamed read method fails typecheck here.
  type EngineFits = EngineSceneSim extends SceneReadView ? true : false
  type DomainFits = DomainSceneSim extends SceneReadView ? true : false
  const engineFits: EngineFits = true
  const domainFits: DomainFits = true
  assert.equal(engineFits, true)
  assert.equal(domainFits, true)
})

test('a parked seat clears borrowed optional detail and an absent body leaves its output unchanged', () => {
  const course = courses[0]
  const adapter = new SeatSceneSim(course, 2)
  const read: SceneReadView = adapter
  assert.equal(read.tick, 0)
  const out = characterOut()
  const parked = read.character(0, out)
  assert.equal(parked.parked, true)
  assert.equal(parked.mode, CharMode.parked)
  assert.deepEqual(parked.pos, { x: 0, y: 0, z: 0 })
  for (const key of ['strokeTimer', 'strokePhase', 'strokeStart', 'slideSpeed', 'carry', 'surface', 'slideAir'] as const) {
    assert.equal(parked[key], undefined, `${key} is cleared on a missing seat`)
  }
  const missing = pose()
  const snapshot = pose()
  assert.equal(read.mechanismBodyPose({ item: 0, body: 0 }, missing), false)
  assert.deepEqual(missing, snapshot, 'an absent mechanism body never changes out')
})

// Inline courses keep the mechanism read independent of game content.
function mechanismCourses(): ResolvedCourse[] {
  const mechanisms = emptyMechanisms()
  const bodies: BodySpec[] = ['dynamic', 'fixed'].map((type, i) => ({
    id: `body-${i}`, type: type as BodySpec['type'], parts: [`part-${i}`],
    colliders: [{ shape: 'cuboid', half: v3(0.5, 0.5, 0.5), t: v3(0, 0, 0), r: pose().r }],
    rest: { t: v3(22 + i * 4, 12, 3), r: { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 } },
    density: 1, friction: 0.5, restitution: 0, linearDamping: 0, angularDamping: 0,
    gravityScale: 1, ccd: false, surface: 'normal',
  }))
  mechanisms.items.push({
    id: 'pair', asset: 'mechanism-pair', t: v3(20, 10, 3),
    r: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }, s: v3(2, 3, 4), bodies, joints: [],
  })
  const race: ResolvedCourse = {
    id: 'scene-read-mechanisms', name: 'Scene read mechanisms', kind: 'race', profiles: ['sprint'],
    timeLimitS: 1, killPlaneY: -1000, contentHash: 1,
    spawns: Array.from({ length: 8 }, (_, i) => ({ t: v3(i * 2, 1, 0), facing: { x: 0, z: 1 } })),
    checkpoints: [], finish: { center: v3(0, 0, 100), half: v3(10, 3, 1) },
    path: [{ p: v3(0, 0, 100), jump: false, dive: false }],
    regions: [], queuePad: null, obstacles: [], mechanisms,
  }
  return [race, { ...race, id: 'scene-read-plain', kind: 'survival', finish: null, mechanisms: undefined }]
}

class TransformPort extends NullRenderPort {
  readonly transforms = new Map<number, { t: number[]; r: number[] }>()
  override setTransform(instance: number, t: Vec3T, r: QuatT, s: Vec3T): void {
    super.setTransform(instance, t, r, s)
    this.transforms.set(instance, { t: [...t], r: [...r] })
  }
}

class NoBodiesView extends ReadView {
  readonly outs: Pose[] = []
  readonly snapshots: Pose[] = []
  override mechanismBodyPose(_ref: BodyRef, out: Pose): boolean {
    this.outs.push(out)
    this.snapshots.push({ t: { ...out.t }, r: { ...out.r } })
    return false
  }
}

test('an absent mechanism body returns false and draws the body at its rest pose', async () => {
  const sim = createMatchSim(R, classicNetSetup(5, 1, 'sprint', mechanismCourses()))
  const port = new TransformPort()
  await port.init({ canvas: null, width: 640, height: 360, viewports: [{ x: 0, y: 0, width: 640, height: 360 }] })
  const read = new NoBodiesView(sim)
  const scene = sceneOf(port, undefined, () => bean)
  const inputs = Array.from({ length: sim.setup.playerCount }, () => neutralInput())
  try {
    sim.step(inputs)
    scene.update(read, null, 1, TICK)
    assert.equal(scene.mechanismInstanceCount, 2)
    assert.ok(read.outs.length >= 2, 'both mechanism bodies asked the view')
    for (let i = 0; i < read.outs.length; i++) {
      assert.deepEqual(read.outs[i], read.snapshots[i], 'a false body pose leaves out unchanged')
    }
    const item = sim.mechanismItem(0)
    const drawn = [...port.transforms.values()]
    assert.ok(drawn.length >= 2, 'the two mechanism bodies were placed')
    // Bodies without a reported pose sit at the item placement, never at a stale or garbage pose.
    for (const transform of drawn.slice(0, 2)) {
      closeVector(transform.t, [item.t.x, item.t.y, item.t.z])
      closeVector(transform.r, [item.r.x, item.r.y, item.r.z, item.r.w])
    }
  } finally {
    scene.dispose()
    sim.free()
  }
})

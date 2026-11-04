// The belly breaststroke reaches the flippers of the saved penguin skin through every view the game draws its
// characters from. Owner 2026-11-04 ("on avait le mouvement de brasse pendant la glisse sur le ventre, on l'a
// perdu"): the start screen's Play runs show rounds, drawn through DomainSceneSim, which copied only the pose and
// the mode of each seat, so the stroke timer never reached the animation (nor the carry, slide airtime or surface).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { DomainSpec, ShadowView } from '@gamesaloon/rollback/zones'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { AnimDriver } from '@royal-fiesta/game/anim/driver'
import { characterObservation } from '@royal-fiesta/game/render/sceneView'
import { SeatSceneSim } from '@royal-fiesta/game/render/seatSceneSim'
import { CharMode, SLIDE_STROKE, strokeTotalTicks } from '@royal-fiesta/sim/character/constants'
import type { CharState } from '@royal-fiesta/sim/character/system'
import type { ObstacleSpec, ResolvedCourse } from '@royal-fiesta/sim/course'
import { neutralInput } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import type { CharacterView } from '@royal-fiesta/sim/match/matchSim'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { quatIdentity, v3 } from '@royal-fiesta/sim/vec'
import { cellOf } from '@royal-fiesta/sim/zones/cells'
import { FiestaDomain } from '@royal-fiesta/sim/zones/fiestaDomain'
import { createFiestaDomainFactory } from '@royal-fiesta/sim/zones/fiestaDomainFactory'
import { parseZonesFile, ZONES_FORMAT, ZONES_VERSION } from '@royal-fiesta/sim/zones/zonesFile'
import { decodeMeshBytes } from '../src/sdf/meshWire.ts'
import { DomainSceneSim } from '../src/zone/domainSceneSim.ts'

const R = await initRapier()
const asset = (name: string) => new URL(`../../../assets/common/${name}`, import.meta.url)
const document = JSON.parse(readFileSync(asset('penguin.body.asset.json'), 'utf8')).document
const owner = Object.values(document.nodes as Record<string, { rig?: { bones: { name: string }[] }; clips?: unknown[] }>).find(n => n.rig)!
const { bindings: _bindings, smooth: _smooth, ...rig } = owner.rig as Record<string, unknown> & { bones: { name: string }[] }
const graphJson = readFileSync(asset('penguin.animgraph.json'), 'utf8')
const bones = rig.bones.map(b => b.name)

// The saved skin: every vertex of the penguin part (its meshes in upload order) with its joints and weights.
const saved = (await decodeMeshBytes(new Uint8Array(readFileSync(asset('penguin.body.mesh'))))).data as {
  groups: { parts: { meshes: { positions: Float32Array }[]; skin?: { joints: Uint16Array; weights: Float32Array } }[] }[]
}
const part = saved.groups.flatMap(g => g.parts).find(p => p.skin !== undefined)!
const positions = Float32Array.from(part.meshes.flatMap(m => Array.from(m.positions)))
const { joints, weights } = part.skin!
// Vertices bound (weight >= 0.8) to one flipper's chain.
function flipper(side: 'l' | 'r'): number[] {
  const chain = new Set(['upper', 'lower', 'tip'].map(b => bones.indexOf(`${b}.${side}`)))
  const out: number[] = []
  for (let v = 0; v < positions.length / 3; v++) {
    let w = 0
    for (let k = 0; k < 4; k++) if (chain.has(joints[v * 4 + k])) w += weights[v * 4 + k]
    if (w >= 0.8) out.push(v)
  }
  return out
}
const FLIPPERS = { l: flipper('l'), r: flipper('r') }

function skinned(skin: Float32Array, v: number): [number, number, number] {
  const o: [number, number, number] = [0, 0, 0]
  const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2]
  for (let k = 0; k < 4; k++) {
    const j = joints[v * 4 + k], w = weights[v * 4 + k]
    if (w === 0) continue
    const m = skin.subarray(j * 16, j * 16 + 16)
    for (let r = 0; r < 3; r++) o[r] += w * (m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r])
  }
  return o
}

// `p` in the frame of the posed root bone (column-major affine `m`): the flipper sweep without the body's slide.
function inRoot(m: Float32Array, p: [number, number, number]): [number, number, number] {
  const c = [0, 4, 8].map(o => [m[o], m[o + 1], m[o + 2]])
  const d = [p[0] - m[12], p[1] - m[13], p[2] - m[14]]
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const det = dot(c[0], cross(c[1], c[2]))
  return [dot(d, cross(c[1], c[2])) / det, dot(d, cross(c[2], c[0])) / det, dot(d, cross(c[0], c[1])) / det]
}

const noShadows: ShadowView = { count: 0, fromDomain() { throw new Error('no link') }, reader() { throw new Error('no link') } }
const floor: ObstacleSpec = { id: 'floor', asset: 'floor', t: v3(0, -0.5, 30), r: quatIdentity(), s: v3(1, 1, 1), friction: 0.5,
  motion: { kind: 'static' }, colliders: [{ shape: 'cuboid', half: v3(15, 0.5, 40), t: v3(0, 0, 0), r: quatIdentity() }] }
const course: ResolvedCourse = {
  id: 'belly-stroke', name: 'belly-stroke', kind: 'race', profiles: ['sprint'], timeLimitS: 60, killPlaneY: -10, contentHash: 1,
  spawns: [{ t: v3(0, 0, 0), facing: { x: 0, z: 1 } }], checkpoints: [], finish: null, path: [], regions: [], queuePad: null,
  obstacles: [floor], features: [],
}
const zones = parseZonesFile({ format: ZONES_FORMAT, version: ZONES_VERSION, course: course.id,
  grid: { origin: [-20, -10], cell: [20, 80], cols: 2, rows: 1 }, parts: {}, tuning: {} }, 'inline.zones', course)

type Adapter = DomainSceneSim | SeatSceneSim
const view = (): CharacterView => ({ pos: v3(0, 0, 0), vel: v3(0, 0, 0), facing: { x: 0, z: 1 }, mode: 0, status: 0, parked: false, teleportTick: -1 })

/**
 * One seat runs, dives, lands on the belly and presses DIVE there: one breaststroke. The view goes through `adapter`
 * and SceneView's observation into the penguin's animation, as in the game. Returns per tick the skinned flipper
 * vertices of the saved penguin mesh in the root bone's frame, the mode, and the tick of the belly press.
 */
async function run(make: () => Adapter) {
  const factory = createFiestaDomainFactory(R, { course, zones, profile: { ...PROFILES.sprint, introTicks: 0 }, kind: 'race', seatCount: 1 })
  const spec: DomainSpec = { id: 1, kind: 'seat', seats: [0], cells: [cellOf(zones.grid, 0, 0)], replicas: [0, 1] }
  const domain = factory.create(spec, 0)
  assert.ok(domain instanceof FiestaDomain)
  const driver = await AnimDriver.load(graphJson, JSON.stringify(rig), owner.clips!.map(c => JSON.stringify(c)), { ik: false })
  const adapter = make(), out = view(), input: PlayerInput[] = [neutralInput()]
  const frames: [number, number, number][][] = [], modes: number[] = []
  let press = -1
  try {
    for (let tick = 0; tick < 200; tick++) {
      const state = domain.state(0)
      Object.assign(input[0], neutralInput())
      if (tick < 60) input[0].moveZ = 1
      if (tick === 60) input[0].dive = true
      if (press < 0 && tick > 60 && state.mode === CharMode.slide) {
        press = tick
        input[0].dive = true
      }
      domain.step(input, noShadows)
      adapter.refresh([domain], domain.tick)
      adapter.character(0, out)
      const st: CharState = domain.state(0)
      // The view carries the sim's stroke exactly as MatchSim.character does.
      assert.deepEqual([out.strokeTimer, out.strokePhase, out.strokeStart, out.slideSpeed, out.carry, out.slideAir, out.mode],
        [st.strokeTimer, st.strokePhase, st.strokeStart, st.slideSpeed, st.carry, st.slideAir, st.mode], `tick ${tick}`)
      assert.equal(out.surface, 'normal')
      driver.observeTick(domain.tick, [characterObservation(0, out)])
      const { skin, model } = driver.pose(0)!
      const root = model.subarray(bones.indexOf('root') * 16, bones.indexOf('root') * 16 + 16)
      frames.push([...FLIPPERS.l, ...FLIPPERS.r].map(v => inRoot(root, skinned(skin, v))))
      modes.push(st.mode)
    }
  } finally {
    driver.dispose()
    domain.inner.world.sim.free()
  }
  return { frames, modes, press }
}

test('the saved penguin skin binds both flippers to their bones', () => {
  assert.equal(joints.length, positions.length / 3 * 4, 'one skin record per saved vertex')
  for (const side of ['l', 'r'] as const) assert.ok(FLIPPERS[side].length >= 50, `${FLIPPERS[side].length} vertices on flipper.${side}`)
})

for (const [name, make] of [
  ['DomainSceneSim (show and zone rounds)', () => new DomainSceneSim(course, 1)],
  ['SeatSceneSim (split screen)', () => new SeatSceneSim(course, 1)],
] as const) {
  test(`${name}: a DIVE on the belly sweeps both flippers of the saved penguin skin`, async () => {
    const { frames, modes, press } = await run(make)
    assert.ok(press > 60, `landed on the belly at tick ${press}`)
    // The body lies on the belly through the whole stroke; the flippers sweep relative to it.
    const end = press + strokeTotalTicks(SLIDE_STROKE)
    for (let tick = press; tick < end; tick++) assert.equal(modes[tick], CharMode.slide, `on the belly at tick ${tick}`)
    const split = FLIPPERS.l.length
    let left = 0, right = 0
    for (let tick = press; tick < end; tick++) {
      frames[tick].forEach((p, i) => {
        const q = frames[press][i], d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
        if (i < split) left = Math.max(left, d)
        else right = Math.max(right, d)
      })
    }
    assert.ok(left > 0.5 && right > 0.5, `flipper sweep on the body: left ${left.toFixed(2)} m, right ${right.toFixed(2)} m`)
  })
}

test('DomainSceneSim: a seat without sim state never keeps the previous seat\'s stroke', () => {
  const adapter = new DomainSceneSim(course, 2), out = view()
  Object.assign(out, { strokeTimer: 20, strokePhase: 0.3, strokeStart: 0.5, slideSpeed: 4, carry: 1, slideAir: true, surface: 'ice' })
  adapter.character(1, out)
  assert.equal(out.parked, true)
  assert.deepEqual([out.strokeTimer, out.strokePhase, out.strokeStart, out.slideSpeed, out.carry, out.slideAir, out.surface],
    [undefined, undefined, undefined, undefined, undefined, undefined, undefined])
})

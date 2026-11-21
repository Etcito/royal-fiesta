import assert from 'node:assert/strict'
import test from 'node:test'
import type { WorldState } from '@etcito/game-engine/world-state'
import { CharMode, SLIDE_STROKE, strokeAnimPhase } from '@royal-fiesta/sim/character/constants'
import type { CharacterView, MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { Phase } from '@royal-fiesta/sim/match/matchSim'
import type { Pose } from '@royal-fiesta/sim/vec'
import type { CourseV1 } from '../src/courseV1.ts'
import type { CharObservation, RoundObservation } from '../src/ege/observe.ts'
import type { EngineRound } from '../src/ege/round.ts'
import { EngineSceneSim, focusCamera } from '../src/ege/sceneSim.ts'
import type { EmittedScene } from '../src/ege/sceneEmitter.ts'

function seat(index: number, mode: number, status: number): CharObservation {
  return {
    seat: index, entity: index, status, mode, grounded: true, groundObstacle: -1,
    knockbacks: 0, teleportTick: -1,
    pos: { x: index, y: index + 1, z: index + 2 },
    vel: { x: 0.5, y: 0.25, z: -0.5 },
    facing: { x: index + 0.5, z: index + 0.75 },
  } as unknown as CharObservation
}

function fakeRound(observation: RoundObservation, poses: Float32Array, state: WorldState, seen: number[]): EngineRound {
  return {
    observe: () => observation,
    poses(ids: readonly number[]) {
      seen.push(...ids)
      return poses
    },
    worldState: () => state,
  } as unknown as EngineRound
}

test('EngineSceneSim reads the mover, item-body and seat pose offsets in order', () => {
  const course = {
    id: 'ege-view-test',
    sim: {
      id: 'ege-view-test',
      obstacles: [{ id: 'spin-1' }],
      mechanisms: { items: [{ id: 'door', bodies: [{ id: 'leaf' }, { id: 'hinge' }] }] },
    },
  } as unknown as CourseV1
  const scene = {
    obstacleEntities: [100, 102],
    itemBodies: new Map([['door/leaf', 101], ['door/hinge', 103]]),
    seatEntities: [0, 1, 2, 3, 4, 5, 6, 7],
    index(name: string) { return name === 'switches/door-a' ? 500 : -1 },
  } as unknown as EmittedScene
  const seats = Array.from({ length: 8 }, (_, i) => seat(i, 0, 1))
  seats[7] = seat(7, CharMode.parked, 0)
  const observation = {
    tick: 42, phase: 'playing', alive: 7, qualified: 0, eliminated: 0,
    seats, faults: 0, events: {},
  } as RoundObservation
  const poses = new Float32Array(12 * 23)
  for (let k = 0; k < 12; k++) {
    poses.set([k, k + 1, k + 2], k * 23)
    poses.set([k + 3, k + 4, k + 5, k + 6], k * 23 + 3)
  }
  const state: WorldState = {
    tick: 42, entities: [500],
    components: { 'ege.mech.signal': { '500': { value: 1 } } }, resources: {},
  }
  const seen: number[] = []
  const sim = new EngineSceneSim(course, scene)
  sim.refresh(fakeRound(observation, poses, state, seen))

  assert.deepEqual(seen, [100, 102, 101, 103, 0, 1, 2, 3, 4, 5, 6, 7])
  assert.equal(sim.tick, 42)
  assert.equal(sim.obstacleCount(), 1)
  assert.equal(sim.obstacleSpec(0).id, 'spin-1')
  assert.equal(sim.mechanismItemCount(), 1)
  assert.equal(sim.mechanismItem(0).id, 'door')
  assert.throws(() => sim.mechanismItem(4), /no mechanism item 4/)

  const pose = { t: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0, w: 1 } } as Pose
  assert.equal(sim.obstaclePose(0, pose), pose)
  assert.deepEqual(pose.t, { x: 0, y: 1, z: 2 })
  assert.deepEqual(pose.r, { x: 3, y: 4, z: 5, w: 6 })
  assert.equal(sim.mechanismBodyPose({ item: 0, body: 1 }, pose), true)
  assert.deepEqual(pose.t, { x: 3, y: 4, z: 5 })
  assert.deepEqual(pose.r, { x: 6, y: 7, z: 8, w: 9 })
  assert.equal(sim.mechanismBodyPose({ item: 0, body: 9 }, pose), false)
  assert.equal(sim.mechanismBodyPose({ item: 3, body: 0 }, pose), false)
})

test('EngineSceneSim copies a character from its observation and seat pose', () => {
  const course = { id: 'ege-view-test', sim: { id: 'ege-view-test', obstacles: [], mechanisms: null } } as unknown as CourseV1
  const scene = {
    obstacleEntities: [], itemBodies: new Map<string, number>(),
    seatEntities: [0, 1, 2, 3, 4, 5, 6, 7], index() { return -1 },
  } as unknown as EmittedScene
  const seats = Array.from({ length: 8 }, (_, i) => seat(i, 0, 1))
  seats[3] = seat(3, CharMode.air, 2)
  seats[6] = seat(6, CharMode.parked, 0)
  const observation = {
    tick: 9, phase: 'playing', alive: 6, qualified: 1, eliminated: 0,
    seats, faults: 0, events: {},
  } as RoundObservation
  const poses = new Float32Array(8 * 23)
  for (let k = 0; k < 8; k++) poses.set([k * 2, k * 3, k * 5], k * 23)
  const state: WorldState = { tick: 9, entities: [], components: {}, resources: {} }
  const sim = new EngineSceneSim(course, scene)
  sim.refresh(fakeRound(observation, poses, state, []))

  const view: CharacterView = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, status: 0, parked: false, teleportTick: -1,
  }
  sim.character(3, view)
  assert.deepEqual(view.pos, { x: 6, y: 9, z: 15 })
  assert.deepEqual(view.vel, { x: 0.5, y: 0.25, z: -0.5 })
  assert.deepEqual(view.facing, { x: 3.5, z: 3.75 })
  assert.equal(view.mode, CharMode.air)
  assert.equal(view.status, 2)
  assert.equal(view.parked, false)
  assert.equal(view.teleportTick, -1)
  assert.equal(view.surface, undefined)
  assert.equal(view.carry, undefined)
  assert.equal(view.strokeTimer, undefined)

  view.strokeTimer = 5
  view.strokePhase = 0.5
  view.strokeStart = 0.5
  view.slideSpeed = 2
  view.carry = 1
  view.surface = 'ice'
  view.slideAir = true
  sim.character(6, view)
  assert.equal(view.mode, CharMode.parked)
  assert.equal(view.parked, true)
  assert.deepEqual(view.pos, { x: 12, y: 18, z: 30 })
  // A parked seat keeps no earlier seat's animation detail.
  for (const key of ['strokeTimer', 'strokePhase', 'strokeStart', 'slideSpeed', 'carry', 'surface', 'slideAir'] as const) {
    assert.equal(view[key], undefined, `${key} is cleared on a parked seat`)
  }
  assert.throws(() => sim.character(8, view), /\[ege-view\] character\(8\)/)

  const state2 = sim.phase({} as MatchViewState)
  assert.equal(state2.tick, 9)
  assert.equal(state2.phase, Phase.playing)
  assert.equal(state2.courseIndex, 0)
})

test('EngineSceneSim reads stroke, slide, carry and surface detail from engine state', () => {
  const course = {
    id: 'ege-view-detail',
    sim: {
      id: 'ege-view-detail',
      obstacles: [{ id: 'ice-pad' }],
      mechanisms: { items: [{ id: 'door', bodies: [{ id: 'leaf' }] }] },
    },
  } as unknown as CourseV1
  const scene = {
    obstacleEntities: [700],
    itemBodies: new Map([['door/leaf', 701]]),
    seatEntities: [0, 1, 2, 3, 4, 5, 6, 7],
    index() { return -1 },
  } as unknown as EmittedScene
  const seats = Array.from({ length: 8 }, (_, i) => seat(i, 0, 1))
  const observation = {
    tick: 5, phase: 'playing', alive: 8, qualified: 0, eliminated: 0,
    seats, faults: 0, events: {},
  } as RoundObservation
  const poses = new Float32Array(8 * 23)
  const state: WorldState = {
    tick: 5, entities: [700, 701], resources: {},
    components: {
      character: {
        '0': { mode: CharMode.air, timer: -1, slide_speed: 4.5, carry: 2, stroke_timer: 12, ground_item: -1, ground_body: -1, ground_obstacle: -1 },
        '1': { mode: CharMode.ground, timer: 0, slide_speed: 0, carry: 0, stroke_timer: 0, ground_item: 0, ground_body: 0, ground_obstacle: -1 },
        '2': { mode: CharMode.swim, timer: 0, slide_speed: 0, carry: 0, stroke_timer: 7, ground_item: -1, ground_body: -1, ground_obstacle: 0 },
      },
      surface: {
        '700': { kind: 1, friction: 0.1, obstacle: 0 },
        '701': { kind: 3, friction: 0.9, obstacle: -1 },
      },
    },
  }
  const sim = new EngineSceneSim(course, scene)
  sim.refresh(fakeRound(observation, poses, state, []))
  const view = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, status: 0, parked: false, teleportTick: -1,
  } as CharacterView

  // A slide in air: the timer, derived phase, authored start and airtime all reach the view.
  sim.character(0, view)
  assert.equal(view.strokeTimer, 12)
  assert.equal(view.strokePhase, strokeAnimPhase(SLIDE_STROKE, 12))
  assert.equal(view.strokeStart, SLIDE_STROKE.startFrac)
  assert.equal(view.slideSpeed, 4.5)
  assert.equal(view.carry, 2)
  assert.equal(view.slideAir, true)
  assert.equal(view.surface, 'normal')

  // A ground that is a mechanism body reports that body's surface.
  sim.character(1, view)
  assert.equal(view.surface, 'rubber')

  // A ground that is a course obstacle reports the obstacle's surface; swimming has no stroke phase.
  sim.character(2, view)
  assert.equal(view.surface, 'ice')
  assert.equal(view.strokeTimer, 7)
  assert.equal(view.strokePhase, undefined)
  assert.equal(view.slideAir, false)

  // A seat without a character record keeps no optional detail.
  sim.character(3, view)
  for (const key of ['strokeTimer', 'strokePhase', 'strokeStart', 'slideSpeed', 'carry', 'surface', 'slideAir'] as const) {
    assert.equal(view[key], undefined, `${key} stays clear without a character record`)
  }
})

test('focusCamera frames a feature from behind and above', () => {
  const camera = focusCamera({ x: 1, y: 2, z: 3 })
  assert.deepEqual(camera.eye, [1, 11, -11])
  assert.deepEqual(camera.target, [1, 3, 3])
  assert.equal(camera.fovYDeg, 60)
  assert.equal(camera.near, 0.1)
  assert.equal(camera.far, 500)
})
